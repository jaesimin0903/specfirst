import path from 'node:path';
import { concat, createPublicClient, getAddress, http, keccak256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { attestationParamsFromReport, AttestationError, checkReportHash, standardIdOf, type AttestParams } from '../attest/params.js';
import { ATTESTATION_STATUS, type Attestation, type AttestationRegistryClient, type AttestTxState } from '../attest/registry.js';
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
import { isNodeError, isRateLimited, isTransportFailure, TokenBucket } from '../chain/transport.js';
import type { StandardCheckClient } from '../standards/check.js';
import { EIP1967_BEACON_SLOT, EIP1967_IMPLEMENTATION_SLOT } from '../standards/identity.js';
import { forkRpcErrorsOf, type StandardCheckReport } from '../standards/report.js';
import {
  attestClassOf,
  attestDecision,
  changeOf,
  needsConfirmation,
  outcomeOfReport,
  sameOutcome,
  type AttestClass,
  type AttestDecision,
  type CheckOutcome,
} from './decide.js';
import { NO_ALERTS, NO_SUBSCRIPTIONS, type ActiveSubscription, type AlertSink, type SubscriptionSource } from './hooks.js';
import { DEFAULT_LOG_WINDOW, LogsNodeBehindError, LogWindow, readLogWindows } from './logs.js';
import { enqueue, nextEntry, priorityOf, QUEUE_PRIORITY, queueOrder, removeEntry, type QueueEntry } from './queue.js';
import { WATCH_DIR, type FeedAttestation, type FeedCheck, type FeedEvent, type FeedSource, type WatchStage, type WatchStatus, type WatchVault } from './schema.js';
import { decodeSignal, signalTopics, type Signal, type SignalLog, type WatchSource } from './sources.js';
import { beaconOf, lastCheckOf, type FeedEventInput, type WatchStore } from './store.js';

const ERC4626_ID = standardIdOf('erc4626');
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Subject of feed events about the chain rather than a contract (a block the node will not serve). */
export const CHAIN_SUBJECT: Address = '0x0000000000000000000000000000000000000000';

/**
 * Everything the watcher does outside its own files, injected so the loop is testable: the subject chain
 * (head, logs, pre-check, fingerprints, the suite, the identity check), the report copies, the registry and
 * the issuer's balance.
 */
export interface WatchEffects {
  subjectChainId: number;
  latestBlock(): Promise<bigint>;
  /**
   * eth_getLogs over [fromBlock, toBlock] for these topic0 values, from any emitter. Throws LogsNodeBehindError
   * when the node that answers is behind toBlock.
   */
  getLogs(fromBlock: bigint, toBlock: bigint, topics: Hex[]): Promise<SignalLog[]>;
  precheck(subject: Address, block: bigint): Promise<Erc4626Precheck>;
  /**
   * One hash of the code hash and the EIP-1967 implementation and beacon slots at `block`. Without it an
   * Upgraded of a known vault counts as "nothing changed" (the cooldown applies).
   */
  fingerprint?(subject: Address, block: bigint): Promise<Hex>;
  runCheck(subject: Address, block: bigint): Promise<StandardCheckReport>;
  /** Writes the report copy under certs/checks; returns its repository relative path and its public URI. */
  saveReport(report: StandardCheckReport): Promise<{ reportPath: string; reportURI: string }>;
  loadReport(reportPath: string): Promise<StandardCheckReport>;
  /** The public URI of a report copy already under certs/checks (one adopted at start). */
  reportURIOf?(reportPath: string): string;
  /** verifySubjectCode with allowUnknownProxy, so the watcher decides about unknown proxies itself. */
  verifySubject(report: StandardCheckReport): Promise<SubjectCodeCheck>;
  /** The registry's latest attestation of the subject for erc4626, any status, any issuer; null when there is none or no registry. */
  latestAttestation(subject: Address): Promise<{ id: bigint; attestation: Attestation } | null>;
  /** Sends attestations and looks them up; null when attesting is off (--no-attest). */
  attest: WatchAttester | null;
  /** The issuer's balance on the attest chain, read before every send; absent, the floor is not checked. */
  balance?: (() => Promise<bigint>) | null;
  now(): Date;
}

/** Where an attest sent earlier stands; dropped: the node does not know it, and whether its nonce was used since. */
export type WatchAttestTxStatus = Exclude<AttestTxState, { state: 'unknown' }> | { state: 'dropped'; nonceUsed: boolean };

/**
 * Attesting in steps, so the watcher records the transaction between sending it and awaiting its receipt and
 * never sends a second attestation for a receipt it lost.
 */
export interface WatchAttester {
  /** Simulates and sends attest without waiting; `nonce` resends with the nonce of a transaction the node dropped. */
  send(params: AttestParams, opts: { nonce?: number }): Promise<{ hash: Hex; nonce: number }>;
  /** Waits for the receipt of a sent attest and reads the id from it; a revert or a lost receipt throws. */
  wait(hash: Hex): Promise<{ id: bigint; gasCostWei: bigint }>;
  /** Looks a sent attest up without waiting. */
  status(sent: { hash: Hex; nonce: number }): Promise<WatchAttestTxStatus>;
  /** Whether the issuer has transactions the node holds but has not mined. */
  hasPending(): Promise<boolean>;
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
  /** Attestations per UTC day, every class. */
  maxAttestPerDay: number;
  /** Of those, the unsolicited classes (factory, fail, attested-change); subscribed ones only count against the total. */
  maxUnsolicitedPerDay: number;
  /** Attestations of one subject per UTC day. */
  maxAttestPerSubjectPerDay: number;
  /** Below this issuer balance (wei) nothing is sent; status.json says so. */
  minBalanceWei: bigint;
  /** Failed checks of one queue entry before it is dropped (until the next signal or sweep). */
  maxCheckAttempts: number;
  /** Wait before retrying a failed check, times the attempts so far. */
  checkRetryMs: number;
  /** First wait before a probe that failed on an RPC or node error runs again; it doubles up to an hour. */
  probeRetryMs: number;
  /** A non-factory signal from an address the probe rejected probes it again only after this long, unless its code changed. */
  probeRetryAfterMs: number;
  /** Probes (and fingerprint reads) per pass; candidates beyond it are carried to the next pass. */
  maxProbesPerPass: number;
  /** An Upgraded or BeaconUpgraded that changed neither the code nor the EIP-1967 slots re-checks at most this often. */
  upgradeCooldownMs: number;
  /** Wait before the second check that confirms a change. */
  confirmDelayMs: number;
  /** Checks in a row that each disagree with the pending one before the vault is left to the next signal or sweep. */
  maxConfirmAttempts: number;
  /** First wait before a deferred attestation that failed is tried again; it doubles up to an hour. */
  deferredRetryMs: number;
  /** First cooldown of a vault whose check timed out; it doubles with each timeout. */
  timeoutCooldownMs: number;
  /** One error line per key (a subject, a source) at most this often; the rest go to the log only. */
  errorEveryMs: number;
  /** How often the subscription source is read. */
  subscriptionRefreshMs: number;
  /** A subscription read that takes longer is given up (the last result stays in use). */
  subscriptionTimeoutMs: number;
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
  maxAttestPerDay: 15,
  maxUnsolicitedPerDay: 10,
  maxAttestPerSubjectPerDay: 2,
  minBalanceWei: 300_000_000_000_000_000n,
  maxCheckAttempts: 3,
  checkRetryMs: 5 * MINUTE_MS,
  probeRetryMs: 5 * MINUTE_MS,
  probeRetryAfterMs: 24 * HOUR_MS,
  maxProbesPerPass: 20,
  upgradeCooldownMs: 6 * HOUR_MS,
  confirmDelayMs: 2 * MINUTE_MS,
  maxConfirmAttempts: 3,
  deferredRetryMs: MINUTE_MS,
  timeoutCooldownMs: HOUR_MS,
  errorEveryMs: HOUR_MS,
  subscriptionRefreshMs: MINUTE_MS,
  subscriptionTimeoutMs: 30_000,
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
  | { type: 'watch-error'; step: 'head' | 'logs' | 'subscriptions' | 'deferred' | 'process' | 'pass' | 'rate-limited'; error: string }
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
  /** Steps that failed in this pass; each was also a watch-error event. */
  failed: Array<'head' | 'logs' | 'process' | 'pass'>;
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
  /** Reports found in certs/checks at start that are newer than the vault's last check (seedKnownVaults). */
  adopt?: ReadonlyArray<{ subject: string; reportPath: string }>;
  onEvent?: (e: WatchEvent) => void;
}

interface SignalAt {
  source: FeedSource;
  block: bigint;
  txHash?: Hex;
  factory?: { address: Address; name: string };
}

/** What a check that just ran is, for the steps after it. */
interface CheckedEntry {
  subject: Address;
  source: FeedSource;
  block?: string;
  txHash?: Hex;
  attempts: number;
  priority?: number;
}

type AttestResult =
  | { kind: 'attested'; attestation: FeedAttestation }
  | { kind: 'newer'; newer: { id: bigint; block: bigint } }
  | { kind: 'retry'; error: string }
  | { kind: 'refused'; why: 'identity' | 'unknown-proxy' | 'report' | 'revert'; error: string }
  | { kind: 'sent'; hash: Hex };

function nextUtcDay(now: Date): string {
  const d = new Date(now.getTime());
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
}

function mon(wei: bigint): string {
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''} MON`;
}

/**
 * `specfirst watch` (docs/adr/0006): reads the subject chain's logs from a cursor, one topic at a time, turns
 * signals into candidates (probed with the ERC-4626 pre-check, a capped number per pass) and re-checks of
 * known vaults, keeps one queue entry per subject by priority, and per entry checks at head - lag and saves
 * the report under certs/checks. A change against the vault's last check is confirmed by a second check at a
 * later block before anything follows from it. Attesting needs the attest rule (no Valid attestation from any
 * issuer, or another outcome) and a class of the attestation policy (subscribed, factory, fail,
 * attested-change), within the daily budgets, the per-subject cap and the balance floor. Never attested: a
 * report with a property the fork RPC could not read, a check that ran out of time, a check older than the
 * latest Valid attestation. Every step is a line in feed.ndjson; status.json and vaults.json are rewritten
 * once per pass and around each check.
 */
export class Watcher {
  readonly startedAt: string;
  readonly config: WatchConfig;
  head: bigint | null = null;
  running: WatchStatus['running'] = null;
  /** The issuer balance last read before a send, and why nothing is sent when that is so. */
  balanceWei: bigint | null = null;
  paused: string | null = null;
  private readonly effects: WatchEffects;
  private readonly store: WatchStore;
  private readonly sources: readonly WatchSource[];
  private readonly topics: Hex[];
  private readonly window: LogWindow;
  private readonly subscriptionSource: SubscriptionSource;
  private readonly alerts: AlertSink;
  private readonly onEvent: (e: WatchEvent) => void;
  private adoptions: Array<{ subject: string; reportPath: string }>;
  private subs: ActiveSubscription[] = [];
  private subsReadAt = Number.NEGATIVE_INFINITY;
  private subsInFlight: Promise<void> | null = null;
  /** Subjects probed in the current pass: a probe that failed here is retried in a later pass, not at once. */
  private probedThisPass = new Set<string>();
  /** Signals handled in the current pass, by kind and emitter: one Upgraded flood is one signal. */
  private signalsThisPass = new Set<string>();
  /** Probes and fingerprint reads left in the current pass. */
  private probesLeft = 0;

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
    this.adoptions = [...(i.adopt ?? [])];
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

  private today(): string {
    return this.nowIso().slice(0, 10);
  }

  /** status.json as of now. */
  status(): WatchStatus {
    const now = this.effects.now();
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const recent = this.state.recent.filter((r) => r.at >= since);
    const n = (kind: string) => recent.filter((r) => r.kind === kind).length;
    const sameDay = this.state.attestDay.day === now.toISOString().slice(0, 10);
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
      attestBudget: {
        perDay: this.config.maxAttestPerDay,
        usedToday: sameDay ? this.state.attestDay.used : 0,
        unsolicitedPerDay: this.config.maxUnsolicitedPerDay,
        unsolicitedUsedToday: sameDay ? this.state.attestDay.unsolicited : 0,
        perSubjectPerDay: this.config.maxAttestPerSubjectPerDay,
        minBalanceWei: this.config.minBalanceWei.toString(),
        balanceWei: this.balanceWei === null ? null : this.balanceWei.toString(),
        paused: this.effects.attest ? this.paused : 'attesting is off (--no-attest)',
      },
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
    for (const event of stamped) {
      this.emit({ type: 'watch-feed', event });
      if (event.kind === 'checked' && event.check) this.state.checkedBlocks[event.subject.toLowerCase()] = event.check.block;
    }
    return stamped;
  }

  /**
   * An `error` line for `key` (a subject, a source, a topic) unless one was written in the last errorEveryMs:
   * a subject whose sends keep failing, or a flood of undecodable events, writes one line an hour, not one a
   * pass. The rest go to the log (watch-error) only.
   */
  private async errorLine(key: string, event: Omit<FeedEventInput, 'at' | 'kind'>): Promise<void> {
    const last = this.state.errorsAt[key];
    const now = this.effects.now().getTime();
    if (last && now - Date.parse(last) < this.config.errorEveryMs) {
      this.emit({ type: 'watch-error', step: 'rate-limited', error: `${event.subject}: ${event.reason ?? ''}` });
      return;
    }
    this.state.errorsAt[key] = this.nowIso();
    await this.feed([{ ...event, at: this.nowIso(), kind: 'error' }]);
  }

  private setRunning(subject: Address, source: FeedSource, stage: WatchStage): void {
    this.running = { subject, source, stage, startedAt: this.nowIso() };
  }

  /**
   * One pass: read the logs from the cursor to head - lag (or --to-block) and handle their signals, retry and
   * carry probes, schedule subscribed and sweep re-checks, attest deferred checks while the budgets allow, then
   * run one queue entry (all due entries with drain, as `--once` does). Nothing escapes: an unexpected error is
   * recorded and the pass reports it so the caller backs off.
   */
  async pass(opts: { drain?: boolean } = {}): Promise<WatchPassResult> {
    try {
      return await this.passSteps(opts);
    } catch (err) {
      this.running = null;
      this.emit({ type: 'watch-error', step: 'pass', error: errorText(err) });
      try {
        await this.errorLine('pass', { chainId: this.chainId, subject: CHAIN_SUBJECT, reason: `pass failed, backing off: ${errorText(err)}` });
        await this.save();
      } catch {
        /* the files themselves fail: the log line above is all there is */
      }
      const cursor = this.state.cursor === null ? null : BigInt(this.state.cursor);
      return { head: this.head, cursor, checked: 0, caughtUp: false, idle: true, failed: ['pass'], done: false };
    }
  }

  private async passSteps(opts: { drain?: boolean }): Promise<WatchPassResult> {
    const st = this.state;
    this.probedThisPass = new Set();
    this.signalsThisPass = new Set();
    this.probesLeft = this.config.maxProbesPerPass;
    this.pruneRejected();
    this.startSubscriptionRefresh();
    await this.resolveAttesting();
    let head: bigint;
    try {
      head = await this.effects.latestBlock();
    } catch (err) {
      this.emit({ type: 'watch-error', step: 'head', error: errorText(err) });
      await this.save();
      const cursor = st.cursor === null ? null : BigInt(st.cursor);
      return { head: this.head, cursor, checked: 0, caughtUp: false, idle: true, done: false, failed: ['head'] };
    }
    this.head = head;
    const failed: WatchPassResult['failed'] = [];
    await this.settleSubscriptionRefresh();
    const safe = checkBlockOf(head, this.config.lagBlocks);
    // Without a cursor (first start, no --from-block) the watcher follows the chain from now on.
    if (st.cursor === null) st.cursor = safe.toString();
    await this.adoptReports();
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
          },
          onShrink: ({ fromBlock, toBlock: to, size, error }) =>
            this.emit({ type: 'watch-window-shrunk', fromBlock: fromBlock.toString(), toBlock: to.toString(), size: size.toString(), error: errorText(error) }),
          onUnreadable: async ({ block, topic, error }) => {
            const named = this.sources.filter((s) => s.topic0 === topic);
            const subject = named.find((s) => s.address)?.address ?? CHAIN_SUBJECT;
            await this.errorLine(`unreadable:${topic}`, {
              chainId: this.chainId,
              subject,
              block: block.toString(),
              reason: `block ${block}: the node refuses getLogs of ${named.map((s) => s.name).join(', ') || topic} even for one block, passed over: ${errorText(error)}`,
            });
          },
        });
      } catch (err) {
        failed.push('logs');
        this.emit({ type: 'watch-error', step: 'logs', error: errorText(err) });
      }
    }
    await this.save();
    await this.retryProbes(safe);
    await this.settleSubscriptionRefresh();
    await this.scheduleSubscribed(safe);
    await this.scheduleSweep();
    await this.attestDeferred();
    await this.save();

    let checked = 0;
    // A subject is checked at most once a pass: a confirmation due at once waits for the next pass (and block).
    const checkedNow = new Set<string>();
    for (;;) {
      const entry = nextEntry(
        (st.queue as QueueEntry[]).filter((q) => !checkedNow.has(q.subject.toLowerCase())),
        this.effects.now(),
      );
      if (!entry) break;
      checkedNow.add(entry.subject.toLowerCase());
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

  /** Rejections older than the retry window are forgotten: the next signal probes the address again anyway. */
  private pruneRejected(): void {
    const cutoff = this.effects.now().getTime() - this.config.probeRetryAfterMs;
    for (const [lower, r] of Object.entries(this.state.rejected)) if (Date.parse(r.at) < cutoff) delete this.state.rejected[lower];
  }

  // ---------------------------------------------------------------- signals

  private async handleLogs(logs: readonly SignalLog[], probeBlock: bigint): Promise<number> {
    const sorted = [...logs].sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
    let signals = 0;
    for (const log of sorted) {
      const s = decodeSignal(log, this.sources);
      if (!s) {
        await this.noteUndecodable(log);
        continue;
      }
      signals++;
      this.state.sourcesSeen[s.source.name] = (this.state.sourcesSeen[s.source.name] ?? 0) + 1;
      // One signal per kind and subject per pass: fifty Upgraded of one emitter cost what one does.
      const key = `${s.source.signal}:${s.subject.toLowerCase()}`;
      if (this.signalsThisPass.has(key)) continue;
      this.signalsThisPass.add(key);
      await this.onSignal(s, probeBlock);
    }
    return signals;
  }

  /** A log of a factory source that does not decode to an address: an error line per source, at most hourly. */
  private async noteUndecodable(log: SignalLog): Promise<void> {
    const topic0 = log.topics[0]?.toLowerCase();
    const source = this.sources.find((s) => s.signal === 'factory' && s.topic0 === topic0 && s.address?.toLowerCase() === log.address.toLowerCase());
    if (!source) return;
    await this.errorLine(`decode:${source.name}`, {
      chainId: this.chainId,
      subject: source.address!,
      block: log.blockNumber.toString(),
      txHash: log.transactionHash,
      reason: `a ${source.event.name} event of ${source.name} does not decode to a vault address (${source.vault}); passed over`,
    });
  }

  private recentlyRejected(lower: string): boolean {
    const r = this.state.rejected[lower];
    return !!r && this.effects.now().getTime() - Date.parse(r.at) < this.config.probeRetryAfterMs;
  }

  /** The vault's fingerprint now, counted against the probes of the pass; null when it cannot be read. */
  private async fingerprintNow(subject: Address, block: bigint): Promise<Hex | null> {
    if (!this.effects.fingerprint || this.probesLeft <= 0) return null;
    this.probesLeft--;
    try {
      return await this.effects.fingerprint(subject, block);
    } catch {
      return null;
    }
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
        if (vault) return this.upgradeSignal(s, at, probeBlock);
        if (!s.source.candidates || st.probing[lower]) return;
        if (this.recentlyRejected(lower)) {
          // Within the rejection window only a contract whose code or EIP-1967 slots changed is probed again.
          const fp = await this.fingerprintNow(s.subject, probeBlock);
          if (fp === null || fp === st.rejected[lower]!.fingerprint) return;
        }
        return this.detect(s.subject, at, probeBlock);
      case 'implementation': {
        // The emitter is a beacon: every known vault resolving its implementation through it runs new code.
        // Subscribed vaults first, then those with an attestation, then the rest; the budget applies as always.
        const affected = Object.keys(st.beacons).filter((v) => st.beacons[v] === lower && this.store.vaults.vaults[v]);
        const rank = (v: string) => (this.activeSubsFor(getAddress(v)).length ? 0 : this.store.vaults.vaults[v]!.lastAttestationId !== null ? 1 : 2);
        affected.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        for (const v of affected) {
          await this.queueCheck(getAddress(v), 'implementation', false, at, `${s.source.name} ${s.subject} set a new implementation`);
        }
        return;
      }
    }
  }

  /**
   * Upgraded or BeaconUpgraded of a known vault: checked again only when the code hash or an EIP-1967 slot
   * changed since its last check, otherwise at most once per upgradeCooldownMs. A vault that logs Upgraded
   * without upgrading anything buys no checks that way.
   */
  private async upgradeSignal(s: Signal, at: SignalAt, probeBlock: bigint): Promise<void> {
    const lower = s.subject.toLowerCase();
    const stored = this.state.fingerprints[lower];
    const fp = await this.fingerprintNow(s.subject, probeBlock);
    if (fp !== null && fp !== stored) {
      await this.queueCheck(s.subject, s.source.signal, false, at, 'the code or an EIP-1967 slot changed since the last check');
      return;
    }
    const last = this.lastTouched(lower);
    const cutoff = new Date(this.effects.now().getTime() - this.config.upgradeCooldownMs).toISOString();
    if (!last || last <= cutoff) await this.queueCheck(s.subject, s.source.signal, false, at, 'nothing changed since the last check; re-checked at most every 6 hours');
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
    if (this.probesLeft <= 0) {
      // Over the probes of this pass: carried to the next one.
      this.state.probing[subject.toLowerCase()] = {
        source: at.source,
        block: at.block.toString(),
        ...(at.txHash ? { txHash: at.txHash } : {}),
        ...(at.factory ? { factory: at.factory } : {}),
        failures: 0,
        notBefore: this.nowIso(),
      };
      return;
    }
    await this.probe(subject, at, probeBlock);
  }

  /**
   * The ERC-4626 pre-check of a candidate at `probeBlock`. Not a vault (only an answer of the contract says
   * so): recorded (probe-rejected, with the contract's fingerprint) and not probed again within the rejection
   * window unless its code changes. An RPC or node error, a rate limit included, is never "not a vault": the
   * candidate is probed again from a later pass, the wait doubling from probeRetryMs up to an hour, until it
   * answers. A vault: known from now on and queued as a candidate.
   */
  private async probe(subject: Address, at: SignalAt, probeBlock: bigint): Promise<void> {
    const st = this.state;
    const lower = subject.toLowerCase();
    const base = { chainId: this.chainId, subject, source: at.source, block: at.block.toString(), ...(at.txHash ? { txHash: at.txHash } : {}) };
    this.probedThisPass.add(lower);
    this.probesLeft--;
    this.setRunning(subject, at.source, 'probing');
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
      const fingerprint = this.effects.fingerprint ? await this.effects.fingerprint(subject, probeBlock).catch(() => undefined) : undefined;
      st.rejected[lower] = { at: this.nowIso(), block: probeBlock.toString(), reason: result.reason, ...(fingerprint ? { fingerprint } : {}) };
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

  /** Probes that failed on the RPC and candidates carried over the per-pass cap, while probes are left. */
  private async retryProbes(probeBlock: bigint): Promise<void> {
    const now = this.nowIso();
    for (const [lower, p] of Object.entries(this.state.probing)) {
      if (this.store.vaults.vaults[lower]) {
        delete this.state.probing[lower];
        continue;
      }
      if (this.probesLeft <= 0) return;
      if (this.probedThisPass.has(lower) || (p.notBefore && p.notBefore > now)) continue;
      await this.probe(getAddress(lower), { source: p.source, block: BigInt(p.block), ...(p.txHash ? { txHash: p.txHash as Hex } : {}), ...(p.factory ? { factory: p.factory as { address: Address; name: string } } : {}) }, probeBlock);
    }
  }

  /** The cooldown of a vault whose check timed out, while it runs; null otherwise. */
  private cooldownOf(lower: string): string | null {
    const c = this.state.cooldowns[lower];
    return c && c.until > this.nowIso() ? c.until : null;
  }

  private async queueCheck(subject: Address, source: FeedSource, candidate: boolean, at?: SignalAt, reason?: string): Promise<void> {
    // A vault in its timeout cooldown is not queued by any signal or schedule.
    if (this.cooldownOf(subject.toLowerCase())) return;
    const subscribed = this.activeSubsFor(subject).length > 0;
    const entry: QueueEntry = {
      subject,
      source,
      priority: subscribed ? QUEUE_PRIORITY.subscribed : priorityOf(source, candidate),
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

  /** Queues a check after `delayMs` (confirmations, superseded checks), replacing the subject's entry. */
  private async queueLater(entry: CheckedEntry, delayMs: number, attempts: number, reason: string): Promise<void> {
    const queued: QueueEntry = {
      subject: entry.subject,
      source: entry.source,
      priority: entry.priority ?? (this.activeSubsFor(entry.subject).length ? QUEUE_PRIORITY.subscribed : priorityOf(entry.source, false)),
      enqueuedAt: this.nowIso(),
      ...(entry.block ? { block: entry.block } : {}),
      ...(entry.txHash ? { txHash: entry.txHash } : {}),
      attempts,
      notBefore: new Date(this.effects.now().getTime() + delayMs).toISOString(),
    };
    removeEntry(this.state.queue as QueueEntry[], entry.subject);
    enqueue(this.state.queue as QueueEntry[], queued);
    await this.feed([
      {
        at: queued.enqueuedAt,
        kind: 'queued',
        chainId: this.chainId,
        subject: entry.subject,
        source: entry.source,
        ...(entry.block ? { block: entry.block } : {}),
        ...(entry.txHash ? { txHash: entry.txHash } : {}),
        reason,
      },
    ]);
  }

  // ---------------------------------------------------------------- schedules

  /**
   * Starts a subscription read when one is due and none is running. It runs beside the pass: the pass uses
   * the last result, and a read that takes longer than subscriptionTimeoutMs is given up.
   */
  private startSubscriptionRefresh(): void {
    const t = this.effects.now().getTime();
    if (this.subsInFlight || t - this.subsReadAt < this.config.subscriptionRefreshMs) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`subscriptions not read within ${this.config.subscriptionTimeoutMs} ms`)), this.config.subscriptionTimeoutMs);
    });
    const read = Promise.race([this.subscriptionSource.active(this.chainId), timeout])
      .then((all) => {
        this.subs = all.filter((s) => s.subjectChainId === BigInt(this.chainId) && s.standardId.toLowerCase() === ERC4626_ID);
        this.subsReadAt = t;
      })
      .catch((err) => {
        this.emit({ type: 'watch-error', step: 'subscriptions', error: errorText(err) });
      })
      .finally(() => {
        clearTimeout(timer);
        if (this.subsInFlight === read) this.subsInFlight = null;
      });
    this.subsInFlight = read;
  }

  /**
   * Lets a read that is already done land before the subscribed schedule; never waits for a slow one, except
   * the very first read, without which the watcher knows no subscription at all (it is time-boxed like any).
   */
  private async settleSubscriptionRefresh(): Promise<void> {
    if (this.subsReadAt === Number.NEGATIVE_INFINITY && this.subsInFlight) await this.subsInFlight;
    await new Promise<void>((r) => setImmediate(r));
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
    const cutoff = new Date(this.effects.now().getTime() - this.config.subscribedMinutes * MINUTE_MS).toISOString();
    for (const lower of subjects) {
      const subject = getAddress(lower);
      if (!this.store.vaults.vaults[lower]) {
        if (this.state.probing[lower] || this.recentlyRejected(lower)) continue;
        await this.detect(subject, { source: 'subscribed', block: probeBlock }, probeBlock);
        continue;
      }
      if (this.state.pending[lower]) continue;
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
      if (queued.has(lower) || this.state.probing[lower] || this.cooldownOf(lower)) continue;
      const t = this.lastTouched(lower);
      if (t && t > cutoff) continue;
      if (!best || t < best.t) best = { lower, t };
    }
    if (best) await this.queueCheck(getAddress(best.lower), 'sweep', false);
  }

  // ---------------------------------------------------------------- budgets

  private rollDay(): void {
    const day = this.today();
    if (this.state.attestDay.day !== day) this.state.attestDay = { day, used: 0, unsolicited: 0 };
  }

  /**
   * Whether an attestation of class `cls` for `lower` may be sent now: the per-subject cap, the daily total,
   * the smaller daily budget of the unsolicited classes, no attest transaction of the watcher's unresolved and
   * none of the issuer's pending on the node, and the issuer's balance against the floor (read now). When
   * not, why and when to try again; `stopsAll` when nothing else can be sent either.
   */
  private async budgetFor(cls: AttestClass, lower: string): Promise<{ ok: true } | { ok: false; why: string; retryAt: string; stopsAll: boolean }> {
    this.rollDay();
    const day = this.today();
    const tomorrow = nextUtcDay(this.effects.now());
    const subj = this.state.perSubject[lower];
    const usedBySubject = subj && subj.day === day ? subj.used : 0;
    if (usedBySubject >= this.config.maxAttestPerSubjectPerDay) {
      return { ok: false, why: `${usedBySubject} of ${this.config.maxAttestPerSubjectPerDay} attestations of this subject made today`, retryAt: tomorrow, stopsAll: false };
    }
    if (this.state.attestDay.used >= this.config.maxAttestPerDay) {
      return { ok: false, why: `${this.state.attestDay.used} of ${this.config.maxAttestPerDay} attestations made today`, retryAt: tomorrow, stopsAll: false };
    }
    if (cls !== 'subscribed' && this.state.attestDay.unsolicited >= this.config.maxUnsolicitedPerDay) {
      return { ok: false, why: `${this.state.attestDay.unsolicited} of ${this.config.maxUnsolicitedPerDay} unsolicited attestations made today`, retryAt: tomorrow, stopsAll: false };
    }
    const retryAt = new Date(this.effects.now().getTime() + this.config.deferredRetryMs).toISOString();
    const [sent] = Object.values(this.state.attesting);
    if (sent) return { ok: false, why: `attest tx ${sent.hash} sent earlier is not mined yet`, retryAt, stopsAll: true };
    if (this.effects.attest) {
      try {
        if (await this.effects.attest.hasPending()) return { ok: false, why: 'the issuer has transactions the node has not mined', retryAt, stopsAll: true };
      } catch (err) {
        return { ok: false, why: `the issuer's pending transactions could not be read: ${errorText(err)}`, retryAt, stopsAll: true };
      }
    }
    if (this.effects.balance) {
      try {
        this.balanceWei = await this.effects.balance();
      } catch (err) {
        return { ok: false, why: `the issuer balance could not be read: ${errorText(err)}`, retryAt, stopsAll: true };
      }
      if (this.balanceWei < this.config.minBalanceWei) {
        this.paused = `issuer balance ${mon(this.balanceWei)} is below the floor of ${mon(this.config.minBalanceWei)}: nothing is sent`;
        return { ok: false, why: this.paused, retryAt: new Date(this.effects.now().getTime() + HOUR_MS).toISOString(), stopsAll: true };
      }
      this.paused = null;
    }
    return { ok: true };
  }

  private countAttestation(cls: AttestClass, lower: string, gasCostWei: bigint): void {
    this.rollDay();
    const day = this.today();
    this.state.attestDay.used += 1;
    if (cls !== 'subscribed') this.state.attestDay.unsolicited += 1;
    const subj = this.state.perSubject[lower];
    this.state.perSubject[lower] = { day, used: subj && subj.day === day ? subj.used + 1 : 1 };
    for (const [k, v] of Object.entries(this.state.perSubject)) if (v.day !== day) delete this.state.perSubject[k];
    this.addGas(gasCostWei);
  }

  private addGas(gasCostWei: bigint): void {
    this.state.gasCostWei = (BigInt(this.state.gasCostWei) + gasCostWei).toString();
  }

  // ---------------------------------------------------------------- checks

  private async process(entry: QueueEntry): Promise<void> {
    const st = this.state;
    const subject = entry.subject;
    const lower = subject.toLowerCase();
    if (this.cooldownOf(lower)) {
      removeEntry(st.queue as QueueEntry[], subject);
      return;
    }
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
    delete st.cooldowns[lower];
    if (this.effects.fingerprint) {
      const fp = await this.effects.fingerprint(subject, BigInt(report.blockNumber)).catch(() => null);
      if (fp) st.fingerprints[lower] = fp;
    }
    await this.afterCheck(entry, report, saved);
  }

  /**
   * Reports newer than a vault's last check found in certs/checks at start (a desk check, say) go through the
   * same steps as a check of the watcher's own: the change decision, the policy, alerts.
   */
  private async adoptReports(): Promise<void> {
    while (this.adoptions.length) {
      const a = this.adoptions.shift()!;
      const subject = getAddress(a.subject);
      let report: StandardCheckReport;
      try {
        report = await this.effects.loadReport(a.reportPath);
      } catch (err) {
        this.emit({ type: 'watch-error', step: 'process', error: `${a.reportPath}: ${errorText(err)}` });
        continue;
      }
      if (!this.store.vaults.vaults[a.subject]) continue;
      const reportURI = this.effects.reportURIOf ? this.effects.reportURIOf(a.reportPath) : a.reportPath;
      await this.afterCheck({ subject, source: 'backfill', attempts: 0 }, report, { reportPath: a.reportPath, reportURI }, 'adopted from certs/checks (a check made outside the watcher)');
    }
  }

  /**
   * What follows a saved report: the change against the vault's last confirmed check (a change waits for a
   * second check at a later block), the attest rule against the registry, the attestation policy and the
   * budgets, the attestation, the last check, the change event and the alerts.
   */
  private async afterCheck(entry: CheckedEntry, report: StandardCheckReport, saved: { reportPath: string; reportURI: string }, note?: string): Promise<void> {
    const st = this.state;
    const subject = entry.subject;
    const lower = subject.toLowerCase();
    const vault = (this.store.vaults.vaults[lower] ??= {
      firstSeen: { source: entry.source, block: report.blockNumber, at: this.nowIso() },
      deployBlock: null,
      lastCheck: null,
      lastAttestationId: null,
      firstDepositBlock: null,
    });
    // A newer check replaces an attestation still waiting for an older one.
    delete st.deferred[lower];
    const outcome = outcomeOfReport(report);
    const prev: CheckOutcome | null = vault.lastCheck ? { summary: vault.lastCheck.summary, failed: vault.lastCheck.failed, implementationKey: vault.lastCheck.implementationKey } : null;
    const change = changeOf(prev, outcome);
    const check = feedCheckOf(report, saved.reportPath);
    const base = { chainId: this.chainId, subject, source: entry.source, ...(entry.block ? { block: entry.block } : {}), ...(entry.txHash ? { txHash: entry.txHash } : {}) };
    const prefix = note ? `${note}; ` : '';
    const pending = st.pending[lower];
    let firstCheck = vault.lastCheck === null;
    let confirmation = '';

    if (needsConfirmation(change, outcome)) {
      const agrees = !!pending && sameOutcome(pending.outcome as CheckOutcome, outcome);
      if (agrees && BigInt(report.blockNumber) > BigInt(pending!.block)) {
        firstCheck = pending!.firstCheck;
        delete st.pending[lower];
        confirmation = `confirmed by a second check at block ${report.blockNumber} after block ${pending!.block}; `;
      } else {
        // Agreeing at the same block confirms nothing and counts nothing; disagreeing counts toward the limit.
        const attempts = !pending ? 1 : agrees ? pending.attempts : pending.attempts + 1;
        this.running = null;
        if (attempts > this.config.maxConfirmAttempts) {
          delete st.pending[lower];
          await this.feed([{ ...base, at: this.nowIso(), kind: 'checked', check, reason: `${prefix}not attested [confirm]: ${attempts} checks in a row without two agreeing; left to the next signal or sweep` }]);
          await this.save();
          return;
        }
        st.pending[lower] = {
          reportPath: saved.reportPath,
          reportURI: saved.reportURI,
          block: report.blockNumber,
          at: this.nowIso(),
          outcome: { summary: { ...outcome.summary }, failed: [...outcome.failed], implementationKey: outcome.implementationKey },
          source: entry.source,
          firstCheck: pending?.firstCheck ?? firstCheck,
          attempts,
        };
        const what = change!.kind === 'new' ? 'a failed property in a first check' : `${change!.kind} against the last check`;
        await this.feed([{ ...base, at: this.nowIso(), kind: 'checked', check, reason: `${prefix}pending confirmation [confirm]: ${what}; nothing follows until a second check at a later block agrees` }]);
        await this.queueLater(entry, this.config.confirmDelayMs, 0, `confirmation of block ${report.blockNumber}`);
        await this.save();
        return;
      }
    } else if (pending) {
      delete st.pending[lower];
      confirmation = `the change pending since block ${pending.block} was not confirmed; `;
    }

    const defer = (cls: AttestClass, notBefore: string, failures = 0) => {
      st.deferred[lower] = { reportPath: saved.reportPath, reportURI: saved.reportURI, source: entry.source, at: this.nowIso(), cls, failures, notBefore };
    };
    let decision: AttestDecision | null = null;
    let latestValid = false;
    let registryError = '';
    try {
      const latest = await this.effects.latestAttestation(subject);
      latestValid = !!latest && ATTESTATION_STATUS[latest.attestation.status] === 'Valid';
      if (latest && latestValid) vault.lastAttestationId = latest.id.toString();
      decision = attestDecision(outcome, latest, BigInt(report.blockNumber));
    } catch (err) {
      registryError = errorText(err);
    }
    if (decision && !decision.attest && decision.newer) {
      await this.feed([{ ...base, at: this.nowIso(), kind: 'checked', check, reason: `${prefix}${confirmation}not attested [newer]: ${decision.reason}` }]);
      await this.superseded(entry, vault, decision.newer);
      return;
    }

    const subs = this.activeSubsFor(subject);
    const fresh = subs.filter((s) => !st.subscriptions[s.id.toString()]);
    const policy = attestClassOf({
      subscribed: subs.length > 0,
      firstSinceSubscription: fresh.length > 0,
      confirmedChange: change !== null && change.kind !== 'new',
      factoryVault: vault.firstSeen.source === 'factory',
      firstCheck,
      firstDeposit: entry.source === 'first-deposit',
      hasFail: outcome.summary.fail > 0,
      hasValidAttestation: latestValid,
    });
    let reason: string;
    let attestAs: AttestClass | null = null;
    if (!decision) {
      reason = `not attested [registry]: the registry could not be read, the decision waits: ${registryError}`;
      if (this.effects.attest && policy.cls) defer(policy.cls, new Date(this.effects.now().getTime() + this.config.deferredRetryMs).toISOString());
    } else if (!decision.attest) {
      reason = `not attested [unchanged]: ${decision.reason}`;
    } else if (!policy.cls) {
      reason = `not attested [policy]: ${policy.why}`;
    } else if (!this.effects.attest) {
      reason = `not attested [no-attest]: would attest as ${policy.cls} (${policy.why}); ${decision.reason}`;
    } else {
      const budget = await this.budgetFor(policy.cls, lower);
      if (!budget.ok) {
        defer(policy.cls, budget.retryAt);
        reason = `attestation deferred [${policy.cls}]: ${budget.why}; ${decision.reason}`;
      } else {
        attestAs = policy.cls;
        reason = `attesting [${policy.cls}]: ${policy.why}; ${decision.reason}`;
      }
    }
    const [checked] = await this.feed([{ ...base, at: this.nowIso(), kind: 'checked', check, reason: `${prefix}${confirmation}${reason}` }]);

    let attestation: FeedAttestation | undefined;
    if (attestAs && decision?.attest) {
      const out = await this.attestReport(subject, entry.source, report, saved, decision.supersedes, attestAs, base, check);
      if (out.kind === 'attested') {
        attestation = out.attestation;
        vault.lastAttestationId = attestation.id;
      } else if (out.kind === 'newer') {
        await this.superseded(entry, vault, out.newer);
        return;
      } else if (out.kind === 'refused' && out.why === 'identity') {
        // The identity on the chain is not the report's: this report is not the vault's last check.
        await this.checkFailed({ ...entry, priority: entry.priority ?? priorityOf(entry.source, false), enqueuedAt: this.nowIso() } as QueueEntry, new Error(`identity check refused the report: ${out.error}`));
        return;
      } else if (out.kind === 'retry') {
        defer(attestAs, new Date(this.effects.now().getTime() + this.config.deferredRetryMs).toISOString(), 1);
      }
    }
    vault.lastCheck = lastCheckOf(report, saved.reportPath);
    const beacon = beaconOf(report);
    if (beacon) st.beacons[lower] = beacon;
    else delete st.beacons[lower];
    let changed: FeedEvent | undefined;
    if (change) [changed] = await this.feed([{ ...base, at: this.nowIso(), kind: 'changed', check, change, ...(attestation ? { attestation } : {}) }]);
    this.running = null;
    await this.alert(subject, base, checked!, changed, subs, fresh);
    await this.save();
  }

  /**
   * Another issuer (the desk worker, say) attested a later block while this check ran: the check is
   * superseded, not failed. It does not become the vault's last check, gives no change event and no alert;
   * the vault is checked again at a new block after the retry delay, counted so two issuers cannot ping-pong.
   */
  private async superseded(entry: CheckedEntry, vault: WatchVault, newer: { id: bigint; block: bigint }): Promise<void> {
    vault.lastAttestationId = newer.id.toString();
    this.running = null;
    const attempts = entry.attempts + 1;
    const reason = `superseded by attestation ${newer.id} of block ${newer.block}, a later block than this check`;
    if (attempts >= this.config.maxCheckAttempts) {
      await this.feed([{ at: this.nowIso(), kind: 'error', chainId: this.chainId, subject: entry.subject, source: entry.source, reason: `${reason}; ${attempts} times in a row, left to the next signal or sweep` }]);
    } else {
      await this.queueLater(entry, this.config.checkRetryMs * attempts, attempts, `${reason}; checking again at a new block`);
    }
    await this.save();
  }

  private async checkFailed(entry: QueueEntry, err: unknown): Promise<void> {
    const st = this.state;
    this.running = null;
    const queued = (st.queue as QueueEntry[]).find((q) => q.subject.toLowerCase() === entry.subject.toLowerCase());
    const attempts = (queued?.attempts ?? entry.attempts) + 1;
    const base = { at: this.nowIso(), kind: 'error' as const, chainId: this.chainId, subject: entry.subject, source: entry.source };
    if (attempts >= this.config.maxCheckAttempts) {
      removeEntry(st.queue as QueueEntry[], entry.subject);
      await this.feed([{ ...base, reason: `check failed ${attempts} times, dropped until the next signal or sweep: ${errorText(err)}` }]);
    } else {
      const notBefore = new Date(this.effects.now().getTime() + this.config.checkRetryMs * attempts).toISOString();
      if (queued) {
        queued.attempts = attempts;
        queued.notBefore = notBefore;
      } else {
        enqueue(st.queue as QueueEntry[], { subject: entry.subject, source: entry.source, priority: entry.priority, enqueuedAt: this.nowIso(), attempts, notBefore });
      }
      await this.feed([{ ...base, reason: `check failed (attempt ${attempts} of ${this.config.maxCheckAttempts}), retrying from ${notBefore}: ${errorText(err)}` }]);
    }
    await this.save();
  }

  /**
   * A check that ran past its wall-clock budget is not retried, and the vault cools down: no signal, schedule
   * or subscription queues it before the cooldown ends, an hour after the first timeout and twice as long
   * after each one more. A vault that burns gas in its view functions would otherwise hold the queue again
   * and again.
   */
  private async checkTimedOut(entry: QueueEntry, err: unknown): Promise<void> {
    this.running = null;
    const lower = entry.subject.toLowerCase();
    const timeouts = (this.state.cooldowns[lower]?.timeouts ?? 0) + 1;
    const until = new Date(this.effects.now().getTime() + this.config.timeoutCooldownMs * 2 ** Math.min(timeouts - 1, 20)).toISOString();
    this.state.cooldowns[lower] = { until, timeouts };
    removeEntry(this.state.queue as QueueEntry[], entry.subject);
    await this.feed([
      {
        at: this.nowIso(),
        kind: 'error',
        chainId: this.chainId,
        subject: entry.subject,
        source: entry.source,
        reason: `check stopped, not attested and not retried; no check of it before ${until} (timeout ${timeouts}): ${errorText(err)}`,
      },
    ]);
    await this.save();
  }

  /**
   * Checks the subject's identity on its chain at the report's block and attests, counting the attestation
   * against the budgets once it is mined. The transaction goes into state.attesting before its receipt is
   * awaited: a receipt that does not come is `sent`, and the next pass looks the transaction up instead of
   * sending again. An RPC failure or a send that did not go through without a revert is `retry` (the next try
   * decides again from the registry); OlderThanLatest means another issuer attested a later block meanwhile
   * (`newer`, read again from the registry); an identity mismatch, an unknown proxy, a report the registry
   * would refuse and any other revert are `refused`. `nonce` resends with the nonce of a dropped transaction.
   */
  private async attestReport(
    subject: Address,
    source: FeedSource,
    report: StandardCheckReport,
    saved: { reportPath: string; reportURI: string },
    supersedes: bigint | null,
    cls: AttestClass,
    base: Omit<FeedEventInput, 'at' | 'kind'>,
    check: FeedCheck,
    nonce?: number,
  ): Promise<AttestResult> {
    const lower = subject.toLowerCase();
    this.setRunning(subject, source, 'attesting');
    await this.save();
    try {
      let identity: SubjectCodeCheck;
      try {
        identity = await this.effects.verifySubject(report);
      } catch (err) {
        if (err instanceof AttestationError) return { kind: 'refused', why: 'identity', error: errorText(err) };
        throw err;
      }
      if (identity.unknownProxy && !this.config.allowUnknownProxy) {
        const error = `not attested: ${subject} is proxy-shaped but its implementation could not be resolved (--allow-unknown-proxy attests it anyway)`;
        await this.errorLine(lower, { ...base, check, reason: error });
        return { kind: 'refused', why: 'unknown-proxy', error };
      }
      let params: AttestParams;
      try {
        params = attestationParamsFromReport(report, { reportURI: saved.reportURI });
      } catch (err) {
        if (err instanceof AttestationError) {
          await this.errorLine(lower, { ...base, check, reason: `not attested: ${err.message}` });
          return { kind: 'refused', why: 'report', error: err.message };
        }
        throw err;
      }
      const attester = this.effects.attest!;
      const sent = await attester.send(params, nonce !== undefined ? { nonce } : {});
      // Recorded before the receipt is awaited: a crash or a lost receipt from here on is resolved by looking
      // this transaction up, never by sending a second attestation.
      this.state.attesting[lower] = {
        hash: sent.hash,
        nonce: sent.nonce,
        at: this.nowIso(),
        reportPath: saved.reportPath,
        reportURI: saved.reportURI,
        block: report.blockNumber,
        source,
        cls,
        supersedes: supersedes === null ? null : supersedes.toString(),
      };
      await this.save();
      let mined: { id: bigint; gasCostWei: bigint };
      try {
        mined = await attester.wait(sent.hash);
      } catch (err) {
        await this.errorLine(lower, { ...base, check, reason: `attest tx ${sent.hash} was sent, its receipt is looked up in the next pass: ${errorText(err)}` });
        return { kind: 'sent', hash: sent.hash };
      }
      delete this.state.attesting[lower];
      const attestation = await this.recordAttested(lower, cls, { id: mined.id, hash: sent.hash, gasCostWei: mined.gasCostWei, supersedes }, base, check);
      await this.save();
      return { kind: 'attested', attestation };
    } catch (err) {
      if (errorNameOf(err) === 'OlderThanLatest') {
        const latest = await this.effects.latestAttestation(subject).catch(() => null);
        if (latest && ATTESTATION_STATUS[latest.attestation.status] === 'Valid') return { kind: 'newer', newer: { id: latest.id, block: latest.attestation.blockNumber } };
        // The registry did not answer the second read: decide again in a later pass, which finds the newer one.
        return { kind: 'retry', error: errorText(err) };
      }
      if (countsAsFailure(err)) {
        await this.errorLine(lower, { ...base, check, reason: `attest failed: ${errorText(err)}` });
        return { kind: 'refused', why: 'revert', error: errorText(err) };
      }
      const retryAt = new Date(this.effects.now().getTime() + this.config.deferredRetryMs).toISOString();
      await this.errorLine(lower, { ...base, check, reason: `attest failed, tried again from ${retryAt}: ${errorText(err)}` });
      return { kind: 'retry', error: errorText(err) };
    } finally {
      this.running = null;
    }
  }

  /** Counts a mined attestation against the budgets, adds its gas and writes the `attested` event. */
  private async recordAttested(
    lower: string,
    cls: AttestClass,
    tx: { id: bigint; hash: Hex; gasCostWei: bigint; supersedes: bigint | null },
    base: Omit<FeedEventInput, 'at' | 'kind'>,
    check: FeedCheck | undefined,
    note = '',
  ): Promise<FeedAttestation> {
    this.countAttestation(cls, lower, tx.gasCostWei);
    const attestation: FeedAttestation = { id: tx.id.toString(), txHash: tx.hash, supersedes: tx.supersedes === null ? null : tx.supersedes.toString() };
    await this.feed([{ ...base, at: this.nowIso(), kind: 'attested', ...(check ? { check } : {}), attestation, reason: `[${cls}]${note}` }]);
    return attestation;
  }

  /**
   * Attest transactions whose receipt an earlier pass did not see (lost, or the watcher stopped while it
   * waited) are looked up before anything else. mined: recorded and counted as if the receipt had come.
   * reverted: its gas is counted and the attestation is decided again after a wait, at most maxCheckAttempts
   * reverts in a row. pending: it waits, and nothing else is sent meanwhile. dropped: decided again now, sent
   * with the same nonce when that nonce is still unused (so at most one of the two can be mined); when another
   * transaction used it, the registry read of the new decision finds any attestation of this report that landed.
   */
  private async resolveAttesting(): Promise<void> {
    const st = this.state;
    if (!this.effects.attest || Object.keys(st.attesting).length === 0) return;
    for (const [lower, a] of Object.entries(st.attesting)) {
      const subject = getAddress(lower);
      let tx: WatchAttestTxStatus;
      try {
        tx = await this.effects.attest.status({ hash: a.hash as Hex, nonce: a.nonce });
      } catch (err) {
        this.emit({ type: 'watch-error', step: 'deferred', error: `${subject}: attest tx ${a.hash} could not be looked up: ${errorText(err)}` });
        continue;
      }
      if (tx.state === 'pending') continue;
      delete st.attesting[lower];
      const base = { chainId: this.chainId, subject, source: a.source };
      const check = await this.effects.loadReport(a.reportPath).then(
        (r) => feedCheckOf(r, a.reportPath),
        () => undefined,
      );
      const d = st.deferred[lower];
      if (tx.state === 'mined') {
        const supersedes = a.supersedes === null ? null : BigInt(a.supersedes);
        const attestation = await this.recordAttested(lower, a.cls, { id: tx.id, hash: a.hash as Hex, gasCostWei: tx.gasCostWei, supersedes }, base, check, '; its receipt was found in a later pass');
        const vault = this.store.vaults.vaults[lower];
        if (vault) vault.lastAttestationId = attestation.id;
        if (d?.reportPath === a.reportPath) delete st.deferred[lower];
        continue;
      }
      const failures = (d?.reportPath === a.reportPath ? d.failures : 0) + (tx.state === 'reverted' ? 1 : 0);
      let notBefore = this.nowIso();
      if (tx.state === 'reverted') {
        this.addGas(tx.gasCostWei);
        if (failures >= this.config.maxCheckAttempts) {
          delete st.deferred[lower];
          await this.errorLine(lower, { ...base, ...(check ? { check } : {}), reason: `attest tx ${a.hash} reverted, ${failures} times in a row: not attested` });
          continue;
        }
        notBefore = new Date(this.effects.now().getTime() + Math.min(this.config.deferredRetryMs * 2 ** Math.min(failures - 1, 20), HOUR_MS)).toISOString();
        await this.errorLine(lower, { ...base, ...(check ? { check } : {}), reason: `attest tx ${a.hash} reverted (${failures} of ${this.config.maxCheckAttempts}), decided again from ${notBefore}` });
      }
      const resend = tx.state === 'dropped' && !tx.nonceUsed ? { nonce: a.nonce } : {};
      st.deferred[lower] = { reportPath: a.reportPath, reportURI: a.reportURI, source: a.source, at: this.nowIso(), cls: a.cls, failures, notBefore, ...resend };
    }
    await this.save();
  }

  /**
   * Attestations that wait (a budget, the balance floor, an RPC failure), each from its own retry time, the
   * wait after a failure doubling from deferredRetryMs up to an hour. Each is decided again first; one whose
   * vault was checked again since is dropped (the newer check decides), one a later attestation superseded is
   * checked again. Below the balance floor nothing is tried.
   */
  private async attestDeferred(): Promise<void> {
    const st = this.state;
    const entries = Object.entries(st.deferred).sort((a, b) => (a[1].notBefore ?? '').localeCompare(b[1].notBefore ?? ''));
    for (const [lower, d] of entries) {
      const vault = this.store.vaults.vaults[lower];
      if (!this.effects.attest || !vault?.lastCheck || vault.lastCheck.reportPath !== d.reportPath || !d.cls) {
        delete st.deferred[lower];
        continue;
      }
      if (d.notBefore && d.notBefore > this.nowIso()) continue;
      const subject = getAddress(lower);
      const backoff = (error: string) => {
        const failures = d.failures + 1;
        const wait = Math.min(this.config.deferredRetryMs * 2 ** Math.min(failures - 1, 20), HOUR_MS);
        st.deferred[lower] = { ...d, failures, notBefore: new Date(this.effects.now().getTime() + wait).toISOString() };
        this.emit({ type: 'watch-error', step: 'deferred', error: `${subject}: ${error}` });
      };
      let report: StandardCheckReport;
      let decision: AttestDecision;
      try {
        report = await this.effects.loadReport(d.reportPath);
        const latest = await this.effects.latestAttestation(subject);
        decision = attestDecision(outcomeOfReport(report), latest, BigInt(report.blockNumber));
      } catch (err) {
        backoff(errorText(err));
        continue;
      }
      if (!decision.attest) {
        delete st.deferred[lower];
        if (decision.newer) await this.superseded({ subject, source: d.source, attempts: 0 }, vault, decision.newer);
        continue;
      }
      const budget = await this.budgetFor(d.cls, lower);
      if (!budget.ok) {
        st.deferred[lower] = { ...d, notBefore: budget.retryAt };
        if (budget.stopsAll) return;
        continue;
      }
      const base = { chainId: this.chainId, subject, source: d.source };
      const out = await this.attestReport(subject, d.source, report, d, decision.supersedes, d.cls, base, feedCheckOf(report, d.reportPath), d.nonce);
      if (out.kind === 'retry') {
        backoff(out.error);
        continue;
      }
      delete st.deferred[lower];
      if (out.kind === 'attested') vault.lastAttestationId = out.attestation.id;
      if (out.kind === 'newer') await this.superseded({ subject, source: d.source, attempts: 0 }, vault, out.newer);
    }
  }

  /**
   * Hands a confirmed `changed` event to the alert sink with every active subscription of the subject, or,
   * without a change, the `checked` event to the subscriptions whose first check this is. The sink's
   * `alerted` events are appended to the feed.
   */
  private async alert(
    subject: Address,
    base: Omit<FeedEventInput, 'at' | 'kind'>,
    checked: FeedEvent,
    changed: FeedEvent | undefined,
    subs: ActiveSubscription[],
    fresh: ActiveSubscription[],
  ): Promise<void> {
    if (subs.length === 0) return;
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

/**
 * The watcher's fuzz seed of a subject: the same inputs on every check of it, so a result moves only when the
 * vault's state does, not with the luck of a random seed.
 */
export function watchFuzzSeedOf(subject: Address, standard = 'erc4626'): bigint {
  return BigInt(keccak256(toHex(`specfirst-watch:${standard}:${subject.toLowerCase()}`)));
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

/**
 * getLogs over the subject RPCs, primary first: eth_blockNumber and eth_getLogs go to one URL in one batched
 * request, so the head that is compared is the head of the node that answered. A node behind toBlock throws
 * LogsNodeBehindError with its head. A transport failure, a rate limit or a node error moves on to the next
 * URL, as the read client does; anything else (a range error) is thrown.
 */
export function batchedLogsReader(urls: readonly string[], opts: { rps?: number; timeoutMs?: number } = {}): (fromBlock: bigint, toBlock: bigint, topics: Hex[]) => Promise<SignalLog[]> {
  const bucket = new TokenBucket(opts.rps ?? 10);
  const clients = urls.map((url) => createPublicClient({ transport: http(url, { batch: true, retryCount: 0, timeout: opts.timeoutMs ?? 30_000 }) }));
  return async (fromBlock, toBlock, topics) => {
    let last: unknown;
    for (const client of clients) {
      await bucket.acquire();
      try {
        const [head, raw] = await Promise.all([
          client.request({ method: 'eth_blockNumber' } as never) as Promise<Hex>,
          client.request({ method: 'eth_getLogs', params: [{ fromBlock: toHex(fromBlock), toBlock: toHex(toBlock), topics: [topics] }] } as never) as Promise<RpcLog[]>,
        ]);
        if (BigInt(head) < toBlock) throw new LogsNodeBehindError(BigInt(head));
        return signalLogsOf(raw);
      } catch (err) {
        last = err;
        if (err instanceof LogsNodeBehindError) throw err;
        if (isTransportFailure(err) || isRateLimited(err) || isNodeError(err)) continue;
        throw err;
      }
    }
    throw last;
  };
}

/** One hash of the code hash and the EIP-1967 implementation and beacon slots of `subject` at `block`. */
export async function fingerprintOf(client: Pick<PublicClient, 'getCode' | 'getStorageAt'>, subject: Address, block: bigint): Promise<Hex> {
  const [code, impl, beacon] = await Promise.all([
    client.getCode({ address: subject, blockNumber: block }),
    client.getStorageAt({ address: subject, slot: EIP1967_IMPLEMENTATION_SLOT, blockNumber: block }),
    client.getStorageAt({ address: subject, slot: EIP1967_BEACON_SLOT, blockNumber: block }),
  ]);
  const zero: Hex = `0x${'00'.repeat(32)}`;
  return keccak256(concat([keccak256(code ?? '0x'), impl ?? zero, beacon ?? zero]));
}

export interface LiveWatchEffectsInput extends SubjectCheckInput {
  subjectClient: StandardCheckClient & SubjectClient & Pick<PublicClient, 'request' | 'getStorageAt'>;
  /** Every subject RPC, primary first, for the getLogs reader; default [subjectRpcUrl]. */
  subjectRpcUrls?: readonly string[];
  /** reportURI = <reportBaseUrl>/<chainId>/<address>/<block>-<hash8>.json. No trailing slash. */
  reportBaseUrl: string;
  /** Registry on the attest chain, read for every decision; null when there is none (only with attest false). */
  registry: Pick<AttestationRegistryClient, 'latest' | 'sendAttest' | 'waitAttest' | 'attestTx' | 'hasPendingTransactions'> | null;
  /** False with --no-attest: decisions are recorded, nothing is sent. */
  attest: boolean;
  /** The issuer's balance on the attest chain. */
  balance?: () => Promise<bigint>;
  /**
   * The issuer's transaction count at the latest block of the attest chain, to tell whether a dropped
   * transaction's nonce was used since; without it a dropped transaction is never resent with its nonce.
   */
  issuerNonce?: () => Promise<number>;
  now?: () => Date;
}

/**
 * The effects of a real watcher: reads the subject chain through `subjectClient` (getLogs through the batched
 * reader, per topic), runs the suite as the desk worker does but with a seed per subject and that subject's
 * forge failures kept under .specfirst/watch/<chainId>/forge-failures, copies reports to certs/checks and
 * attests through the registry client (whose wallet is the watcher's issuer key), sending and waiting apart
 * (the nonce fixed before sending, so the watcher can record it with the hash) and looking transactions up.
 */
export function liveWatchEffects(i: LiveWatchEffectsInput): WatchEffects {
  const registry = i.registry;
  const getLogs = batchedLogsReader(i.subjectRpcUrls ?? [i.subjectRpcUrl]);
  const failures = path.join(i.projectDir, WATCH_DIR, String(i.subjectChainId), 'forge-failures');
  return {
    subjectChainId: i.subjectChainId,
    latestBlock: () => i.subjectClient.getBlockNumber({ cacheTime: 0 }),
    getLogs,
    precheck: (subject, block) => precheckErc4626(i.subjectClient, subject, block),
    fingerprint: (subject, block) => fingerprintOf(i.subjectClient, subject, block),
    runCheck: (subject, block) =>
      runSubjectCheck({ ...i, timeoutSec: i.timeoutSec ?? DEFAULT_WATCH_CHECK_TIMEOUT_SEC }, subject, block, {
        seed: watchFuzzSeedOf(subject),
        failurePersistDir: path.join(failures, subject.toLowerCase()),
      }),
    saveReport: (report) => saveReportCopy(i.projectDir, i.reportBaseUrl, report),
    loadReport: (reportPath) => loadReportCopy(i.projectDir, reportPath),
    reportURIOf: (reportPath) => `${i.reportBaseUrl}/${reportPath.replace(/^certs\/checks\//, '')}`,
    verifySubject: (report) => verifySubjectCode(i.subjectClient, report, { allowUnknownProxy: true }),
    latestAttestation: async (subject) => (registry ? registry.latest(BigInt(i.subjectChainId), subject, ERC4626_ID) : null),
    attest:
      i.attest && registry
        ? {
            send: (params, opts) => registry.sendAttest(params, opts),
            wait: async (hash) => {
              const out = await registry.waitAttest(hash);
              return { id: out.id, gasCostWei: out.gasUsed * out.effectiveGasPrice };
            },
            status: async (sent) => {
              const tx = await registry.attestTx(sent.hash);
              if (tx.state !== 'unknown') return tx;
              const used = i.issuerNonce ? await i.issuerNonce() : null;
              return { state: 'dropped', nonceUsed: used === null || used > sent.nonce };
            },
            hasPending: () => registry.hasPendingTransactions(),
          }
        : null,
    balance: i.attest && i.balance ? i.balance : null,
    now: i.now ?? (() => new Date()),
  };
}
