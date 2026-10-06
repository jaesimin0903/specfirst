import { getAddress, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { attestationParamsFromReport, AttestationError, checkReportHash, standardIdOf, type AttestParams } from '../attest/params.js';
import { ATTESTATION_STATUS, type Attestation, type AttestationRegistryClient } from '../attest/registry.js';
import {
  checkBlockOf,
  countsAsFailure,
  errorNameOf,
  errorText,
  isCheckTimeout,
  loadReportCopy,
  precheckErc4626,
  runSubjectCheck,
  saveReportCopy,
  type Erc4626Precheck,
  type SubjectCheckInput,
} from '../attest/subjectCheck.js';
import { verifySubjectCode, type SubjectClient, type SubjectCodeCheck } from '../attest/verify.js';
import type { StandardCheckClient } from '../standards/check.js';
import { forkRpcErrorsOf, type StandardCheckReport } from '../standards/report.js';
import { attestDecision, changeOf, outcomeOfReport, type AttestDecision, type CheckOutcome } from './decide.js';
import { NO_ALERTS, NO_SUBSCRIPTIONS, type ActiveSubscription, type AlertSink, type SubscriptionSource } from './hooks.js';
import { DEFAULT_LOG_WINDOW, LogWindow, readLogWindows } from './logs.js';
import { enqueue, nextEntry, priorityOf, queueOrder, removeEntry, type QueueEntry } from './queue.js';
import type { FeedAttestation, FeedCheck, FeedEvent, FeedSource, WatchStage, WatchStatus, WatchVault } from './schema.js';
import { decodeSignal, signalTopics, type Signal, type SignalLog, type WatchSource } from './sources.js';
import { beaconOf, lastCheckOf, type FeedEventInput, type WatchStore } from './store.js';

const ERC4626_ID = standardIdOf('erc4626');
const HOUR_MS = 3_600_000;

/**
 * Everything the watcher does outside its own files, injected so the loop is testable: the subject chain
 * (head, logs, pre-check, the suite, the identity check), the report copies and the registry.
 */
export interface WatchEffects {
  subjectChainId: number;
  latestBlock(): Promise<bigint>;
  /** eth_getLogs over [fromBlock, toBlock] for any of `topics` as topic0, from any emitter. */
  getLogs(fromBlock: bigint, toBlock: bigint, topics: Hex[]): Promise<SignalLog[]>;
  precheck(subject: Address, block: bigint): Promise<Erc4626Precheck>;
  runCheck(subject: Address, block: bigint): Promise<StandardCheckReport>;
  /** Writes the report copy under certs/checks; returns its repository relative path and its public URI. */
  saveReport(report: StandardCheckReport): Promise<{ reportPath: string; reportURI: string }>;
  loadReport(reportPath: string): Promise<StandardCheckReport>;
  /** verifySubjectCode with allowUnknownProxy, so the watcher decides about unknown proxies itself. */
  verifySubject(report: StandardCheckReport): Promise<SubjectCodeCheck>;
  /** The registry's latest attestation of the subject for erc4626, any status; null when there is none or no registry. */
  latestAttestation(subject: Address): Promise<{ id: bigint; attestation: Attestation } | null>;
  /** Sends the attestation; null when attesting is off (--no-attest). */
  attest: ((params: AttestParams) => Promise<{ id: bigint; hash: Hex; gasCostWei: bigint }>) | null;
  now(): Date;
}

export interface WatchConfig {
  /** Logs are read, and checks fork, this many blocks below the head. */
  lagBlocks: bigint;
  /** getLogs windows read per pass before the queue gets a turn (a pass with drain reads them all). */
  maxWindowsPerPass: number;
  /** A known vault is swept at most once per this many hours... */
  sweepHours: number;
  /** ...and at most this many sweep checks start per hour (0 turns the sweep off). */
  sweepPerHour: number;
  /** A subscribed subject is re-checked when its last check is this old. */
  subscribedMinutes: number;
  maxAttestPerDay: number;
  /** Failed checks of one queue entry before it is dropped (until the next signal or sweep). */
  maxCheckAttempts: number;
  /** Wait before retrying a failed check, times the attempts so far. */
  checkRetryMs: number;
  /** First wait before a probe that failed on an RPC or node error runs again; it doubles up to an hour. */
  probeRetryMs: number;
  /** A Deposit from an address the probe rejected probes it again only after this long; other signals at once. */
  probeRetryAfterMs: number;
  /** How often the subscription source is read. */
  subscriptionRefreshMs: number;
  /** Attest subjects whose proxy implementation is unknown instead of recording them unattested. */
  allowUnknownProxy: boolean;
  /** Stop reading logs after this block; null to follow the head. */
  toBlock: bigint | null;
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  lagBlocks: 10n,
  maxWindowsPerPass: 100,
  sweepHours: 24,
  sweepPerHour: 6,
  subscribedMinutes: 60,
  maxAttestPerDay: 40,
  maxCheckAttempts: 3,
  checkRetryMs: 5 * 60_000,
  probeRetryMs: 5 * 60_000,
  probeRetryAfterMs: 24 * HOUR_MS,
  subscriptionRefreshMs: 60_000,
  allowUnknownProxy: false,
  toBlock: null,
};

/**
 * Wall-clock budget of one watcher check (forge), seconds. Anyone can deploy what the watcher checks, so a
 * check never gets the hour `specfirst check` allows; one that runs out is recorded and not retried.
 */
export const DEFAULT_WATCH_CHECK_TIMEOUT_SEC = 600;
/** Exit code of `specfirst watch` when it cannot start or a `--once` pass cannot read the chain. */
export const WATCH_FAILED_EXIT_CODE = 19;
export const DEFAULT_WATCH_RUNS = 16;
export const DEFAULT_WATCH_POLL_SEC = 15;

export interface WatchHooks {
  subscriptions?: SubscriptionSource;
  alerts?: AlertSink;
}

/** Progress of the loop for logs (`--json`); feed events are wrapped in watch-feed. */
export type WatchEvent =
  | { type: 'watch-pass'; head: string; cursor: string; target: string }
  | { type: 'watch-window'; fromBlock: string; toBlock: string; logs: number; signals: number }
  | { type: 'watch-window-shrunk'; fromBlock: string; toBlock: string; size: string; error: string }
  | { type: 'watch-feed'; event: FeedEvent }
  | { type: 'watch-error'; step: 'head' | 'logs' | 'subscriptions' | 'deferred' | 'process'; error: string }
  | { type: 'watch-pass-done'; head: string; cursor: string; checked: number; queue: number; caughtUp: boolean; done: boolean };

export interface WatchPassResult {
  head: bigint | null;
  /** The first block not read yet. */
  cursor: bigint | null;
  checked: number;
  /** The logs are read up to the target (head - lag, or --to-block). */
  caughtUp: boolean;
  /** Caught up and nothing in the queue is due, or a step failed: the caller may sleep before the next pass. */
  idle: boolean;
  /** Steps that failed in this pass (the head, the logs, a check that threw); each was also a watch-error event. */
  failed: Array<'head' | 'logs' | 'process'>;
  /** --to-block is read and the queue and pending probes are empty: the caller may stop. */
  done: boolean;
}

export interface WatcherInput {
  effects: WatchEffects;
  store: WatchStore;
  sources: readonly WatchSource[];
  config?: Partial<WatchConfig>;
  hooks?: WatchHooks;
  /** getLogs window; default DEFAULT_LOG_WINDOW blocks, shrinking on range errors. */
  window?: LogWindow;
  onEvent?: (e: WatchEvent) => void;
}

interface SignalAt {
  source: FeedSource;
  block: bigint;
  txHash?: Hex;
  factory?: { address: Address; name: string };
}

/**
 * `specfirst watch` (docs/adr/0006): reads the subject chain's logs from a cursor, turns signals into
 * candidates (probed with the ERC-4626 pre-check) and re-checks of known vaults, keeps one queue entry per
 * subject by priority, and per entry checks at head - lag, saves the report under certs/checks, decides
 * whether to attest (the registry's latest Valid attestation of the subject, from any issuer, against the new
 * outcome), attests within the daily budget and hands changes to the alert sink. Never attested: a report
 * with a property the fork RPC could not read (checked again), a check that ran out of time (not retried)
 * and a check older than the latest Valid attestation (checked again at a new block). Every step is a line
 * in feed.ndjson and a rewrite of status.json and vaults.json.
 */
export class Watcher {
  readonly startedAt: string;
  readonly config: WatchConfig;
  head: bigint | null = null;
  running: WatchStatus['running'] = null;
  private readonly effects: WatchEffects;
  private readonly store: WatchStore;
  private readonly sources: readonly WatchSource[];
  private readonly topics: Hex[];
  private readonly window: LogWindow;
  private readonly subscriptionSource: SubscriptionSource;
  private readonly alerts: AlertSink;
  private readonly onEvent: (e: WatchEvent) => void;
  private subs: ActiveSubscription[] = [];
  private subsReadAt = Number.NEGATIVE_INFINITY;
  /** Subjects probed in the current pass: a probe that failed here is retried in the next pass, not at once. */
  private probedThisPass = new Set<string>();

  constructor(i: WatcherInput) {
    this.effects = i.effects;
    this.store = i.store;
    this.sources = i.sources;
    this.config = { ...DEFAULT_WATCH_CONFIG, ...i.config };
    this.topics = signalTopics(i.sources);
    this.window = i.window ?? new LogWindow(DEFAULT_LOG_WINDOW);
    this.subscriptionSource = i.hooks?.subscriptions ?? NO_SUBSCRIPTIONS;
    this.alerts = i.hooks?.alerts ?? NO_ALERTS;
    this.onEvent = i.onEvent ?? (() => {});
    this.startedAt = this.effects.now().toISOString();
    if (i.store.state.chainId !== i.effects.subjectChainId) {
      throw new Error(`the watch store is for chain ${i.store.state.chainId}, the subject chain is ${i.effects.subjectChainId}`);
    }
  }

  private get state() {
    return this.store.state;
  }

  private get chainId(): number {
    return this.effects.subjectChainId;
  }

  private nowIso(): string {
    return this.effects.now().toISOString();
  }

  /** status.json as of now. */
  status(): WatchStatus {
    const now = this.effects.now();
    const since = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
    const recent = this.state.recent.filter((r) => r.at >= since);
    const n = (kind: string) => recent.filter((r) => r.kind === kind).length;
    const today = now.toISOString().slice(0, 10);
    return {
      v: 1,
      chainId: this.chainId,
      head: (this.head ?? 0n).toString(),
      cursor: this.state.cursor ?? (this.head !== null ? checkBlockOf(this.head, this.config.lagBlocks).toString() : '0'),
      lagBlocks: Number(this.config.lagBlocks),
      startedAt: this.startedAt,
      updatedAt: now.toISOString(),
      running: this.running,
      queue: queueOrder(this.state.queue as QueueEntry[]).map((q) => ({ subject: q.subject, source: q.source, enqueuedAt: q.enqueuedAt })),
      counts: {
        known: Object.keys(this.store.vaults.vaults).length,
        detected24h: n('detected'),
        checked24h: n('checked'),
        attested24h: n('attested'),
        changed24h: n('changed'),
      },
      sources: this.sources.map((s) => ({ name: s.name, address: s.address, topic0: s.topic0, seen: this.state.sourcesSeen[s.name] ?? 0 })),
      attestBudget: { perDay: this.config.maxAttestPerDay, usedToday: this.state.attestDay.day === today ? this.state.attestDay.used : 0 },
      gasCostWei: this.state.gasCostWei,
    };
  }

  /** Writes vaults.json, state.json and status.json. */
  async save(): Promise<void> {
    await this.store.save(this.status());
  }

  private emit(e: WatchEvent): void {
    this.onEvent(e);
  }

  private async feed(events: FeedEventInput[]): Promise<FeedEvent[]> {
    const stamped = await this.store.append(events, this.effects.now());
    for (const event of stamped) this.emit({ type: 'watch-feed', event });
    return stamped;
  }

  private setRunning(subject: Address, source: FeedSource, stage: WatchStage): void {
    this.running = { subject, source, stage, startedAt: this.nowIso() };
  }

  /**
   * One pass: read the logs from the cursor to head - lag (or --to-block) and handle their signals, retry
   * failed probes, schedule subscribed and sweep re-checks, attest deferred checks while the budget allows,
   * then run one queue entry (all due entries with drain, as `--once` does). Errors of a step are reported
   * and the pass goes on; nothing is thrown for an RPC failure.
   */
  async pass(opts: { drain?: boolean } = {}): Promise<WatchPassResult> {
    const st = this.state;
    this.probedThisPass = new Set();
    let head: bigint;
    try {
      head = await this.effects.latestBlock();
    } catch (err) {
      this.emit({ type: 'watch-error', step: 'head', error: errorText(err) });
      await this.save();
      const cursor = st.cursor === null ? null : BigInt(st.cursor);
      return { head: this.head, cursor, checked: 0, caughtUp: false, idle: true, done: false, failed: ['head'] };
    }
    const failed: WatchPassResult['failed'] = [];
    this.head = head;
    const safe = checkBlockOf(head, this.config.lagBlocks);
    // Without a cursor (first start, no --from-block) the watcher follows the chain from now on.
    if (st.cursor === null) st.cursor = safe.toString();
    const toBlock = this.config.toBlock;
    const target = toBlock !== null && toBlock < safe ? toBlock : safe;
    const from = BigInt(st.cursor);
    this.emit({ type: 'watch-pass', head: head.toString(), cursor: from.toString(), target: target.toString() });
    if (from <= target) {
      try {
        await readLogWindows({
          getLogs: (f, t, topics) => this.effects.getLogs(f, t, topics),
          topics: this.topics,
          from,
          to: target,
          window: this.window,
          ...(opts.drain ? {} : { maxWindows: this.config.maxWindowsPerPass }),
          onWindow: async ({ fromBlock, toBlock: to, logs }) => {
            const signals = await this.handleLogs(logs, safe);
            st.cursor = (to + 1n).toString();
            this.emit({ type: 'watch-window', fromBlock: fromBlock.toString(), toBlock: to.toString(), logs: logs.length, signals });
            await this.save();
          },
          onShrink: ({ fromBlock, toBlock: to, size, error }) =>
            this.emit({ type: 'watch-window-shrunk', fromBlock: fromBlock.toString(), toBlock: to.toString(), size: size.toString(), error: errorText(error) }),
        });
      } catch (err) {
        failed.push('logs');
        this.emit({ type: 'watch-error', step: 'logs', error: errorText(err) });
      }
    }
    await this.retryProbes(safe);
    await this.refreshSubscriptions();
    await this.scheduleSubscribed(safe);
    await this.scheduleSweep();
    await this.attestDeferred();
    await this.save();

    let checked = 0;
    for (;;) {
      const entry = nextEntry(st.queue as QueueEntry[], this.effects.now());
      if (!entry) break;
      try {
        await this.process(entry);
      } catch (err) {
        // A file that cannot be written, say: the next pass tries again (the entry stays queued unless its
        // check was recorded).
        this.running = null;
        failed.push('process');
        this.emit({ type: 'watch-error', step: 'process', error: errorText(err) });
        break;
      }
      checked++;
      if (!opts.drain) break;
    }
    await this.save();
    const cursor = BigInt(st.cursor);
    const caughtUp = cursor > target;
    const due = nextEntry(st.queue as QueueEntry[], this.effects.now()) !== undefined;
    const done = toBlock !== null && cursor > toBlock && st.queue.length === 0 && Object.keys(st.probing).length === 0;
    this.emit({ type: 'watch-pass-done', head: head.toString(), cursor: cursor.toString(), checked, queue: st.queue.length, caughtUp, done });
    // After a failed step the caller waits a poll interval instead of retrying the same RPC at once.
    return { head, cursor, checked, caughtUp, idle: (caughtUp && !due) || failed.length > 0, done, failed };
  }

  // ---------------------------------------------------------------- signals

  private async handleLogs(logs: readonly SignalLog[], probeBlock: bigint): Promise<number> {
    const sorted = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
    let signals = 0;
    for (const log of sorted) {
      const s = decodeSignal(log, this.sources);
      if (!s) continue;
      signals++;
      this.state.sourcesSeen[s.source.name] = (this.state.sourcesSeen[s.source.name] ?? 0) + 1;
      await this.onSignal(s, probeBlock);
    }
    return signals;
  }

  private recentlyRejected(lower: string): boolean {
    const r = this.state.rejected[lower];
    return !!r && this.effects.now().getTime() - Date.parse(r.at) < this.config.probeRetryAfterMs;
  }

  private async onSignal(s: Signal, probeBlock: bigint): Promise<void> {
    const st = this.state;
    const lower = s.subject.toLowerCase();
    const vault = this.store.vaults.vaults[lower];
    const at: SignalAt = { source: s.source.signal, block: s.block, txHash: s.txHash };
    switch (s.source.signal) {
      case 'factory':
        // A factory announcing a vault is reason enough to probe it again, even after a rejection.
        if (vault) {
          vault.deployBlock ??= s.block.toString();
          return;
        }
        if (st.probing[lower]) return;
        return this.detect(s.subject, { ...at, factory: { address: s.source.address!, name: s.source.name } }, probeBlock);
      case 'deposit':
        if (vault) return this.firstDeposit(s, vault);
        if (!s.source.candidates || st.probing[lower] || this.recentlyRejected(lower)) return;
        return this.detect(s.subject, at, probeBlock);
      case 'upgrade':
      case 'beacon-upgrade':
        if (vault) {
          await this.queueCheck(s.subject, s.source.signal, false, at);
          return;
        }
        if (!s.source.candidates || st.probing[lower]) return;
        return this.detect(s.subject, at, probeBlock);
      case 'implementation': {
        // The emitter is a beacon: every known vault resolving its implementation through it runs new code.
        const affected = Object.keys(st.beacons).filter((v) => st.beacons[v] === lower && this.store.vaults.vaults[v]);
        for (const v of affected.sort()) {
          await this.queueCheck(getAddress(v), 'implementation', false, at, `${s.source.name} ${s.subject} set a new implementation`);
        }
        return;
      }
    }
  }

  /** A known vault's first observed deposit: re-checked once when all its checks predate it (first-deposit). */
  private async firstDeposit(s: Signal, vault: WatchVault): Promise<void> {
    if (vault.firstDepositBlock !== null) return;
    vault.firstDepositBlock = s.block.toString();
    if (vault.lastCheck && BigInt(vault.lastCheck.block) < s.block) {
      await this.queueCheck(s.subject, 'first-deposit', false, { source: 'first-deposit', block: s.block, txHash: s.txHash });
    }
  }

  private async detect(subject: Address, at: SignalAt, probeBlock: bigint): Promise<void> {
    await this.feed([
      {
        at: this.nowIso(),
        kind: 'detected',
        chainId: this.chainId,
        subject,
        source: at.source,
        block: at.block.toString(),
        ...(at.txHash ? { txHash: at.txHash } : {}),
        ...(at.factory ? { factory: at.factory } : {}),
      },
    ]);
    await this.probe(subject, at, probeBlock);
  }

  /**
   * The ERC-4626 pre-check of a candidate at `probeBlock`. Not a vault (only an answer of the contract says
   * so): recorded (probe-rejected) and not retried until a new signal. An RPC or node error, a rate limit
   * included, is never "not a vault": the candidate is probed again from a later pass, the wait doubling from
   * probeRetryMs up to an hour, until it answers. A vault: known from now on and queued as a candidate.
   */
  private async probe(subject: Address, at: SignalAt, probeBlock: bigint): Promise<void> {
    const st = this.state;
    const lower = subject.toLowerCase();
    const base = { chainId: this.chainId, subject, source: at.source, block: at.block.toString(), ...(at.txHash ? { txHash: at.txHash } : {}) };
    this.probedThisPass.add(lower);
    this.setRunning(subject, at.source, 'probing');
    await this.save();
    let result: Erc4626Precheck;
    try {
      result = await this.effects.precheck(subject, probeBlock);
    } catch (err) {
      this.running = null;
      const failures = (st.probing[lower]?.failures ?? 0) + 1;
      const delay = Math.min(this.config.probeRetryMs * 2 ** Math.min(failures - 1, 20), HOUR_MS);
      const notBefore = new Date(this.effects.now().getTime() + delay).toISOString();
      st.probing[lower] = { source: at.source, block: at.block.toString(), ...(at.txHash ? { txHash: at.txHash } : {}), ...(at.factory ? { factory: at.factory } : {}), failures, notBefore };
      await this.feed([{ ...base, at: this.nowIso(), kind: 'error', reason: `probe failed (attempt ${failures}), not a verdict, probing again from ${notBefore}: ${errorText(err)}` }]);
      return;
    }
    this.running = null;
    delete st.probing[lower];
    if (!result.ok) {
      st.rejected[lower] = { at: this.nowIso(), block: probeBlock.toString(), reason: result.reason };
      await this.feed([{ ...base, at: this.nowIso(), kind: 'probe-rejected', reason: result.reason }]);
      return;
    }
    delete st.rejected[lower];
    this.store.vaults.vaults[lower] = {
      firstSeen: { source: at.source, block: at.block.toString(), at: this.nowIso() },
      deployBlock: at.source === 'factory' ? at.block.toString() : null,
      lastCheck: null,
      lastAttestationId: null,
      firstDepositBlock: at.source === 'deposit' ? at.block.toString() : null,
    };
    await this.queueCheck(subject, at.source, true, at);
  }

  private async retryProbes(probeBlock: bigint): Promise<void> {
    for (const [lower, p] of Object.entries(this.state.probing)) {
      if (this.store.vaults.vaults[lower]) {
        delete this.state.probing[lower];
        continue;
      }
      if (this.probedThisPass.has(lower) || (p.notBefore && p.notBefore > this.nowIso())) continue;
      await this.probe(getAddress(lower), { source: p.source, block: BigInt(p.block), ...(p.txHash ? { txHash: p.txHash as Hex } : {}), ...(p.factory ? { factory: p.factory as { address: Address; name: string } } : {}) }, probeBlock);
    }
  }

  private async queueCheck(subject: Address, source: FeedSource, candidate: boolean, at?: SignalAt, reason?: string): Promise<void> {
    const entry: QueueEntry = {
      subject,
      source,
      priority: priorityOf(source, candidate),
      enqueuedAt: this.nowIso(),
      ...(at ? { block: at.block.toString() } : {}),
      ...(at?.txHash ? { txHash: at.txHash } : {}),
      attempts: 0,
    };
    const r = enqueue(this.state.queue as QueueEntry[], entry);
    if (r === 'kept') return;
    await this.feed([
      {
        at: entry.enqueuedAt,
        kind: 'queued',
        chainId: this.chainId,
        subject,
        source,
        ...(entry.block ? { block: entry.block } : {}),
        ...(entry.txHash ? { txHash: entry.txHash } : {}),
        ...(reason ? { reason } : r === 'raised' ? { reason: 'raised to a higher priority' } : {}),
      },
    ]);
  }

  // ---------------------------------------------------------------- schedules

  private async refreshSubscriptions(): Promise<void> {
    const t = this.effects.now().getTime();
    if (t - this.subsReadAt < this.config.subscriptionRefreshMs) return;
    try {
      const all = await this.subscriptionSource.active(this.chainId);
      this.subs = all.filter((s) => s.subjectChainId === BigInt(this.chainId) && s.standardId.toLowerCase() === ERC4626_ID);
      this.subsReadAt = t;
    } catch (err) {
      this.emit({ type: 'watch-error', step: 'subscriptions', error: errorText(err) });
    }
  }

  /** Subscriptions of `subject` that are active now (startsAt <= now < endsAt). */
  private activeSubsFor(subject: Address): ActiveSubscription[] {
    const lower = subject.toLowerCase();
    const now = BigInt(Math.floor(this.effects.now().getTime() / 1000));
    return this.subs.filter((s) => s.subject.toLowerCase() === lower && s.startsAt <= now && now < s.endsAt);
  }

  /** Last time a check of the vault started or was recorded, as ISO, or '' when never. */
  private lastTouched(lower: string): string {
    const a = this.store.vaults.vaults[lower]?.lastCheck?.at ?? '';
    const b = this.state.attempted[lower] ?? '';
    return a > b ? a : b;
  }

  private async scheduleSubscribed(probeBlock: bigint): Promise<void> {
    const subjects = [...new Set(this.subs.map((s) => s.subject.toLowerCase()))].filter((l) => this.activeSubsFor(getAddress(l)).length > 0).sort();
    const cutoff = new Date(this.effects.now().getTime() - this.config.subscribedMinutes * 60_000).toISOString();
    for (const lower of subjects) {
      const subject = getAddress(lower);
      if (!this.store.vaults.vaults[lower]) {
        if (this.state.probing[lower] || this.recentlyRejected(lower)) continue;
        await this.detect(subject, { source: 'subscribed', block: probeBlock }, probeBlock);
        continue;
      }
      const last = this.lastTouched(lower);
      if (!last || last <= cutoff) await this.queueCheck(subject, 'subscribed', false);
    }
  }

  /**
   * At most one sweep entry at a time: the known vault touched longest ago, once its last check (or check
   * attempt) is older than sweepHours, while fewer than sweepPerHour sweep checks started in the last hour.
   */
  private async scheduleSweep(): Promise<void> {
    if (this.config.sweepPerHour <= 0) return;
    const now = this.effects.now().getTime();
    const hourAgo = new Date(now - HOUR_MS).toISOString();
    this.state.sweeps = this.state.sweeps.filter((t) => t >= hourAgo);
    if (this.state.sweeps.length >= this.config.sweepPerHour) return;
    if (this.state.queue.some((q) => q.source === 'sweep')) return;
    const queued = new Set(this.state.queue.map((q) => q.subject.toLowerCase()));
    const cutoff = new Date(now - this.config.sweepHours * HOUR_MS).toISOString();
    let best: { lower: string; t: string } | null = null;
    for (const lower of Object.keys(this.store.vaults.vaults).sort()) {
      if (queued.has(lower) || this.state.probing[lower]) continue;
      const t = this.lastTouched(lower);
      if (t && t > cutoff) continue;
      if (!best || t < best.t) best = { lower, t };
    }
    if (best) await this.queueCheck(getAddress(best.lower), 'sweep', false);
  }

  // ---------------------------------------------------------------- attest budget

  private budgetLeft(): number {
    const day = this.nowIso().slice(0, 10);
    if (this.state.attestDay.day !== day) this.state.attestDay = { day, used: 0 };
    return this.config.maxAttestPerDay - this.state.attestDay.used;
  }

  // ---------------------------------------------------------------- checks

  private async process(entry: QueueEntry): Promise<void> {
    const st = this.state;
    const subject = entry.subject;
    const lower = subject.toLowerCase();
    const startedAt = this.nowIso();
    st.attempted[lower] = startedAt;
    if (entry.source === 'sweep') st.sweeps.push(startedAt);
    this.setRunning(subject, entry.source, 'checking');
    await this.save();

    let report: StandardCheckReport;
    try {
      const block = checkBlockOf(await this.effects.latestBlock(), this.config.lagBlocks);
      report = await this.effects.runCheck(subject, block);
    } catch (err) {
      if (isCheckTimeout(err)) await this.checkTimedOut(entry, err);
      else await this.checkFailed(entry, err);
      return;
    }
    // A property the fork could not read says nothing about the vault: no attestation, check again later.
    const forkErrors = forkRpcErrorsOf(report);
    if (forkErrors.length > 0) {
      await this.checkFailed(entry, new Error(`${forkErrors.length} of ${report.results.length} properties inconclusive on a fork RPC error (${forkErrors[0]!.id}: ${forkErrors[0]!.reason})`));
      return;
    }
    let saved: { reportPath: string; reportURI: string };
    try {
      saved = await this.effects.saveReport(report);
    } catch (err) {
      await this.checkFailed(entry, err);
      return;
    }
    removeEntry(st.queue as QueueEntry[], subject);
    const outcome = outcomeOfReport(report);
    const vault = (this.store.vaults.vaults[lower] ??= {
      firstSeen: { source: entry.source, block: report.blockNumber, at: startedAt },
      deployBlock: null,
      lastCheck: null,
      lastAttestationId: null,
      firstDepositBlock: null,
    });
    // A newer check replaces an attestation still waiting for an older one.
    delete st.deferred[lower];

    const check = feedCheckOf(report, saved.reportPath);
    const base = { chainId: this.chainId, subject, source: entry.source, ...(entry.block ? { block: entry.block } : {}), ...(entry.txHash ? { txHash: entry.txHash } : {}) };
    const defer = () => {
      st.deferred[lower] = { reportPath: saved.reportPath, reportURI: saved.reportURI, source: entry.source, at: this.nowIso() };
    };

    let decision: AttestDecision | null = null;
    let reason: string;
    try {
      const latest = await this.effects.latestAttestation(subject);
      if (latest && ATTESTATION_STATUS[latest.attestation.status] === 'Valid') vault.lastAttestationId = latest.id.toString();
      decision = attestDecision(outcome, latest, BigInt(report.blockNumber));
      reason = decision.reason;
    } catch (err) {
      reason = `the registry could not be read, the attestation decision waits: ${errorText(err)}`;
      if (this.effects.attest) defer();
    }
    let attestNow = false;
    if (decision?.attest) {
      if (!this.effects.attest) reason = `not attested (--no-attest): ${decision.reason}`;
      else if (this.budgetLeft() <= 0) {
        defer();
        reason = `attestation deferred, ${this.state.attestDay.used} of ${this.config.maxAttestPerDay} made today: ${decision.reason}`;
      } else {
        attestNow = true;
        reason = `attesting: ${decision.reason}`;
      }
    }
    const [checked] = await this.feed([{ ...base, at: this.nowIso(), kind: 'checked', check, reason }]);
    let newer = decision && !decision.attest ? decision.newer : undefined;
    let attestation: FeedAttestation | undefined;
    if (attestNow && decision?.attest) {
      const out = await this.attestReport(subject, entry.source, report, saved, decision.supersedes, base, check);
      if (out.attested) attestation = out.attested;
      newer = out.newer;
    }
    if (newer) {
      // Another issuer (the desk worker, say) attested a later block while this check ran: this check is
      // superseded, not failed. It does not become the vault's last check; the vault is checked again.
      vault.lastAttestationId = newer.id.toString();
      this.running = null;
      await this.requeueSuperseded(entry, newer);
      await this.save();
      return;
    }
    if (attestation) vault.lastAttestationId = attestation.id;
    const prev: CheckOutcome | null = vault.lastCheck ? { summary: vault.lastCheck.summary, failed: vault.lastCheck.failed, implementationKey: vault.lastCheck.implementationKey } : null;
    const change = changeOf(prev, outcome);
    vault.lastCheck = lastCheckOf(report, saved.reportPath);
    const beacon = beaconOf(report);
    if (beacon) st.beacons[lower] = beacon;
    else delete st.beacons[lower];
    let changed: FeedEvent | undefined;
    if (change) [changed] = await this.feed([{ ...base, at: this.nowIso(), kind: 'changed', check, change, ...(attestation ? { attestation } : {}) }]);
    this.running = null;
    await this.alert(subject, base, checked!, changed);
    await this.save();
  }

  private async checkFailed(entry: QueueEntry, err: unknown): Promise<void> {
    const st = this.state;
    this.running = null;
    const queued = (st.queue as QueueEntry[]).find((q) => q.subject.toLowerCase() === entry.subject.toLowerCase()) ?? entry;
    queued.attempts += 1;
    const base = { at: this.nowIso(), kind: 'error' as const, chainId: this.chainId, subject: entry.subject, source: entry.source };
    if (queued.attempts >= this.config.maxCheckAttempts) {
      removeEntry(st.queue as QueueEntry[], entry.subject);
      await this.feed([{ ...base, reason: `check failed ${queued.attempts} times, dropped until the next signal or sweep: ${errorText(err)}` }]);
    } else {
      queued.notBefore = new Date(this.effects.now().getTime() + this.config.checkRetryMs * queued.attempts).toISOString();
      await this.feed([{ ...base, reason: `check failed (attempt ${queued.attempts} of ${this.config.maxCheckAttempts}), retrying from ${queued.notBefore}: ${errorText(err)}` }]);
    }
    await this.save();
  }

  /**
   * A check that ran past its wall-clock budget is not retried: a vault that burns gas in its view functions
   * would otherwise hold the queue for the whole budget again and again. The next signal or sweep checks it.
   */
  private async checkTimedOut(entry: QueueEntry, err: unknown): Promise<void> {
    this.running = null;
    removeEntry(this.state.queue as QueueEntry[], entry.subject);
    await this.feed([
      { at: this.nowIso(), kind: 'error', chainId: this.chainId, subject: entry.subject, source: entry.source, reason: `check stopped, not attested and not retried until the next signal or sweep: ${errorText(err)}` },
    ]);
    await this.save();
  }

  /**
   * Queues a superseded check again after checkRetryMs (the head moves past the newer attestation's block
   * meanwhile), counted in attempts so two issuers cannot ping-pong forever.
   */
  private async requeueSuperseded(entry: Pick<QueueEntry, 'subject' | 'source' | 'block' | 'txHash' | 'attempts'>, newer: { id: bigint; block: bigint }): Promise<void> {
    const attempts = entry.attempts + 1;
    const reason = `superseded by attestation ${newer.id} of block ${newer.block}, a later block than this check`;
    if (attempts >= this.config.maxCheckAttempts) {
      await this.feed([{ at: this.nowIso(), kind: 'error', chainId: this.chainId, subject: entry.subject, source: entry.source, reason: `${reason}; ${attempts} times in a row, left to the next signal or sweep` }]);
      return;
    }
    const queued: QueueEntry = {
      subject: entry.subject,
      source: entry.source,
      priority: priorityOf(entry.source, false),
      enqueuedAt: this.nowIso(),
      ...(entry.block ? { block: entry.block } : {}),
      ...(entry.txHash ? { txHash: entry.txHash } : {}),
      attempts,
      notBefore: new Date(this.effects.now().getTime() + this.config.checkRetryMs * attempts).toISOString(),
    };
    const r = enqueue(this.state.queue as QueueEntry[], queued);
    if (r === 'kept') return;
    await this.feed([
      {
        at: queued.enqueuedAt,
        kind: 'queued',
        chainId: this.chainId,
        subject: entry.subject,
        source: entry.source,
        ...(entry.block ? { block: entry.block } : {}),
        ...(entry.txHash ? { txHash: entry.txHash } : {}),
        reason: `${reason}; checking again at a new block`,
      },
    ]);
  }

  /**
   * Checks the subject's identity on its chain at the report's block and attests. An attestation that fails
   * on an RPC error is deferred (the next try decides again from the registry, so a mined transaction whose
   * receipt was lost is not attested twice); OlderThanLatest means another issuer attested a later block
   * meanwhile, so the check is superseded (`newer`, read again from the registry), not failed; any other
   * revert or a report the registry would refuse is recorded.
   */
  private async attestReport(
    subject: Address,
    source: FeedSource,
    report: StandardCheckReport,
    saved: { reportPath: string; reportURI: string },
    supersedes: bigint | null,
    base: Omit<FeedEventInput, 'at' | 'kind'>,
    check: FeedCheck,
  ): Promise<{ attested?: FeedAttestation; newer?: { id: bigint; block: bigint } }> {
    const lower = subject.toLowerCase();
    this.setRunning(subject, source, 'attesting');
    await this.save();
    try {
      const identity = await this.effects.verifySubject(report);
      if (identity.unknownProxy && !this.config.allowUnknownProxy) {
        await this.feed([{ ...base, at: this.nowIso(), kind: 'error', check, reason: `not attested: ${subject} is proxy-shaped but its implementation could not be resolved (--allow-unknown-proxy attests it anyway)` }]);
        return {};
      }
      const params = attestationParamsFromReport(report, { reportURI: saved.reportURI });
      const out = await this.effects.attest!(params);
      this.budgetLeft();
      this.state.attestDay.used += 1;
      this.state.gasCostWei = (BigInt(this.state.gasCostWei) + out.gasCostWei).toString();
      const attestation: FeedAttestation = { id: out.id.toString(), txHash: out.hash, supersedes: supersedes === null ? null : supersedes.toString() };
      await this.feed([{ ...base, at: this.nowIso(), kind: 'attested', check, attestation }]);
      return { attested: attestation };
    } catch (err) {
      if (errorNameOf(err) === 'OlderThanLatest') {
        const latest = await this.effects.latestAttestation(subject).catch(() => null);
        if (latest && ATTESTATION_STATUS[latest.attestation.status] === 'Valid') return { newer: { id: latest.id, block: latest.attestation.blockNumber } };
        // The registry did not answer the second read: decide again in a later pass, which finds the newer one.
        this.state.deferred[lower] = { reportPath: saved.reportPath, reportURI: saved.reportURI, source, at: this.nowIso() };
        return {};
      }
      const retry = !(err instanceof AttestationError) && !countsAsFailure(err);
      if (retry) this.state.deferred[lower] = { reportPath: saved.reportPath, reportURI: saved.reportURI, source, at: this.nowIso() };
      await this.feed([{ ...base, at: this.nowIso(), kind: 'error', check, reason: `attest failed${retry ? ', tried again in a later pass' : ''}: ${errorText(err)}` }]);
      return {};
    } finally {
      this.running = null;
    }
  }

  /**
   * Attestations that waited for the daily budget or for a readable registry, while the budget lasts. Each
   * is decided again first; one whose vault was checked again since is dropped (the newer check decides),
   * and one a later attestation superseded meanwhile is checked again.
   */
  private async attestDeferred(): Promise<void> {
    const st = this.state;
    for (const [lower, d] of Object.entries(st.deferred)) {
      const vault = this.store.vaults.vaults[lower];
      if (!this.effects.attest || !vault?.lastCheck || vault.lastCheck.reportPath !== d.reportPath) {
        delete st.deferred[lower];
        continue;
      }
      if (this.budgetLeft() <= 0) return;
      const subject = getAddress(lower);
      let report: StandardCheckReport;
      let decision: AttestDecision;
      try {
        report = await this.effects.loadReport(d.reportPath);
        const latest = await this.effects.latestAttestation(subject);
        decision = attestDecision(outcomeOfReport(report), latest, BigInt(report.blockNumber));
      } catch (err) {
        this.emit({ type: 'watch-error', step: 'deferred', error: `${subject}: ${errorText(err)}` });
        continue;
      }
      delete st.deferred[lower];
      let newer = decision.attest ? undefined : decision.newer;
      if (decision.attest) {
        const base = { chainId: this.chainId, subject, source: d.source };
        const out = await this.attestReport(subject, d.source, report, d, decision.supersedes, base, feedCheckOf(report, d.reportPath));
        if (out.attested) vault.lastAttestationId = out.attested.id;
        newer = out.newer;
      }
      if (newer) {
        vault.lastAttestationId = newer.id.toString();
        await this.requeueSuperseded({ subject, source: d.source, attempts: 0 }, newer);
      }
      await this.save();
    }
  }

  /**
   * Hands a `changed` event to the alert sink with every active subscription of the subject, or, without a
   * change, the `checked` event to the subscriptions whose first check this is. The sink's `alerted` events
   * are appended to the feed.
   */
  private async alert(subject: Address, base: Omit<FeedEventInput, 'at' | 'kind'>, checked: FeedEvent, changed: FeedEvent | undefined): Promise<void> {
    const subs = this.activeSubsFor(subject);
    if (subs.length === 0) return;
    const fresh = subs.filter((s) => !this.state.subscriptions[s.id.toString()]);
    for (const s of subs) this.state.subscriptions[s.id.toString()] ??= { firstCheckAt: this.nowIso() };
    const event = changed ?? (fresh.length ? checked : undefined);
    if (!event) return;
    try {
      const out = await this.alerts.deliver(event, changed ? subs : fresh);
      await this.feed(out.map(({ v: _v, seq: _seq, ...rest }) => rest));
    } catch (err) {
      await this.feed([{ ...base, at: this.nowIso(), kind: 'error', reason: `alert delivery failed: ${errorText(err)}` }]);
    }
  }
}

function feedCheckOf(report: StandardCheckReport, reportPath: string): FeedCheck {
  const o = outcomeOfReport(report);
  return {
    block: report.blockNumber,
    summary: o.summary,
    failed: o.failed,
    implementationKey: o.implementationKey,
    reportPath,
    reportHash: checkReportHash(report),
    durationMs: report.durationMs,
  };
}

// ---------------------------------------------------------------- live effects

interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | null;
  transactionHash: Hex | null;
  logIndex: Hex | null;
  removed?: boolean;
}

