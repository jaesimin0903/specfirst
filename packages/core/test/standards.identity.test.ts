import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { concat, keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  analyzeCode,
  EIP1967_BEACON_SLOT,
  EIP1967_IMPLEMENTATION_SLOT,
  fingerprintKey,
  identifyImplementation,
  implementationIdentitySchema,
  solidityMetadata,
  type IdentityClient,
} from '../src/index.js';

const BLOCK = 109061472n;
const VAULT = '0x802c91d807A8DaCA257c4708ab264B6520964e44' as Address;
const IMPL = '0xef17750D3a162E28a302E266c474ff8989d60ECD' as Address;
const BEACON = '0xba4Dd672062dE8FeeDb665DD4410658864483f1E' as Address;

/** Euler EVK proxy on Monad mainnet (0x4735E245271496aEDEFF224b7dcB06fA7715cfB7): immutable beacon, DELEGATECALL, ipfs metadata. */
const EULER_PROXY: Hex =
  '0x60806040527f5c60da1b000000000000000000000000000000000000000000000000000000005f9081527f000000000000000000000000ba4dd672062de8feedb665dd4410658864483f1e907f0000000000000000000000000000000000000000000000000000000000000040907f00000000754704bc059f8c67012fed69bc8a327a5aafb6030000000000000000907f0000000000000000000000000000000000000000000000000000000000000000907f0000000000000000000000000000000000000000000000000000000000000000907f000000000000000000000000000000000000000000000000000000000000000090602090600481895afa5f51365f80378536528436602001528336604001528236606001525f803689015f845af49150503d5f803e808015610134573d5ff35b3d5ffdfea26469706673582212202ee0d2bf182da15178bf86df063452eb4b7dcdc1b5f62defb4c97b8e04b95b6664736f6c63430008180033';
const EULER_IPFS = '0x12202ee0d2bf182da15178bf86df063452eb4b7dcdc1b5f62defb4c97b8e04b95b66';

/** MetaMorpho-style tail: CBOR map with only "solc" (compiled with bytecode_hash = none). */
const SOLC_ONLY_TAIL = 'a164736f6c634300081a000a';
/** PUSH32 <immutable> PUSH1 0 SSTORE, then the tail. Two deployments differ only in the immutable. */
const withImmutable = (word: string, push1 = '00'): Hex => `0x7f${word.padStart(64, '0')}60${push1}55${SOLC_ONLY_TAIL}`;
/** Contract with ipfs metadata and no DELEGATECALL. */
const IPFS_TAIL = `a2646970667358221220${'11'.repeat(32)}64736f6c63430008180033`;
const PLAIN: Hex = `0x6080604052${IPFS_TAIL}`;
const PLAIN_IMPL: Hex = `0x60806040526001${IPFS_TAIL.replace('11'.repeat(32), '22'.repeat(32))}`;
/** Two unrelated implementations without metadata (bytecode_hash = none). */
const IMPL_A: Hex = `0x6080604052600160005560026001550000${SOLC_ONLY_TAIL}`;
const IMPL_B: Hex = `0x60806040527fdeadbeef00000000000000000000000000000000000000000000000000000000ff${SOLC_ONLY_TAIL}`;
/** A large contract (over 4 KB of logic) with a DELEGATECALL: never treated as a proxy. */
const BIG_WITH_DELEGATECALL: Hex = `0x${'5b'.repeat(4200)}f4${IPFS_TAIL}`;
/**
 * Runtime code of the OpenZeppelin TransparentUpgradeableProxy in front of Upshift earnAUSD
 * (0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E, Monad block 109061472), 2,001 bytes, read from forge's local
 * fork cache. keccak256 = 0xa60c40de9979a21d4ec81b613b9da678727c39ef441c3227d78330cf649233b0.
 */
const UPSHIFT_PROXY = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/standards/upshift-proxy-143-109061472.hex'), 'utf8').trim() as Hex;
const UPSHIFT_IMPL = '0xfd2f793c248dd673c830df610a95a045054de267' as Address;
const keyOf = (code: Hex) => fingerprintKey(analyzeCode(code).fingerprint).key;

const word = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex;

