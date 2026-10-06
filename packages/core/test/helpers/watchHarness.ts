import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import { expect } from 'vitest';
import {
  builtinSources,
  checkReportHash,
  FORK_ERROR_NOTE,
  GENERIC_SOURCES,
  LogsNodeBehindError,
  MONAD_MAINNET_SOURCES,
  parseCheckReport,
  parseFeed,
  StandardCheckTimeoutError,
  standardIdOf,
  summarize,
  WATCH_DIR,
  Watcher,
  WatchStore,
  type Attestation,
  type AttestParams,
  type FeedEvent,
  type SignalLog,
  type StandardCheckReport,
  type WatchConfig,
  type WatchEffects,
  type WatchAttestTxStatus,
  type WatchEvent,
  type WatcherInput,
  type WatchSource,
} from '../../src/index.js';

// The stub world of the watcher tests (watch.test.ts, watch.review.test.ts): a subject chain held in memory,
// a registry with the rules the watcher relies on, report copies in memory, a clock that moves when told.
const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MORPHO = JSON.parse(readFileSync(path.join(here, 'fixtures/attest/morpho-143-109061472.json'), 'utf8')) as StandardCheckReport;
export interface RecordedLog {
  address: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  topics: string[];
  data: string;
}
export const SIGNALS = JSON.parse(readFileSync(path.join(here, 'fixtures/watch/signals-143.json'), 'utf8')) as {
  factories: Array<{ source: string; block: string; vault: string; log: RecordedLog }>;
  generic: Record<'deposit' | 'upgraded' | 'implementation', { subject?: string; factory?: string; implementation?: string; log: RecordedLog }>;
};
export const DEMO_SOURCES = path.resolve(here, '../../../examples/watch/sources-demo.json');
export const ERC4626 = standardIdOf('erc4626');
export const T0 = new Date('2026-10-06T12:00:00.000Z');
export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
export const EVK_FACTORY = getAddress('0xba4Dd672062dE8FeeDb665DD4410658864483f1E');
export const V2_FACTORY = getAddress('0x8b2f922162fbb60a6a072cc784a2e4168fb0bb0c');
export const IMPL = addr(0x1111);

export function signalLog(l: RecordedLog): SignalLog {
  return { address: getAddress(l.address), topics: l.topics as Hex[], data: l.data as Hex, blockNumber: BigInt(l.blockNumber), transactionHash: l.transactionHash as Hex, logIndex: Number(l.logIndex) };
}

export const source = (name: string): WatchSource => [...MONAD_MAINNET_SOURCES, ...GENERIC_SOURCES].find((s) => s.name === name)!;

/** A CreateVaultV2 log of the Morpho V2 factory naming `vault`. */
export function factoryLog(vault: Address, block: bigint, logIndex = 0): SignalLog {
  const s = source('Morpho VaultV2Factory');
  const topics = encodeEventTopics({ abi: [s.event], args: { owner: addr(0xabc), asset: addr(0xa55e7), newVaultV2: vault } } as never) as Hex[];
  return { address: V2_FACTORY, topics, data: encodeAbiParameters([{ type: 'bytes32' }], [hash(7)]), blockNumber: block, transactionHash: hash(Number(block)), logIndex };
}

export function depositLog(emitter: Address, block: bigint, logIndex = 0): SignalLog {
  const s = source('ERC-4626 Deposit');
  const topics = encodeEventTopics({ abi: [s.event], args: { sender: addr(0xbeef), owner: addr(0xbeef) } } as never) as Hex[];
  return { address: emitter, topics, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [5n, 5n]), blockNumber: block, transactionHash: hash(Number(block) + 1), logIndex };
}

export function upgradedLog(emitter: Address, block: bigint, implementation: Address = IMPL): SignalLog {
  const s = source('EIP-1967 Upgraded');
  return { address: emitter, topics: encodeEventTopics({ abi: [s.event], args: { implementation } } as never) as Hex[], data: '0x', blockNumber: block, transactionHash: hash(Number(block) + 2), logIndex: 0 };
}

