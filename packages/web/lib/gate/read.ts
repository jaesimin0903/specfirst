import { parseAbi, parseEventLogs, type Log } from 'viem';
import { describeReadError, type RawAttestation } from '../board/attestations';
import { registryReadAbi } from '../desk/registry';
import { allocationGateAbi, exitAllowed, gateExitPathOf, gateVerdictOf, GATE_CHAIN_ID, type GateVerdict } from './contract';
import type { GateAttestationJson, GateEventJson, GateVaultJson, GateViewJson } from './types';

/*
 * Request-time reads of an AllocationGate and of the registry it trusts. State comes from view calls made together,
 * which the server client folds into one multicall per wave. Events come from eth_getLogs over single blocks the gate
 * itself points at (each vault's last allocation and last exit attempt) plus one window of the latest blocks: a few
 * requests, never a scan from the deployment, within the testnet RPC's 15 requests a second and 100-block getLogs.
 */

/** One getLogs window at the head: 100 blocks, the most some public endpoints accept. */
export const RECENT_LOG_BLOCKS = 100n;
/** At most this many pointed-at blocks are read for events, newest first. */
export const MAX_POINTER_BLOCKS = 12;

export interface GateChainReader {
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getLogs(args: { address: `0x${string}`; fromBlock: bigint; toBlock: bigint }): Promise<readonly Log[]>;
  getBlock(): Promise<{ number: bigint | null; timestamp: bigint }>;
}

const extraAbi = parseAbi([
  'function isIssuer(address) view returns (bool)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const STATUS = ['None', 'Valid', 'Superseded', 'Revoked'] as const;
const SUMMARY = ['registry', 'subjectChainId', 'standardId', 'asset', 'owner', 'maxAttestationAge', 'idle', 'vaults'] as const;

interface RawPosition {
  shares: bigint;
  assetsIn: bigint;
  assetsOut: bigint;
  lastAllocatedBlock: bigint;
  lastExitBlock: bigint;
}

function revertedWith(err: unknown, name: string): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const x = e as { data?: { errorName?: string }; shortMessage?: string; cause?: unknown };
    if (x.data?.errorName === name) return true;
    if (typeof x.shortMessage === 'string' && x.shortMessage.includes(name)) return true;
    e = x.cause;
  }
  return false;
}

function attestationJson(id: bigint, a: RawAttestation, issuerAllowed: boolean | null): GateAttestationJson {
  return {
    id: id.toString(),
    status: STATUS[Number(a.status)] ?? 'None',
    passCount: Number(a.passCount),
    failCount: Number(a.failCount),
    inconclusiveCount: Number(a.inconclusiveCount),
    notApplicableCount: Number(a.notApplicableCount),
    issuer: a.issuer,
    issuerAllowed,
    issuedAt: a.issuedAt.toString(),
    blockNumber: a.blockNumber.toString(),
    reportURI: a.reportURI,
  };
}

/** The gate's events in `logs` (other emitters dropped), as page JSON. */
export function gateEventsOf(gate: `0x${string}`, logs: readonly Log[]): GateEventJson[] {
  const own = logs.filter((l) => l.address.toLowerCase() === gate.toLowerCase());
  return parseEventLogs({ abi: allocationGateAbi, logs: own }).map((l) => {
    const at = { blockNumber: (l.blockNumber ?? 0n).toString(), txHash: l.transactionHash ?? '', logIndex: l.logIndex ?? 0 };
    switch (l.eventName) {
      case 'Allocated':
        return { ...at, kind: 'Allocated', vault: l.args.vault, attestationId: l.args.attestationId.toString(), assets: l.args.assets.toString(), shares: l.args.shares.toString() };
      case 'Exited':
        return {
          ...at,
          kind: 'Exited',
          vault: l.args.vault,
          attestationId: l.args.attestationId.toString(),
          caller: l.args.caller,
          verdict: gateVerdictOf(l.args.verdict),
          path: gateExitPathOf(l.args.path),
          shares: l.args.shares.toString(),
          assets: l.args.assets.toString(),
        };
      case 'ExitFailed':
        return {
          ...at,
          kind: 'ExitFailed',
          vault: l.args.vault,
          attestationId: l.args.attestationId.toString(),
          caller: l.args.caller,
          verdict: gateVerdictOf(l.args.verdict),
          shares: l.args.shares.toString(),
          redeemError: l.args.redeemError,
          withdrawError: l.args.withdrawError,
        };
      case 'IdleWithdrawn':
        return { ...at, kind: 'IdleWithdrawn', to: l.args.to, amount: l.args.amount.toString() };
    }
  });
}