function mockClient(o: { code: Record<string, Hex>; slots?: Record<string, Hex>; beaconImpl?: Address }): IdentityClient {
  return {
    getCode: vi.fn(async ({ address }: { address: Address }) => o.code[address.toLowerCase()] ?? undefined),
    getStorageAt: vi.fn(async ({ slot }: { slot: Hex }) => o.slots?.[slot] ?? `0x${'0'.repeat(64)}`),
    readContract: vi.fn(async () => o.beaconImpl),
  } as unknown as IdentityClient;
}
const lc = (a: Address) => a.toLowerCase();

describe('solidityMetadata and analyzeCode', () => {
  it('reads the ipfs value from the CBOR tail of a real runtime code', () => {
    const meta = solidityMetadata(Buffer.from(EULER_PROXY.slice(2), 'hex'))!;
    expect([...meta.map.keys()]).toEqual(['ipfs', 'solc']);
    expect(analyzeCode(EULER_PROXY).fingerprint.metadataHash).toBe(EULER_IPFS);
  });

  it('a solc-only tail has no metadataHash; deployments differing only in PUSH32 immutables share maskedCodeHash', () => {
    const a = analyzeCode(withImmutable('aa'));
    const b = analyzeCode(withImmutable('bb'));
    expect(a.fingerprint.metadataHash).toBeNull();
    expect(a.fingerprint.codeHash).not.toBe(b.fingerprint.codeHash);
    expect(a.fingerprint.maskedCodeHash).toBe(b.fingerprint.maskedCodeHash);
    // a change outside PUSH32 immediates is a different code
    expect(analyzeCode(withImmutable('aa', '01')).fingerprint.maskedCodeHash).not.toBe(a.fingerprint.maskedCodeHash);
  });

  it('a tail that is not CBOR gives no metadata and masks the whole code', () => {
    const code: Hex = '0x60016002ffff';
    expect(solidityMetadata(Buffer.from(code.slice(2), 'hex'))).toBeNull();
    expect(analyzeCode(code).fingerprint).toMatchObject({ metadataHash: null, codeHash: keccak256(code) });
  });

  it('flags DELEGATECALL only as an opcode, not inside PUSH data', () => {
    expect(analyzeCode(EULER_PROXY).hasDelegatecall).toBe(true);
    expect(analyzeCode('0x61f4f400').hasDelegatecall).toBe(false);
  });
});