export function setImplementationLog(block: bigint): SignalLog {
  const s = source('Euler EVK GenericFactory implementation');
  return { address: EVK_FACTORY, topics: encodeEventTopics({ abi: [s.event], args: { newImplementation: IMPL } } as never) as Hex[], data: '0x', blockNumber: block, transactionHash: hash(Number(block) + 3), logIndex: 0 };
}

/** The Morpho fixture re-pointed at `subject` and `block`, with `fail` properties failing and an optional beacon. */
export function reportOf(
  subject: Address,
  block: bigint,
  o: { fail?: string[]; forkError?: string; implementationKey?: Hex; beacon?: Address; startedAt?: string } = {},
): StandardCheckReport {
  const results = MORPHO.results.map((r) =>
    o.fail?.includes(r.id)
      ? { ...r, status: 'fail' as const, reason: 'counterexample' }
      : r.id === o.forkError
        ? { ...r, status: 'inconclusive' as const, reason: `${FORK_ERROR_NOTE}: EVM error; database error: failed to get account: HTTP error 429` }
        : r,
  );
  const identity = o.beacon
    ? {
        ...MORPHO.identity,
        codeSize: 200,
        proxy: { kind: 'eip1967-beacon' as const, implementation: IMPL, beacon: o.beacon },
        implementation: { address: IMPL, codeHash: hash(0x51), metadataHash: null, maskedCodeHash: hash(0x52) },
        implementationKey: o.implementationKey ?? hash(0x52),
        implementationKeyKind: { of: 'implementation' as const, hash: 'maskedCodeHash' as const },
      }
    : { ...MORPHO.identity, ...(o.implementationKey ? { implementationKey: o.implementationKey } : {}) };
  return parseCheckReport(
    JSON.stringify({ ...MORPHO, address: subject, blockNumber: block.toString(), results, summary: summarize(results), identity, startedAt: o.startedAt ?? MORPHO.startedAt }),
  );
}

type FakeTx = { params: AttestParams; nonce: number; state: 'pending' | 'mined' | 'reverted' | 'dropped'; id?: bigint; supersedes?: bigint | null };

/**
 * Registry stand-in with the rules the watcher relies on: latest per subject, supersede, OlderThanLatest. A
 * send is mined at once unless `hold` keeps it pending; `mine` and `drop` settle a held one later, and
 * `replace` sends a pending one again with its nonce (the node forgets the first, the second stays pending).
 */
export class FakeRegistry {
  readonly list: Array<{ subject: Address; attestation: Attestation }> = [];
  failNext: Error | null = null;
  /** Runs at the start of the next attest: another issuer acting between the watcher's read and its send. */
  beforeAttest: ((p: AttestParams) => void) | null = null;
  /** The next send stays pending: its receipt does not come until mine(). */
  hold = false;
  /** The next wait throws although its transaction was mined: a receipt lost on the way. */
  loseReceipt = false;
  readonly txs = new Map<Hex, FakeTx>();
  readonly sends: Array<{ hash: Hex; nonce: number }> = [];
  readonly replacements: Array<{ hash: Hex; replaces: Hex }> = [];
  /** The issuer's mined transaction count. */
  minedNonce = 0;