function signalLogsOf(raw: RpcLog[]): SignalLog[] {
  return raw
    .filter((l) => !l.removed && l.blockNumber !== null && l.transactionHash !== null && l.logIndex !== null)
    .map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: BigInt(l.blockNumber!), transactionHash: l.transactionHash!, logIndex: Number(l.logIndex) }));
}

/** eth_getLogs of one emitter and topic0 in one block, for verifySourceFixture against a live RPC. */
export function fixtureLogReader(client: Pick<PublicClient, 'request'>): (q: { address: Address; topic0: Hex; block: bigint }) => Promise<SignalLog[]> {
  return async (q) =>
    signalLogsOf(
      (await client.request({
        method: 'eth_getLogs',
        params: [{ address: q.address, fromBlock: toHex(q.block), toBlock: toHex(q.block), topics: [q.topic0] }],
      } as never)) as RpcLog[],
    );
}

export interface LiveWatchEffectsInput extends SubjectCheckInput {
  subjectClient: StandardCheckClient & SubjectClient & Pick<PublicClient, 'request'>;
  /** reportURI = <reportBaseUrl>/<chainId>/<address>/<block>-<hash8>.json. No trailing slash. */
  reportBaseUrl: string;
  /** Registry on the attest chain, read for every decision; null when there is none (only with attest false). */
  registry: Pick<AttestationRegistryClient, 'latest' | 'attest'> | null;
  /** False with --no-attest: decisions are recorded, nothing is sent. */
  attest: boolean;
  now?: () => Date;
}

