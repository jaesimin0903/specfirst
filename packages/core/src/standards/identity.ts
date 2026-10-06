import { concat, getAddress, keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { isNodeError, isRateLimited, isTransportFailure } from '../chain/transport.js';

/** EIP-1967 implementation slot: bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1). */
export const EIP1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** EIP-1967 beacon slot: bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1). */
export const EIP1967_BEACON_SLOT: Hex = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
/**
 * Only code below this size (before the CBOR tail) that contains a DELEGATECALL is treated as a proxy.
 * 4 KB takes in OpenZeppelin's ERC1967Proxy, BeaconProxy and TransparentUpgradeableProxy (Upshift's on
 * Monad is 2,001 bytes) and stays below a minimal ERC-4626 vault. EIP-1967 slots of anything larger are
 * ignored: a full contract can write any address into its own slot and must not borrow another contract's
 * identity that way. The implementation only counts when its address holds code. Recognised slots give
 * eip1967 or eip1967-beacon; none gives kind 'unknown'.
 */
export const PROXY_MAX_CODE_SIZE = 4096;

const beaconAbi = [
  { type: 'function', name: 'implementation', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

/** EIP-1167 minimal proxy runtime code: 363d3d373d3d3d363d73 <20-byte target> 5af43d82803e903d91602b57fd5bf3. */
const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const DELEGATECALL = 0xf4;
const PUSH1 = 0x60;
const PUSH32 = 0x7f;

export type ProxyKind = 'eip1967' | 'eip1967-beacon' | 'eip1167';

export interface CodeFingerprint {
  /** keccak256 of the runtime code. Differs between deployments of one codebase whose immutables differ. */
  codeHash: Hex;
  /**
   * The ipfs (or bzzr1, bzzr0) value of the Solidity CBOR metadata at the end of the runtime code. Same
   * source and compiler settings give the same value whatever the constructor arguments. Null when the
   * contract was compiled without it (bytecode_hash = none) or the tail does not parse.
   */
  metadataHash: Hex | null;
  /**
   * keccak256 of the runtime code without its CBOR tail and with every PUSH32 immediate zeroed. solc
   * places immutables as PUSH32 immediates, so deployments that differ only in immutables share it.
   * Null for empty code.
   */
  maskedCodeHash: Hex | null;
}

export interface ImplementationKeyKind {
  /** implementation when a proxy's implementation code was found, self otherwise. Never mixed. */
  of: 'implementation' | 'self';
  /**
   * metadataHash+maskedCodeHash: keccak256(metadataHash || maskedCodeHash). The CBOR tail is declared by
   * the contract itself and can be copied, so it never keys alone; the masked code must match too.
   */
  hash: 'metadataHash+maskedCodeHash' | 'maskedCodeHash' | 'codeHash';
}

export interface ImplementationIdentity extends CodeFingerprint {
  codeSize: number;
  /**
   * kind 'unknown': proxy-shaped code (small, with a DELEGATECALL) whose implementation could not be
   * resolved: no EIP-1967 slot, or a beacon whose implementation() reverted or returned zero.
   */
  proxy: { kind: ProxyKind; implementation: Address; beacon?: Address } | { kind: 'unknown' } | null;
  implementation: (CodeFingerprint & { address: Address }) | null;
  /**
   * From the implementation's fingerprint when its code was found, else from the contract's own:
   * keccak256(metadataHash || maskedCodeHash) when there is metadata, else maskedCodeHash, else codeHash.
   * Checks with the same key ran the same code, so N vaults of one factory count as one, not N.
   */
  implementationKey: Hex;
  implementationKeyKind: ImplementationKeyKind;
}

/** The slice of a viem public client identification reads; tests pass a mock. */
export type IdentityClient = Pick<PublicClient, 'getCode' | 'getStorageAt' | 'readContract'>;

function hexBytes(code: Hex): Uint8Array {
  const s = code.slice(2);
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

type CborValue = number | boolean | null | string | Uint8Array | Map<string, CborValue>;

/** Just enough CBOR for Solidity metadata: unsigned ints, byte and text strings, maps, true/false/null. */
function readCbor(b: Uint8Array, pos: number): { value: CborValue; pos: number } {
  if (pos >= b.length) throw new Error('cbor: out of bounds');
  const major = b[pos]! >> 5;
  const info = b[pos]! & 0x1f;
  pos++;
  let arg: number;
  if (info < 24) arg = info;
  else if (info === 24) arg = b[pos++]!;
  else if (info === 25) {
    arg = (b[pos]! << 8) | b[pos + 1]!;
    pos += 2;
  } else if (major === 7) arg = info;
  else throw new Error('cbor: unsupported length');
  switch (major) {
    case 0:
      return { value: arg, pos };
    case 2:
    case 3: {
      if (pos + arg > b.length) throw new Error('cbor: out of bounds');
      const bytes = b.slice(pos, pos + arg);
      return { value: major === 2 ? bytes : new TextDecoder().decode(bytes), pos: pos + arg };
    }
    case 5: {
      const map = new Map<string, CborValue>();
      for (let i = 0; i < arg; i++) {
        const k = readCbor(b, pos);
        if (typeof k.value !== 'string') throw new Error('cbor: non-text key');
        const v = readCbor(b, k.pos);
        map.set(k.value, v.value);
        pos = v.pos;
      }
      return { value: map, pos };
    }
    case 7:
      if (arg === 20 || arg === 21) return { value: arg === 21, pos };
      if (arg === 22) return { value: null, pos };
      throw new Error('cbor: unsupported simple value');
    default:
      throw new Error(`cbor: unsupported major type ${major}`);
  }
}

/**
 * Solidity appends `<CBOR map><2-byte big-endian length>` to runtime code. Returns the decoded map and
 * where it starts, or null when the tail is not such a map.
 */
export function solidityMetadata(code: Uint8Array): { map: Map<string, CborValue>; start: number } | null {
  if (code.length < 2) return null;
  const len = (code[code.length - 2]! << 8) | code[code.length - 1]!;
  const start = code.length - 2 - len;
  if (len === 0 || start < 0) return null;
  try {
    const { value, pos } = readCbor(code, start);
    if (!(value instanceof Map) || pos !== code.length - 2) return null;
    return { map: value, start };
  } catch {
    return null;
  }
}

/** Visits every opcode in code[0, end), skipping PUSH immediates. */
function walkOpcodes(code: Uint8Array, end: number, visit: (op: number, at: number) => void): void {
  for (let i = 0; i < end; ) {
    const op = code[i]!;
    visit(op, i);
    i += op >= PUSH1 && op <= PUSH32 ? 1 + (op - PUSH1 + 1) : 1;
  }
}

/** Fingerprint of runtime code, plus what the unknown-proxy heuristic needs. */
export function analyzeCode(code: Hex): { fingerprint: CodeFingerprint; hasDelegatecall: boolean; logicSize: number } {
  const bytes = hexBytes(code);
  const meta = solidityMetadata(bytes);
  const end = meta ? meta.start : bytes.length;
  const raw = meta?.map.get('ipfs') ?? meta?.map.get('bzzr1') ?? meta?.map.get('bzzr0');
  const masked = bytes.slice(0, end);
  let hasDelegatecall = false;
  walkOpcodes(masked, end, (op, at) => {
    if (op === DELEGATECALL) hasDelegatecall = true;
    if (op === PUSH32) masked.fill(0, at + 1, Math.min(at + 33, end));
  });
  return {
    fingerprint: {
      codeHash: keccak256(code),
      metadataHash: raw instanceof Uint8Array && raw.length > 0 ? toHex(raw) : null,
      maskedCodeHash: bytes.length > 0 ? keccak256(masked) : null,
    },
    hasDelegatecall,
    logicSize: end,
  };
}

function slotAddress(word: Hex | undefined): Address | null {
  if (!word || /^0x0*$/.test(word)) return null;
  const hex = word.slice(2).padStart(64, '0');
  const addr = `0x${hex.slice(24)}`;
  return /^0x0{40}$/.test(addr) ? null : getAddress(addr);
}

/** Key of one fingerprint: metadata bound to the masked code, else the masked code, else the raw code. */
export function fingerprintKey(fp: CodeFingerprint): { key: Hex; hash: ImplementationKeyKind['hash'] } {
  if (fp.metadataHash && fp.maskedCodeHash) return { key: keccak256(concat([fp.metadataHash, fp.maskedCodeHash])), hash: 'metadataHash+maskedCodeHash' };
  if (fp.maskedCodeHash) return { key: fp.maskedCodeHash, hash: 'maskedCodeHash' };
  return { key: fp.codeHash, hash: 'codeHash' };
}

function pickKey(self: CodeFingerprint, impl: CodeFingerprint | null): { key: Hex; kind: ImplementationKeyKind } {
  const of: ImplementationKeyKind['of'] = impl ? 'implementation' : 'self';
  const { key, hash } = fingerprintKey(impl ?? self);
  return { key, kind: { of, hash } };
}

/**
 * Identifies the code behind `address` at `blockNumber`: fingerprints of its runtime code and, for an
 * EIP-1167 clone or a proxy-shaped contract with an EIP-1967 implementation or beacon slot, of the
 * implementation's code. Other proxy-shaped code is flagged (kind 'unknown') and keyed by its own code.
 */
export async function identifyImplementation(client: IdentityClient, address: Address, blockNumber: bigint): Promise<ImplementationIdentity> {
  const code = (await client.getCode({ address, blockNumber })) ?? '0x';
  const { fingerprint: self, hasDelegatecall, logicSize } = analyzeCode(code);
  const codeSize = (code.length - 2) / 2;

  let proxy: ImplementationIdentity['proxy'] = null;
  const clone = EIP1167.exec(code);
  if (clone) {
    proxy = { kind: 'eip1167', implementation: getAddress(`0x${clone[1]}`) };
  } else if (hasDelegatecall && logicSize < PROXY_MAX_CODE_SIZE) {
    const impl = slotAddress(await client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber }));
    if (impl) {
      proxy = { kind: 'eip1967', implementation: impl };
    } else {
      const beacon = slotAddress(await client.getStorageAt({ address, slot: EIP1967_BEACON_SLOT, blockNumber }));
      // A beacon that does not answer implementation() makes the proxy 'unknown'; an RPC failure, a rate
      // limit or a node error is thrown instead, so a busy RPC never turns into another implementation key.
      const implementation = beacon
        ? await client
            .readContract({ address: beacon, abi: beaconAbi, functionName: 'implementation', blockNumber })
            .then((a) => slotAddress(`0x${(a as string).slice(2).padStart(64, '0')}`))
            .catch((err: unknown) => {
              if (isTransportFailure(err) || isRateLimited(err) || isNodeError(err)) throw err;
              return null;
            })
        : null;
      proxy = beacon && implementation ? { kind: 'eip1967-beacon', implementation, beacon } : { kind: 'unknown' };
    }
  }

  let implementation: ImplementationIdentity['implementation'] = null;
  if (proxy && proxy.kind !== 'unknown') {
    const implCode = (await client.getCode({ address: proxy.implementation, blockNumber })) ?? '0x';
    if (implCode !== '0x') {
      implementation = { address: proxy.implementation, ...analyzeCode(implCode).fingerprint };
    }
  }
  const { key, kind } = pickKey(self, implementation);
  return { ...self, codeSize, proxy, implementation, implementationKey: key, implementationKeyKind: kind };
}