  latest(subject: Address): { id: bigint; attestation: Attestation } | null {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i]!.subject.toLowerCase() === subject.toLowerCase()) return { id: BigInt(i), attestation: this.list[i]!.attestation };
    return null;
  }

  /** The contract's attest: another issuer's when a test calls it directly. */
  attest(p: AttestParams): { id: bigint; hash: Hex; gasCostWei: bigint; supersedes: bigint | null } {
    const prev = this.latest(p.subject);
    let supersedes: bigint | null = null;
    if (prev && prev.attestation.status === 1) {
      if (p.blockNumber < prev.attestation.blockNumber) throw Object.assign(new Error('OlderThanLatest reverted'), { errorName: 'OlderThanLatest' });
      prev.attestation.status = 2;
      supersedes = prev.id;
    }
    const id = BigInt(this.list.length);
    this.list.push({
      subject: p.subject,
      attestation: {
        ...p,
        issuedAt: 1n,
        issuer: addr(0x155),
        status: 1,
        supersededBy: 0n,
        revokeReasonHash: hash(0),
      } as Attestation,
    });
    return { id, hash: hash(0x7000 + Number(id)), gasCostWei: 1n, supersedes };
  }

  /** sendAttest: the simulation (failNext, OlderThanLatest) throws before anything is sent. */
  send(p: AttestParams, opts: { nonce?: number } = {}): { hash: Hex; nonce: number } {
    this.beforeAttest?.(p);
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
    const prev = this.latest(p.subject);
    if (prev && prev.attestation.status === 1 && p.blockNumber < prev.attestation.blockNumber) throw Object.assign(new Error('OlderThanLatest reverted'), { errorName: 'OlderThanLatest' });
    const nonce = opts.nonce ?? this.minedNonce + [...this.txs.values()].filter((t) => t.state === 'pending').length;
    const h = hash(0x7000 + this.list.length + this.sends.length - this.minedSends());
    this.sends.push({ hash: h, nonce });
    this.txs.set(h, { params: p, nonce, state: 'pending' });
    if (this.hold) this.hold = false;
    else this.mine(h);
    return { hash: h, nonce };
  }

  private minedSends(): number {
    return [...this.txs.values()].filter((t) => t.state === 'mined').length;
  }

  /** Mines a pending send (the node forgets the others with its nonce); it reverts when a later attestation landed meanwhile. */
  mine(h: Hex): void {
    const tx = this.txs.get(h)!;
    this.minedNonce = Math.max(this.minedNonce, tx.nonce + 1);
    for (const other of this.txs.values()) if (other !== tx && other.nonce === tx.nonce && other.state === 'pending') other.state = 'dropped';
    try {
      const out = this.attest(tx.params);
      tx.id = out.id;
      tx.supersedes = out.supersedes;
      tx.state = 'mined';
    } catch {
      tx.state = 'reverted';
    }
  }

  /** The node forgets a pending send; `nonceUsed` says another transaction took its nonce. */
  drop(h: Hex, nonceUsed = false): void {
    const tx = this.txs.get(h)!;
    tx.state = 'dropped';
    if (nonceUsed) this.minedNonce = Math.max(this.minedNonce, tx.nonce + 1);
  }

  replace(sent: { hash: Hex; nonce: number }): { hash: Hex; nonce: number } {
    const tx = this.txs.get(sent.hash);
    if (tx?.state !== 'pending') throw Object.assign(new Error('nonce too low'), { name: 'RegistryError' });
    tx.state = 'dropped';
    const h = hash(0x7800 + this.replacements.length);
    this.replacements.push({ hash: h, replaces: sent.hash });
    this.txs.set(h, { params: tx.params, nonce: tx.nonce, state: 'pending' });
    return { hash: h, nonce: tx.nonce };
  }

  wait(h: Hex): { id: bigint; gasCostWei: bigint; supersedes: bigint | null } {
    const tx = this.txs.get(h);
    if (this.loseReceipt) {
      this.loseReceipt = false;
      throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
    }
    if (tx?.state === 'mined') return { id: tx.id!, gasCostWei: 1n, supersedes: tx.supersedes ?? null };
    if (tx?.state === 'reverted') throw Object.assign(new Error(`attest tx ${h} reverted`), { name: 'RegistryError' });
    throw Object.assign(new Error(`Timed out while waiting for transaction with hash "${h}" to be confirmed.`), { name: 'WaitForTransactionReceiptTimeoutError' });
  }

  status(sent: { hash: Hex; nonce: number }): WatchAttestTxStatus {
    const tx = this.txs.get(sent.hash);
    if (tx?.state === 'mined') return { state: 'mined', id: tx.id!, gasCostWei: 1n, supersedes: tx.supersedes ?? null };
    if (tx?.state === 'reverted') return { state: 'reverted', gasCostWei: 1n };
    if (tx?.state === 'pending') return { state: 'pending' };
    return { state: 'dropped', nonceUsed: this.minedNonce > sent.nonce };
  }

  hasPending(): boolean {
    return [...this.txs.values()].some((t) => t.state === 'pending');
  }
}