/**
 * The effects of a real watcher: reads the subject chain through `subjectClient` (eth_getLogs with the
 * topics as one OR filter), runs the suite as the desk worker does, copies reports to certs/checks and
 * attests through the registry client (whose wallet is the watcher's issuer key).
 */
export function liveWatchEffects(i: LiveWatchEffectsInput): WatchEffects {
  const registry = i.registry;
  return {
    subjectChainId: i.subjectChainId,
    latestBlock: () => i.subjectClient.getBlockNumber({ cacheTime: 0 }),
    getLogs: async (fromBlock, toBlock, topics) => {
      const raw = (await i.subjectClient.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [topics] }],
      } as never)) as RpcLog[];
      return signalLogsOf(raw);
    },
    precheck: (subject, block) => precheckErc4626(i.subjectClient, subject, block),
    runCheck: (subject, block) => runSubjectCheck({ ...i, timeoutSec: i.timeoutSec ?? DEFAULT_WATCH_CHECK_TIMEOUT_SEC }, subject, block),
    saveReport: (report) => saveReportCopy(i.projectDir, i.reportBaseUrl, report),
    loadReport: (reportPath) => loadReportCopy(i.projectDir, reportPath),
    verifySubject: (report) => verifySubjectCode(i.subjectClient, report, { allowUnknownProxy: true }),
    latestAttestation: async (subject) => (registry ? registry.latest(BigInt(i.subjectChainId), subject, ERC4626_ID) : null),
    attest:
      i.attest && registry
        ? async (params) => {
            const out = await registry.attest(params);
            return { id: out.id, hash: out.hash, gasCostWei: out.gasUsed * out.effectiveGasPrice };
          }
        : null,
    now: i.now ?? (() => new Date()),
  };
}