/** Newest first; the same log read twice (a pointer inside the recent window) appears once. */
function newestFirst(events: GateEventJson[]): GateEventJson[] {
  const seen = new Set<string>();
  return events
    .filter((e) => {
      const k = `${e.txHash}:${e.logIndex}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (BigInt(b.blockNumber) === BigInt(a.blockNumber) ? b.logIndex - a.logIndex : BigInt(b.blockNumber) > BigInt(a.blockNumber) ? 1 : -1));
}

/**
 * Everything /watch/gate shows about `gate`. Throws when the gate's own summary cannot be read (not reachable, or
 * not a gate); any later read that fails is listed in `errors` and its field left null.
 */
export async function readGateView(reader: GateChainReader, gate: `0x${string}`): Promise<GateViewJson> {
  const read = (functionName: string, args: readonly unknown[] = [], address: `0x${string}` = gate, abi: readonly unknown[] = allocationGateAbi) =>
    reader.readContract({ address, abi, functionName, args });
  const [summary, block] = await Promise.all([Promise.all(SUMMARY.map((f) => read(f))), reader.getBlock()]);
  const [registry, subjectChainId, standardId, asset, owner, maxAttestationAge, idle, vaultList] = summary as [
    `0x${string}`,
    bigint,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    bigint,
    bigint,
    readonly `0x${string}`[],
  ];
  const vaults = [...vaultList];
  const errors: string[] = [];
  const head = block.number ?? 0n;
  const regArgs = (v: `0x${string}`) => [subjectChainId, v, standardId] as const;

  const [symbol, decimals, perVault] = await Promise.all([
    read('symbol', [], asset, extraAbi).then(
      (v) => v as string,
      () => null,
    ),
    read('decimals', [], asset, extraAbi).then(
      (v) => Number(v),
      () => 18,
    ),
    Promise.all(
      vaults.map((v) =>
        Promise.allSettled([
          read('positionOf', [v]),
          read('verdictOf', [v]),
          read('latest', regArgs(v), registry, registryReadAbi),
          read('isCompliant', regArgs(v), registry, registryReadAbi),
        ]),
      ),
    ),
  ]);

  const latestOf = perVault.map((r, i) => {
    const s = r[2];
    if (s.status === 'fulfilled') return s.value as readonly [bigint, RawAttestation];
    if (!revertedWith(s.reason, 'NoAttestation')) errors.push(`latest attestation of ${vaults[i]}: ${describeReadError(s.reason)}`);
    return null;
  });
  const issuers = [...new Set(latestOf.flatMap((l) => (l ? [l[1].issuer.toLowerCase()] : [])))];
  const allowed = new Map<string, boolean | null>();
  await Promise.all(
    issuers.map((issuer) =>
      read('isIssuer', [issuer], registry, extraAbi).then(
        (ok) => allowed.set(issuer, Boolean(ok)),
        (err) => {
          allowed.set(issuer, null);
          errors.push(`isIssuer(${issuer}): ${describeReadError(err)}`);
        },
      ),
    ),
  );

  const rows: GateVaultJson[] = vaults.map((v, i) => {
    const [position, verdictRead, , compliantRead] = perVault[i]!;
    let p: RawPosition = { shares: 0n, assetsIn: 0n, assetsOut: 0n, lastAllocatedBlock: 0n, lastExitBlock: 0n };
    if (position.status === 'fulfilled') p = position.value as RawPosition;
    else errors.push(`position in ${v}: ${describeReadError(position.reason)}`);
    let verdict: GateVerdict | null = null;
    if (verdictRead.status === 'fulfilled') verdict = gateVerdictOf((verdictRead.value as readonly [number, bigint])[0]);
    else errors.push(`verdict of ${v}: ${describeReadError(verdictRead.reason)}`);
    const latest = latestOf[i];
    return {
      vault: v,
      shares: p.shares.toString(),
      assetsIn: p.assetsIn.toString(),
      assetsOut: p.assetsOut.toString(),
      lastAllocatedBlock: p.lastAllocatedBlock.toString(),
      lastExitBlock: p.lastExitBlock.toString(),
      verdict,
      compliant: compliantRead.status === 'fulfilled' ? Boolean(compliantRead.value) : null,
      attestation: latest ? attestationJson(latest[0], latest[1], allowed.get(latest[1].issuer.toLowerCase()) ?? null) : null,
      canExit: p.shares > 0n && verdict !== null && exitAllowed(verdict),
    };
  });

  // Events: the latest window, then the blocks the gate points at that lie before it, one request each, in turn.
  const from = head >= RECENT_LOG_BLOCKS - 1n ? head - (RECENT_LOG_BLOCKS - 1n) : 0n;
  const pointers = [...new Set(rows.flatMap((r) => [BigInt(r.lastAllocatedBlock), BigInt(r.lastExitBlock)]).filter((b) => b > 0n && b < from))]
    .sort((a, b) => (a > b ? -1 : 1))
    .slice(0, MAX_POINTER_BLOCKS);
  const events: GateEventJson[] = [];
  for (const [fromBlock, toBlock] of [[from, head] as const, ...pointers.map((b) => [b, b] as const)]) {
    try {
      events.push(...gateEventsOf(gate, await reader.getLogs({ address: gate, fromBlock, toBlock })));
    } catch (err) {
      errors.push(`events in blocks ${fromBlock} to ${toBlock}: ${describeReadError(err)}`);
    }
  }

  return {
    address: gate,
    chainId: GATE_CHAIN_ID,
    registry,
    asset,
    assetSymbol: symbol,
    assetDecimals: decimals,
    owner,
    subjectChainId: subjectChainId.toString(),
    standardId,
    maxAttestationAge: maxAttestationAge.toString(),
    idle: idle.toString(),
    head: head.toString(),
    now: block.timestamp.toString(),
    vaults: rows,
    events: newestFirst(events),
    errors,
  };
}