export interface Chain {
  head: bigint;
  logs: SignalLog[];
  notVaults: Set<string>;
  /** Probes of these subjects throw an RPC error this many more times. */
  probeErrors: Map<string, number>;
  /** Failing property ids per subject (lowercase). */
  failing: Map<string, string[]>;
  /** Checks of these subjects throw this many more times. */
  checkErrors: Map<string, number>;
  /** Checks of these subjects leave `deposit` inconclusive on a fork RPC error this many more times. */
  forkErrors: Map<string, number>;
  /** Checks of these subjects run out of time. */
  timeouts: Set<string>;
  beacons: Map<string, Address>;
  /** eth_getLogs refuses windows larger than this, like rpc.monad.xyz (-32614 with HTTP 413). */
  rangeLimit: bigint | null;
  getLogsCalls: Array<[bigint, bigint]>;
  /** topic0 lists of the getLogs calls. */
  getLogsTopics: Hex[][];
  /** The getLogs node's own head when it lags the head node. */
  logsHead: bigint | null;
  /** Code hash and EIP-1967 slots per subject (lowercase); unset subjects share one value. */
  fingerprints: Map<string, Hex>;
  fingerprintReads: number;
  /** The issuer's balance on the attest chain. */
  balance: bigint;
}

export interface Harness {
  dir: string;
  chain: Chain;
  registry: FakeRegistry;
  clock: { now: Date };
  effects: WatchEffects;
  checks: Array<{ subject: Address; block: bigint }>;
  events: WatchEvent[];
  store: WatchStore;
  watcher(config?: Partial<WatchConfig>, hooks?: ConstructorParameters<typeof Watcher>[0]['hooks'], sources?: WatchSource[], extra?: Partial<WatcherInput>): Watcher;
  feed(): Promise<FeedEvent[]>;
  reload(): Promise<WatchStore>;
  /** Report copies saved under certs/checks, by path. */
  savedReports(): string[];
}

const dirs: string[] = [];
/** Registers a temp directory for cleanupHarnesses. */
export function trackDir(dir: string): void {
  dirs.push(dir);
}

/** Removes the directories of the harnesses made so far; call it in afterEach. */
export async function cleanupHarnesses(): Promise<void> {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
}

export function rangeError(limit: bigint): Error {
  // What viem's http transport throws for rpc.monad.xyz: HTTP 413 with the JSON-RPC error in details.
  return Object.assign(new Error('HTTP request failed.'), {
    name: 'HttpRequestError',
    status: 413,
    details: JSON.stringify({ code: -32614, message: `eth_getLogs is limited to a ${limit} range` }),
  });
}

