import path from 'node:path';
import { getAbiItem, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import type { SpecfirstPublicClient } from '../chain/client.js';
import { readArtifact } from '../deploy/artifacts.js';
import { writeJson } from '../deploy/deploy.js';
import { ForgeBackend } from '../fuzz/forge.js';
import type { FuzzBackend, FuzzResult, InvariantResult } from '../fuzz/types.js';
import type { RehearsalRecord } from '../rehearse/rehearse.js';
import { vaultAbi } from '../rehearse/rehearse.js';
import type { Spec } from '../spec/schema.js';
import { DEFAULT_LOG_CHUNK, getLogsChunked } from './logs.js';
import { runProbe } from './probe.js';

export const VERIFY_JSON = 'verify.json';
/** CLI exit code when a deployed contract violates an invariant (plan 3.10). */
export const VERIFY_FAILED_EXIT_CODE = 13;
export const DEFAULT_FORK_RUNS = 32;
export const FORK_NOT_USED = 'fork 대조 미사용';

/** Events whose presence from a non-owner transaction breaks an access invariant (plan 3.6 item 4). */
export const DEFAULT_ACCESS_EVENTS: Record<string, string[]> = {
  'INV-5': ['RewardRateChanged'],
  'INV-7': ['Paused'],
};
/** Invariants judged by SpecfirstProbe when fork is unavailable. */
export const PROBE_INVARIANTS = { inv1: 'INV-1', inv2: 'INV-2', inv6: 'INV-6' } as const;

export interface InvariantVerdict {
  id: string;
  kind: string;
  /** null: not judged on this path (reported as unverified, never as passed). */
  ok: boolean | null;
  evidence: string[];
}

export interface VerifyRecord {
  version: 1;
  chainId: number;
  target: Address;
  path: 'fork' | 'probe';
  note?: string;
  fork: {
    url: string;
    block: string;
    runs: number;
    wallclockSec: number;
    rawArtifactPath: string;
    error?: string;
  } | null;
  probe: { block: string; inv1: boolean; inv2: boolean; inv6: boolean } | null;
  depositors: { fromBlock: string; toBlock: string; chunks: number; count: number; addresses: Address[] };
  invariants: InvariantVerdict[];
  passed: number;
  violated: number;
  unjudged: number;
  ok: boolean;
  verifiedAt: string;
}

export interface CollectDepositorsInput {
  client: SpecfirstPublicClient;
  target: Address;
  fromBlock: bigint;
  toBlock?: bigint;
  chunkSize?: bigint;
}

/** Every address that ever emitted Deposit(user, ...) on the vault, from the deploy block on (plan 3.6 item 3). */
export async function collectDepositors(input: CollectDepositorsInput): Promise<{ addresses: Address[]; chunks: number; toBlock: bigint }> {
  const toBlock = input.toBlock ?? (await input.client.getBlockNumber());
  let chunks = 0;
  const logs = await getLogsChunked({
    client: input.client,
    address: input.target,
    event: getAbiItem({ abi: vaultAbi, name: 'Deposit' }) as AbiEvent,
    fromBlock: input.fromBlock,
    toBlock,
    chunkSize: input.chunkSize,
    onChunk: () => void chunks++,
  });
  const seen = new Map<string, Address>();
  for (const l of logs as Array<Log & { args?: { user?: Address } }>) {
    const user = l.args?.user;
    if (user && !seen.has(user.toLowerCase())) seen.set(user.toLowerCase(), user);
  }
  return { addresses: [...seen.values()], chunks, toBlock };
}

export interface VerifyInput {
  spec: Spec;
  /** Worktree or project with the locked properties; forge runs here. */
  projectDir: string;
  client: SpecfirstPublicClient;
  /** RPC URL forge forks from. */
  forkUrl: string;
  target: Address;
  deployBlock: bigint;
  rehearsal: RehearsalRecord | null;
  runs?: number;
  depth?: number;
  timeoutSec?: number;
  seed?: string;
  chunkSize?: bigint;
  /** Where forge output goes (raw JSON, out/, cache/). */
  artifactDir: string;
  backend?: FuzzBackend;
  forgeBin?: string;
  /** Skip the fork and use the probe path directly (tests, or RPCs known not to serve forks). */
  forceProbe?: boolean;
  /** Replace the collected depositor set (tests only: shows INV-1 breaks without third-party depositors). */
  depositorsOverride?: Address[];
  /** forge out dir holding SpecfirstProbe; built by deploy. */
  outDir: string;
  accessEvents?: Record<string, string[]>;
  recordPath?: string;
}

function forkFailed(fuzz: FuzzResult): string | null {
  if (fuzz.results.length === 0) return 'forge returned no results';
  if (fuzz.results.every((r) => r.status === 'error')) return fuzz.results[0]?.error?.split('\n')[0] ?? 'fork run failed';
  return null;
}

function fuzzEvidence(r: InvariantResult, block: bigint): string {
  if (r.status === 'pass') return `fork block ${block}: property held`;
  if (r.status === 'error') return `fork block ${block}: error ${r.error?.split('\n')[0] ?? ''}`;
  const ce = r.counterexample;
  const calls = ce?.callSequence.length ? ` after ${ce.callSequence.length} call(s): ${ce.callSequence.join(' | ')}` : '';
  return `fork block ${block}: ${ce?.reason ?? 'failed'}${calls}`;
}

/**
 * Post-deploy comparison (plan 3.6 items 3, 4, 6; ADR 0001):
 *  (a) depositor set from Deposit logs in 100-block chunks,
 *  (b) the locked Invariants.t.sol on a fork pinned at the latest block, attached to the deployed vault,
 *  (c) access invariants also need their rehearsal revert txs judged "reverted" and no RewardRateChanged
 *      or Paused event from a non-owner tx in the rehearsal block range,
 *  (d) verify.json with {ok, evidence[]} per invariant.
 * When the fork run fails entirely, SpecfirstProbe judges INV-1, 2, 6 and the rest rely on the rehearsal.
 */
export async function verifyDeployment(input: VerifyInput): Promise<VerifyRecord> {
  const { spec, client, target, rehearsal } = input;
  const accessEvents = input.accessEvents ?? DEFAULT_ACCESS_EVENTS;
  const runs = input.runs ?? DEFAULT_FORK_RUNS;

  // (a)
  const dep = await collectDepositors({ client, target, fromBlock: input.deployBlock, chunkSize: input.chunkSize ?? DEFAULT_LOG_CHUNK });
  const depositors = input.depositorsOverride ?? dep.addresses;

  // (b)
  let fork: VerifyRecord['fork'] = null;
  let fuzz: FuzzResult | null = null;
  let forkBlock = dep.toBlock;
  if (!input.forceProbe) {
    forkBlock = await client.getBlockNumber();
    const backend = input.backend ?? new ForgeBackend({ artifactDir: input.artifactDir, forgeBin: input.forgeBin });
    fuzz = await backend.run({
      worktree: input.projectDir,
      spec,
      params: { runs, depth: input.depth ?? 32, timeoutSec: input.timeoutSec ?? 600, ...(input.seed ? { seed: input.seed } : {}) },
      target,
      forkUrl: input.forkUrl,
      forkBlockNumber: forkBlock,
      env: { SPECFIRST_DEPOSITORS: depositors.join(',') },
      persistDir: path.join(input.artifactDir, 'fork-persist'),
    });
    const failure = forkFailed(fuzz);
    fork = {
      url: input.forkUrl,
      block: forkBlock.toString(),
      runs,
      wallclockSec: fuzz.wallclockSec,
      rawArtifactPath: fuzz.rawArtifactPath,
      ...(failure ? { error: failure } : {}),
    };
    if (failure) fuzz = null;
  }

  let probe: VerifyRecord['probe'] = null;
  if (!fuzz) {
    const artifact = await readArtifact(input.outDir, 'SpecfirstProbe.sol', 'SpecfirstProbe');
    const p = await runProbe(client, artifact.bytecode, target, depositors);
    probe = { block: p.block.toString(), inv1: p.inv1, inv2: p.inv2, inv6: p.inv6 };
  }

  // (c)
  const eventEvidence = new Map<string, { ok: boolean; lines: string[] }>();
  if (rehearsal && rehearsal.txs.length > 0) {
    const from = BigInt(rehearsal.fromBlock);
    const to = BigInt(rehearsal.toBlock);
    for (const [invId, names] of Object.entries(accessEvents)) {
      if (!spec.invariants.some((i) => i.id === invId)) continue;
      const lines: string[] = [];
      let ok = true;
      for (const name of names) {
        const event = getAbiItem({ abi: vaultAbi, name: name as 'Paused' }) as AbiEvent | undefined;
        if (!event) continue;
        const logs = await getLogsChunked({ client, address: target, event, fromBlock: from, toBlock: to, chunkSize: input.chunkSize });
        const nonOwner: string[] = [];
        for (const l of logs) {
          const tx = await client.getTransaction({ hash: l.transactionHash! });
          if (tx.from.toLowerCase() !== rehearsal.owner.toLowerCase()) nonOwner.push(`${l.transactionHash}#${l.logIndex} from ${tx.from}`);
        }
        const revertHashes = new Set(rehearsal.txs.filter((t) => t.invariantId === invId).map((t) => t.hash.toLowerCase()));
        const fromReverted = logs.filter((l) => revertHashes.has((l.transactionHash ?? '').toLowerCase()));
        if (nonOwner.length > 0 || fromReverted.length > 0) {
          ok = false;
          lines.push(`${name} emitted by non-owner tx in blocks ${from}~${to}: ${nonOwner.join(', ') || fromReverted.map((l) => l.transactionHash).join(', ')}`);
        } else {
          lines.push(`${name}: ${logs.length} log(s) in blocks ${from}~${to}, all from owner txs, none from revert-expected txs`);
        }
      }
      eventEvidence.set(invId, { ok, lines });
    }
  }

  // (d)
  const invariants: InvariantVerdict[] = spec.invariants.map((inv) => {
    const evidence: string[] = [];
    let ok: boolean | null = null;
    const and = (v: boolean) => {
      ok = ok === null ? v : ok && v;
    };

    if (fuzz) {
      const r = fuzz.results.find((x) => x.invariantId === inv.id);
      if (r) {
        and(r.status === 'pass');
        evidence.push(fuzzEvidence(r, forkBlock));
      } else {
        evidence.push(`fork block ${forkBlock}: no result for ${inv.id}`);
      }
    } else if (probe) {
      const entry = Object.entries(PROBE_INVARIANTS).find(([, id]) => id === inv.id);
      if (entry) {
        const v = probe[entry[0] as keyof typeof PROBE_INVARIANTS];
        and(v);
        evidence.push(`probe eth_call at block ${probe.block}: ${entry[0]} ${v ? 'held' : 'violated'} (${FORK_NOT_USED})`);
      }
    }

    const revertTxs = rehearsal?.txs.filter((t) => t.expectRevert && t.invariantId === inv.id) ?? [];
    for (const t of revertTxs) {
      const good = t.verdict === 'reverted';
      and(good);
      const sel = typeof t.selector === 'object' ? (t.selector.match ? `selector ${t.selector.actual} = ${t.selector.expectedError}` : `selector ${t.selector.actual ?? '?'} != ${t.selector.expectedError}`) : (t.selector ?? 'selector 미확인');
      evidence.push(`tx ${t.hash} block ${t.block} ${t.revertKind}: ${t.verdict}, status ${t.status}, gasUsed ${t.gasUsed} of ${t.gasLimit}, ${sel}`);
    }
    const ev = eventEvidence.get(inv.id);
    if (ev) {
      and(ev.ok);
      evidence.push(...ev.lines);
    }
    if (ok === null) evidence.push(fuzz ? 'no evidence' : `${FORK_NOT_USED}: not judged on the probe path`);
    return { id: inv.id, kind: inv.kind, ok, evidence };
  });

  const passed = invariants.filter((i) => i.ok === true).length;
  const violated = invariants.filter((i) => i.ok === false).length;
  const record: VerifyRecord = {
    version: 1,
    chainId: client.chain.id,
    target,
    path: fuzz ? 'fork' : 'probe',
    ...(fuzz ? {} : { note: FORK_NOT_USED }),
    fork,
    probe,
    depositors: {
      fromBlock: input.deployBlock.toString(),
      toBlock: dep.toBlock.toString(),
      chunks: dep.chunks,
      count: depositors.length,
      addresses: depositors,
    },
    invariants,
    passed,
    violated,
    unjudged: invariants.length - passed - violated,
    ok: violated === 0 && passed === invariants.length,
    verifiedAt: new Date().toISOString(),
  };
  if (input.recordPath) await writeJson(input.recordPath, record);
  return record;
}