describe('identifyImplementation', () => {
  it('non-proxy with ipfs metadata: keyed by keccak(metadataHash || maskedCodeHash), never metadata alone', async () => {
    const id = await identifyImplementation(mockClient({ code: { [lc(VAULT)]: PLAIN } }), VAULT, BLOCK);
    expect(id.proxy).toBeNull();
    expect(id.implementation).toBeNull();
    expect(id.implementationKeyKind).toEqual({ of: 'self', hash: 'metadataHash+maskedCodeHash' });
    expect(id.implementationKey).toBe(keccak256(concat([`0x1220${'11'.repeat(32)}`, id.maskedCodeHash!])));
    expect(id.implementationKey).not.toBe(id.metadataHash);
    expect(id.codeSize).toBe((PLAIN.length - 2) / 2);
    expect(implementationIdentitySchema.parse(id)).toEqual(id);
  });

  it('two factory vaults without metadata collapse onto one maskedCodeHash key', async () => {
    const a = await identifyImplementation(mockClient({ code: { [lc(VAULT)]: withImmutable('aa') } }), VAULT, BLOCK);
    const b = await identifyImplementation(mockClient({ code: { [lc(VAULT)]: withImmutable('bb') } }), VAULT, BLOCK);
    expect(a.codeHash).not.toBe(b.codeHash);
    expect(a.implementationKey).toBe(b.implementationKey);
    expect(a.implementationKeyKind).toEqual({ of: 'self', hash: 'maskedCodeHash' });
  });

  it('a copied CBOR tail on different code does not share the key', () => {
    const spoof: Hex = `0x60006000fd${IPFS_TAIL}`;
    expect(analyzeCode(spoof).fingerprint.metadataHash).toBe(analyzeCode(PLAIN).fingerprint.metadataHash);
    expect(keyOf(spoof)).not.toBe(keyOf(PLAIN));
  });

  it('EIP-1967 proxies of one build over different implementations get different keys (implementation only)', async () => {
    const mk = (impl: Address, code: Hex) =>
      mockClient({ code: { [lc(VAULT)]: EULER_PROXY, [lc(impl)]: code }, slots: { [EIP1967_IMPLEMENTATION_SLOT]: word(impl) } });
    const A = '0x2222222222222222222222222222222222222222' as Address;
    const B = '0x3333333333333333333333333333333333333333' as Address;
    const a = await identifyImplementation(mk(A, IMPL_A), VAULT, BLOCK);
    const b = await identifyImplementation(mk(B, IMPL_B), VAULT, BLOCK);
    expect(a.metadataHash).toBe(b.metadataHash);
    expect(a.implementationKeyKind).toEqual({ of: 'implementation', hash: 'maskedCodeHash' });
    expect(a.implementationKey).toBe(a.implementation!.maskedCodeHash);
    expect(a.implementationKey).not.toBe(b.implementationKey);
  });

  it('a 2,001-byte OpenZeppelin TransparentUpgradeableProxy (Upshift earnAUSD) is an EIP-1967 proxy keyed by its implementation', async () => {
    expect(keccak256(UPSHIFT_PROXY)).toBe('0xa60c40de9979a21d4ec81b613b9da678727c39ef441c3227d78330cf649233b0');
    expect((UPSHIFT_PROXY.length - 2) / 2).toBe(2001);
    const id = await identifyImplementation(
      mockClient({ code: { [lc(VAULT)]: UPSHIFT_PROXY, [UPSHIFT_IMPL]: PLAIN_IMPL }, slots: { [EIP1967_IMPLEMENTATION_SLOT]: word(UPSHIFT_IMPL) } }),
      VAULT,
      BLOCK,
    );
    expect(id.proxy).toEqual({ kind: 'eip1967', implementation: '0xFd2F793C248Dd673C830DF610a95a045054de267' });
    expect(id.implementationKeyKind.of).toBe('implementation');
    expect(id.implementationKey).toBe(keyOf(PLAIN_IMPL));
  });

  it('two vaults behind the same OpenZeppelin proxy build but different implementations are not merged', async () => {
    const other = '0x4444444444444444444444444444444444444444' as Address;
    const mk = (impl: Address, code: Hex) =>
      mockClient({ code: { [lc(VAULT)]: UPSHIFT_PROXY, [lc(impl)]: code }, slots: { [EIP1967_IMPLEMENTATION_SLOT]: word(impl) } });
    const a = await identifyImplementation(mk(UPSHIFT_IMPL, IMPL_A), VAULT, BLOCK);
    const b = await identifyImplementation(mk(other, IMPL_B), VAULT, BLOCK);
    expect(a.codeHash).toBe(b.codeHash);
    expect(a.implementationKey).not.toBe(b.implementationKey);
  });

  it('EIP-1967 slots on code that is not proxy-shaped are ignored (no borrowed identity)', async () => {
    for (const code of [PLAIN, BIG_WITH_DELEGATECALL]) {
      const client = mockClient({ code: { [lc(VAULT)]: code, [lc(IMPL)]: PLAIN_IMPL }, slots: { [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL) } });
      const id = await identifyImplementation(client, VAULT, BLOCK);
      expect(id.proxy).toBeNull();
      expect(id.implementationKeyKind.of).toBe('self');
      expect(client.getStorageAt).not.toHaveBeenCalled();
    }
  });

  it('beacon whose implementation() reverts or returns zero: proxy of unknown kind, the check goes on', async () => {
    for (const readContract of [
      vi.fn(async () => {
        throw new Error('execution reverted');
      }),
      vi.fn(async () => '0x0000000000000000000000000000000000000000'),
    ]) {
      const client = { ...mockClient({ code: { [lc(VAULT)]: EULER_PROXY }, slots: { [EIP1967_BEACON_SLOT]: word(BEACON) } }), readContract } as unknown as IdentityClient;
      const id = await identifyImplementation(client, VAULT, BLOCK);
      expect(id.proxy).toEqual({ kind: 'unknown' });
      expect(id.implementationKeyKind).toEqual({ of: 'self', hash: 'metadataHash+maskedCodeHash' });
    }
  });

  it('beacon read that fails on the RPC (HTTP error, 429, node error): thrown, never an unknown proxy', async () => {
    for (const err of [
      Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 502 }),
      Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 429 }),
      Object.assign(new Error('An internal error was received.'), { name: 'ContractFunctionExecutionError', cause: { name: 'InternalRpcError', code: -32603, message: 'missing trie node' } }),
    ]) {
      const readContract = vi.fn(async () => {
        throw err;
      });
      const client = { ...mockClient({ code: { [lc(VAULT)]: EULER_PROXY }, slots: { [EIP1967_BEACON_SLOT]: word(BEACON) } }), readContract } as unknown as IdentityClient;
      await expect(identifyImplementation(client, VAULT, BLOCK)).rejects.toBe(err);
    }
  });

  it('EIP-1967 proxy: follows the implementation slot and keys by the implementation metadataHash', async () => {
    const client = mockClient({
      code: { [lc(VAULT)]: EULER_PROXY, [lc(IMPL)]: PLAIN_IMPL },
      slots: { [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL) },
    });
    const id = await identifyImplementation(client, VAULT, BLOCK);
    expect(id.proxy).toEqual({ kind: 'eip1967', implementation: IMPL });
    expect(id.implementation).toMatchObject({ address: IMPL, codeHash: keccak256(PLAIN_IMPL), metadataHash: `0x1220${'22'.repeat(32)}` });
    expect(id.implementationKeyKind).toEqual({ of: 'implementation', hash: 'metadataHash+maskedCodeHash' });
    expect(id.implementationKey).toBe(keyOf(PLAIN_IMPL));
    expect(client.getCode).toHaveBeenCalledWith({ address: IMPL, blockNumber: BLOCK });
  });

  it('EIP-1967 beacon proxy (Euler EVK shape): asks the beacon for implementation() at the same block', async () => {
    const client = mockClient({
      code: { [lc(VAULT)]: EULER_PROXY, [lc(IMPL)]: PLAIN_IMPL },
      slots: { [EIP1967_BEACON_SLOT]: word(BEACON) },
      beaconImpl: IMPL,
    });
    const id = await identifyImplementation(client, VAULT, BLOCK);
    expect(id.proxy).toEqual({ kind: 'eip1967-beacon', implementation: IMPL, beacon: BEACON });
    expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: BEACON, functionName: 'implementation', blockNumber: BLOCK }));
    expect(id.implementationKeyKind.of).toBe('implementation');
  });

  it('EIP-1167 clone: implementation comes from the code, no storage read', async () => {
    const clone: Hex = `0x363d3d373d3d3d363d73${IMPL.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    const client = mockClient({ code: { [lc(VAULT)]: clone, [lc(IMPL)]: PLAIN_IMPL } });
    const id = await identifyImplementation(client, VAULT, BLOCK);
    expect(id.proxy).toEqual({ kind: 'eip1167', implementation: IMPL });
    expect(client.getStorageAt).not.toHaveBeenCalled();
    expect(id.implementationKey).toBe(keyOf(PLAIN_IMPL));
  });

  it('small DELEGATECALL code with empty slots is a proxy of unknown kind, keyed by its own code', async () => {
    const id = await identifyImplementation(mockClient({ code: { [lc(VAULT)]: EULER_PROXY } }), VAULT, BLOCK);
    expect(id.proxy).toEqual({ kind: 'unknown' });
    expect(id.implementation).toBeNull();
    expect(id.implementationKeyKind).toEqual({ of: 'self', hash: 'metadataHash+maskedCodeHash' });
    expect(id.implementationKey).toBe(keyOf(EULER_PROXY));
    expect(implementationIdentitySchema.parse(id)).toEqual(id);
  });

  it('implementation without code falls back to the proxy itself', async () => {
    const client = mockClient({ code: { [lc(VAULT)]: EULER_PROXY }, slots: { [EIP1967_IMPLEMENTATION_SLOT]: word(IMPL) } });
    const id = await identifyImplementation(client, VAULT, BLOCK);
    expect(id.proxy).toEqual({ kind: 'eip1967', implementation: IMPL });
    expect(id.implementation).toBeNull();
    expect(id.implementationKeyKind).toEqual({ of: 'self', hash: 'metadataHash+maskedCodeHash' });
  });

  it('no code: size 0, no masked hash, keyed by codeHash', async () => {
    const id = await identifyImplementation(mockClient({ code: {} }), VAULT, BLOCK);
    expect(id).toMatchObject({ codeSize: 0, proxy: null, maskedCodeHash: null, metadataHash: null, implementationKeyKind: { of: 'self', hash: 'codeHash' } });
    expect(id.implementationKey).toBe(keccak256('0x'));
  });
});