export async function harness(): Promise<Harness> {
  const dir = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-'));
  dirs.push(dir);
  const chain: Chain = {
    head: 2000n,
    logs: [],
    notVaults: new Set(),
    probeErrors: new Map(),
    failing: new Map(),
    checkErrors: new Map(),
    forkErrors: new Map(),
    timeouts: new Set(),
    beacons: new Map(),
    rangeLimit: null,
    getLogsCalls: [],
    getLogsTopics: [],
    logsHead: null,
    fingerprints: new Map(),
    fingerprintReads: 0,
    balance: 10n ** 19n,
  };
  const registry = new FakeRegistry();
  const clock = { now: T0 };
  const saved = new Map<string, StandardCheckReport>();
  const checks: Array<{ subject: Address; block: bigint }> = [];
  const events: WatchEvent[] = [];
  const effects: WatchEffects = {
    subjectChainId: 143,
    latestBlock: async () => chain.head,
    getLogs: async (from, to, topics) => {
      chain.getLogsCalls.push([from, to]);
      chain.getLogsTopics.push(topics);
      if (chain.logsHead !== null && to > chain.logsHead) throw new LogsNodeBehindError(chain.logsHead);
      if (chain.rangeLimit !== null && to - from > chain.rangeLimit) throw rangeError(chain.rangeLimit);
      return chain.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && topics.includes(l.topics[0]!));
    },
    fingerprint: async (subject) => {
      chain.fingerprintReads++;
      return chain.fingerprints.get(subject.toLowerCase()) ?? hash(0xf1);
    },
    precheck: async (subject, block) => {
      const left = chain.probeErrors.get(subject.toLowerCase()) ?? 0;
      if (left > 0) {
        chain.probeErrors.set(subject.toLowerCase(), left - 1);
        throw Object.assign(new Error('missing trie node'), { name: 'RpcRequestError' });
      }
      if (chain.notVaults.has(subject.toLowerCase())) return { ok: false, reason: `asset() failed at block ${block}: reverted` };
      return { ok: true, asset: addr(0xa55e7) };
    },
    runCheck: async (subject, block) => {
      const left = chain.checkErrors.get(subject.toLowerCase()) ?? 0;
      if (left > 0) {
        chain.checkErrors.set(subject.toLowerCase(), left - 1);
        throw new Error('forge exited with code 1: could not fork');
      }
      if (chain.timeouts.has(subject.toLowerCase())) throw new StandardCheckTimeoutError(600);
      checks.push({ subject, block });
      const forks = chain.forkErrors.get(subject.toLowerCase()) ?? 0;
      if (forks > 0) chain.forkErrors.set(subject.toLowerCase(), forks - 1);
      return reportOf(subject, block, {
        fail: chain.failing.get(subject.toLowerCase()),
        ...(forks > 0 ? { forkError: 'deposit' } : {}),
        beacon: chain.beacons.get(subject.toLowerCase()),
        startedAt: clock.now.toISOString(),
      });
    },
    saveReport: async (report) => {
      const file = `${report.chainId}/${report.address.toLowerCase()}/${report.blockNumber}-${checkReportHash(report).slice(2, 18)}.json`;
      saved.set(`certs/checks/${file}`, report);
      return { reportPath: `certs/checks/${file}`, reportURI: `https://example.org/checks/${file}` };
    },
    loadReport: async (p) => {
      const r = saved.get(p) ?? (existsSync(path.join(dir, p)) ? parseCheckReport(await readFile(path.join(dir, p), 'utf8')) : undefined);
      if (!r) throw new Error(`no report ${p}`);
      return r;
    },
    reportURIOf: (p) => `https://example.org/checks/${p.replace(/^certs\/checks\//, '')}`,
    verifySubject: async (report) => ({ chainId: 143, blockNumber: BigInt(report.blockNumber), codeHash: report.identity.codeHash as Hex, identity: report.identity as never, unknownProxy: false }),
    latestAttestation: async (subject) => registry.latest(subject),
    attest: {
      send: async (params, opts) => registry.send(params, opts),
      wait: async (h) => registry.wait(h),
      status: async (sent) => registry.status(sent),
      hasPending: async () => registry.hasPending(),
      replace: async (sent) => registry.replace(sent),
    },
    balance: async () => chain.balance,
    now: () => clock.now,
  };
  const h: Harness = {
    dir,
    chain,
    registry,
    clock,
    effects,
    checks,
    events,
    store: await WatchStore.load(dir, 143),
    watcher: (config = {}, hooks, sources, extra = {}) =>
      new Watcher({
        effects,
        store: h.store,
        sources: sources ?? builtinSources(143).sources,
        config: { sweepPerHour: 0, subscriptionRefreshMs: 0, checkRetryMs: 60_000, ...config },
        ...(hooks ? { hooks } : {}),
        onEvent: (e) => events.push(e),
        ...extra,
      }),
    feed: async () => {
      const text = await readFile(path.join(dir, WATCH_DIR, '143', 'feed.ndjson'), 'utf8').catch(() => '');
      const parsed = parseFeed(text);
      expect(parsed.invalid).toBe(0);
      return parsed.events;
    },
    reload: async () => (h.store = await WatchStore.load(dir, 143)),
    savedReports: () => [...saved.keys()],
  };
  return h;
}

export const kinds = (events: FeedEvent[]) => events.map((e) => `${e.kind}:${e.source ?? ''}`);

export function attestParams(subject: Address, block: bigint): AttestParams {
  return {
    subjectChainId: 143n,
    subject,
    standardId: ERC4626,
    blockNumber: block,
    implementationKey: MORPHO.identity.implementationKey as Hex,
    subjectCodeHash: hash(1),
    suiteHash: hash(2),
    reportHash: hash(3),
    passCount: 30,
    failCount: 0,
    inconclusiveCount: 0,
    notApplicableCount: 0,
    passedBitmap: (1n << 30n) - 1n,
    failedBitmap: 0n,
    reportURI: 'https://example.org/r.json',
  };
}
