import type { Address, Hex, PublicClient } from 'viem';
import { attestationParamsFromReport, AttestationError, standardIdOf, type AttestParams } from '../attest/params.js';
import { ATTESTATION_STATUS, type Attestation, type AttestationRegistryClient, type AttestSendOptions, type AttestTxState } from '../attest/registry.js';
import {
  checkBlockOf,
  countsAsFailure,
  DEFAULT_BLOCK_LAG,
  errorNameOf,
  errorText,
  isCheckTimeout,
  isSubjectRpcFailure,
  loadReportCopy,
  precheckErc4626,
  runSubjectCheck,
  saveReportCopy,
  type Erc4626Precheck,
} from '../attest/subjectCheck.js';
import { verifySubjectCode, type SubjectClient, type SubjectCodeCheck } from '../attest/verify.js';
import { isNodeError, isRateLimited, isRpcServerError, isTransportFailure } from '../chain/transport.js';
import { StandardCheckTimeoutError, type RunStandardCheckInput, type StandardCheckClient, type StandardCheckEvent } from '../standards/check.js';
import { forkRpcErrorsOf, type StandardCheckReport } from '../standards/report.js';
import type { DeskRequest, DeskTx, RequestDeskClient } from './client.js';
import { reasonOf, REQUEST_STATUS, type RejectReason, type RequestStatusName, type WorkerRequestStatus, type WorkerStage } from './index.js';
import type { WorkerStateEntry, WorkerStore } from './store.js';

// Shared with the watcher; re-exported so the package root keeps exporting them from here.
export {
  checkBlockOf,
  countsAsFailure,
  DEFAULT_BLOCK_LAG,
  DEFAULT_REPORT_BASE_URL,
  errorText,
  isContractAnswer,
  precheckErc4626,
  REPORT_BASE_URL_ENV,
  type Erc4626Precheck,
} from '../attest/subjectCheck.js';

export const DEFAULT_WORKER_RUNS = 16;
export const DEFAULT_WORKER_POLL_SEC = 15;

const PENDING = REQUEST_STATUS.indexOf('Pending');

/** The desk calls the worker makes; RequestDeskClient has them, tests can pass a stub. */
export type WorkerDesk = Pick<RequestDeskClient, 'requestCount' | 'requestOf' | 'fulfill' | 'reject' | 'worker' | 'timeout'>;

/** DeskError name of a reject whose gas estimate is above WorkerConfig.maxRejectGas. */
export const GAS_CAP_EXCEEDED = 'GasCapExceeded';

/** The desk's worker is no longer this worker's address (setWorker): it attests, fulfills and rejects nothing more. */
export class WorkerReplacedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerReplacedError';
  }
}

/** Where an attest sent earlier stands; dropped: the node does not know it, and whether its nonce was used since. */
export type AttestTxStatus = Exclude<AttestTxState, { state: 'unknown' }> | { state: 'dropped'; nonceUsed: boolean };

/**
 * Everything the worker does outside its own files, injected so the loop is testable: desk reads and
 * writes, the subject chain, the property suite, report copies, the identity check and the attestation.
 */
export interface WorkerEffects {
  desk: WorkerDesk;
  /** The address the worker signs with. It must stay desk.worker(); its attestation of a request's own report delivers that request. */
  workerAddress: Address;
  /** The one subject chain this worker reads. Requests for other chains are rejected (unsupported-chain). */
  subjectChainId: number;
  latestSubjectBlock(): Promise<bigint>;
  /** Timestamp (seconds) of a subject chain block. */
  subjectBlockTime(block: bigint): Promise<bigint>;
  /** Timestamp (seconds) of the desk chain's latest block, the clock of requestedAt and of the desk's timeout. */
  deskTime(): Promise<bigint>;
  precheck(subject: Address, block: bigint): Promise<Erc4626Precheck>;
  /** The suite at `block`, stopped after `timeoutSec` seconds (StandardCheckTimeoutError). */
  runCheck(subject: Address, block: bigint, timeoutSec: number): Promise<StandardCheckReport>;
  /** Writes the report copy under certs/checks; returns its repository relative path and its public URI. */
  saveReport(report: StandardCheckReport): Promise<{ reportPath: string; reportURI: string }>;
  loadReport(reportPath: string): Promise<StandardCheckReport>;
  /** verifySubjectCode with allowUnknownProxy, so the worker decides about unknown proxies itself. */
  verifySubject(report: StandardCheckReport): Promise<SubjectCodeCheck>;
  /** Sends attest; `send.onSent` gets the hash and nonce before the receipt is awaited. `send.nonce` resends with a recorded nonce. */
  attest(params: AttestParams, send: AttestSendOptions & Required<Pick<AttestSendOptions, 'onSent'>>): Promise<{ id: bigint; hash: Hex; gasCostWei: bigint }>;
  /** Where an attest transaction sent earlier stands. */
  attestTxStatus(sent: { hash: Hex; nonce: number }): Promise<AttestTxStatus>;
  /** The registry's latest attestation of (subjectChainId, subject, standardId), whoever issued it and whatever its status; null when there is none. */
  latestAttestation(subjectChainId: bigint, subject: Address, standardId: Hex): Promise<{ id: bigint; attestation: Attestation } | null>;
  /** Whether `who` is an issuer of the registry now. */
  isIssuer(who: Address): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): Date;
}

export interface WorkerConfig {
  /** Blocks below the latest subject block the check forks at. */
  blockLag: bigint;
  /** Attempts of the pre-check, of the check and of the identity check within one pass. */
  maxAttempts: number;
  /** Wait before retry n (the last value repeats). */
  retryDelaysMs: readonly number[];
  /** Passes in a row a failing attest, fulfill or reject is retried before the worker moves on. */
  maxTxFailures: number;
  /** Attest subjects whose proxy implementation is unknown instead of rejecting them (unknown-proxy). */
  allowUnknownProxy: boolean;
  /**
   * Most gas a reject may need. A requester whose receive function burns gas would make every refund
   * expensive for the worker; above the cap the worker gives up and the requester refunds itself with
   * refundExpired.
   */
  maxRejectGas: bigint;
  /**
   * Wall-clock budget of one request's check in seconds, shared by its attempts within a pass. A check that
   * runs out is not retried: the request is rejected and its subject is not checked again for
   * timeoutCooldownMs, so one slow vault cannot hold the worker again and again.
   */
  checkTimeoutSec: number;
  /** A check starts only while the request has checkTimeoutSec + startMarginSec left before it times out. */
  startMarginSec: number;
  /** First wait after a subject RPC failure before the request is tried again; it doubles per failure up to maxRetryMs. */
  rpcRetryMs: number;
  maxRetryMs: number;
  /** Checks of one request that ran but could not be attested (fork RPC errors, a newer attestation) before it is rejected. */
  maxCheckRuns: number;
  /** Wait before a rerun after fork RPC errors, times the runs so far. */
  rerunDelayMs: number;
  /** How long a subject whose check ran out of time is not checked again; its requests are rejected meanwhile. */
  timeoutCooldownMs: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  blockLag: DEFAULT_BLOCK_LAG,
  maxAttempts: 3,
  retryDelaysMs: [5_000, 20_000],
  maxTxFailures: 3,
  allowUnknownProxy: false,
  maxRejectGas: 300_000n,
  checkTimeoutSec: 600,
  startMarginSec: 300,
  rpcRetryMs: 30_000,
  maxRetryMs: 600_000,
  maxCheckRuns: 3,
  rerunDelayMs: 300_000,
  timeoutCooldownMs: 24 * 3_600_000,
};

export type WorkerStep = 'precheck' | 'check' | 'identity' | 'save' | 'attest' | 'fulfill' | 'reject';

export type WorkerEvent =
  | { type: 'worker-pass'; requestCount: string; cursor: string; open: string[] }
  | { type: 'worker-stage'; id: string; stage: WorkerStage; block?: string; reportPath?: string; attestationId?: string; txHash?: Hex }
  | { type: 'worker-retry'; id: string; step: WorkerStep; attempt: number; error: string }
  | { type: 'worker-step-failed'; id: string; step: WorkerStep; failures: number; error: string }
  | { type: 'worker-deferred'; id: string; step: WorkerStep; retryAt: string; error: string }
  | { type: 'worker-fulfilled'; id: string; attestationId: string; txHash: Hex; gasCostWei: string }
  | { type: 'worker-rejected'; id: string; reason: RejectReason; detail: string; txHash: Hex; gasCostWei: string }
  | { type: 'worker-closed'; id: string; status: RequestStatusName }
  | { type: 'worker-reused'; id: string; attestationId: string; issuer: Address }
  | { type: 'worker-gave-up'; id: string; error: string }
  | { type: 'worker-error'; id: string; error: string }
  | { type: 'worker-pass-done'; cursor: string; fulfilled: string[]; rejected: string[]; open: string[] };

export interface WorkerPassResult {
  cursor: bigint;
  fulfilled: bigint[];
  rejected: bigint[];
  /** Pending requests the worker still has to finish (a later pass retries them). */
  open: bigint[];
}

// ---------------------------------------------------------------- pure decisions

/** Whether the worker can serve a request at all, before touching the subject chain. */
export function screenRequest(
  r: Pick<DeskRequest, 'subjectChainId' | 'standardId'>,
  subjectChainId: number,
): { ok: true } | { ok: false; reason: RejectReason; detail: string } {
  if (r.standardId.toLowerCase() !== standardIdOf('erc4626')) {
    return { ok: false, reason: 'unsupported-standard', detail: `standardId ${r.standardId} is not keccak256("erc4626")` };
  }
  if (r.subjectChainId !== BigInt(subjectChainId)) {
    return { ok: false, reason: 'unsupported-chain', detail: `subject chain ${r.subjectChainId}; this worker reads chain ${subjectChainId}` };
  }
  return { ok: true };
}

/** The first id at or above `cursor` that is not closed; every id below the result is closed. */
export function advanceCursor(cursor: bigint, count: bigint, closed: ReadonlySet<bigint>): bigint {
  let c = cursor;
  while (c < count && closed.has(c)) c++;
  return c;
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The desk's fulfill rule as far as the worker can see it: the attestation is Valid and issued at or after the request. */
function fulfillable(a: Pick<Attestation, 'status' | 'issuedAt'>, r: Pick<DeskRequest, 'requestedAt'>): boolean {
  return ATTESTATION_STATUS[a.status] === 'Valid' && a.issuedAt >= r.requestedAt;
}

/**
 * Whether a registry attestation delivers a request (docs/adr/0005): it is Valid and issued at or after the
 * request (the desk's fulfill rule), and it checked the subject as of the request: the timestamp of its subject
 * chain block (`subjectBlockTime`) is at or after requestedAt, or it is the attestation `worker` made from this
 * request's own saved report (same reportURI), whatever its block. issuedAt alone is not enough: a check that
 * forked before the request, or an attestation made by hand with the worker's key, would pass it.
 */
export function canDeliver(
  a: Pick<Attestation, 'status' | 'issuedAt' | 'issuer' | 'reportURI'> | null,
  r: Pick<DeskRequest, 'requestedAt'>,
  o: { worker: Address; reportURI?: string; subjectBlockTime?: bigint },
): boolean {
  if (!a || !fulfillable(a, r)) return false;
  if (o.reportURI !== undefined && sameAddress(a.issuer, o.worker) && a.reportURI === o.reportURI) return true;
  return o.subjectBlockTime !== undefined && o.subjectBlockTime >= r.requestedAt;
}

/**
 * Merges `patch` into request `id` of status.json, sets updatedAt, and drops keys whose value is undefined
 * (so `error: undefined` clears an error). txs are merged, and gasCostWei is added (addGasWei), never replaced.
 */
export function withStage(
  status: WorkerStore['status'],
  id: string,
  patch: Partial<Omit<WorkerRequestStatus, 'txs' | 'gasCostWei'>> & { txs?: WorkerRequestStatus['txs']; addGasWei?: bigint },
  now: Date,
): WorkerRequestStatus {
  const prev = status[id] as WorkerRequestStatus | undefined;
  const { txs, addGasWei, ...rest } = patch;
  const gas = BigInt(prev?.gasCostWei ?? '0') + (addGasWei ?? 0n);
  const next: Record<string, unknown> = {
    ...(prev ?? { stage: 'queued' }),
    ...rest,
    updatedAt: now.toISOString(),
    txs: { ...(prev?.txs ?? {}), ...(txs ?? {}) },
    ...(prev?.gasCostWei !== undefined || addGasWei !== undefined ? { gasCostWei: gas.toString() } : {}),
  };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  status[id] = next as WorkerRequestStatus;
  return status[id] as WorkerRequestStatus;
}

// ---------------------------------------------------------------- the loop

export interface RunWorkerPassInput {
  effects: WorkerEffects;
  store: WorkerStore;
  config?: Partial<WorkerConfig>;
  onEvent?: (e: WorkerEvent) => void;
}

/**
 * One pass over the desk: checks that desk.worker() is still this worker, reads requestCount() and
 * requestOf(cursor .. count - 1) (no event logs, so it stays under RPC log range and rate limits), marks new
 * Pending requests queued, then works through them one at a time in id order and advances the cursor past
 * every closed request. Per Pending request: screen (standard, chain), deliver with a registry attestation
 * that can (canDeliver, any issuer), else pre-check the subject at latest - lag (no ERC-4626: reject
 * not-erc4626), run the suite within the check budget, save the report copy, check the identity on the
 * subject chain, attest (the transaction is recorded before its receipt is awaited) and fulfill. A subject
 * RPC failure is never a verdict: the request waits and is tried again in a later pass, while there is time
 * for a check. A report with fork RPC errors is not attested and is checked again, a few times at most; a
 * check that runs out of time is rejected without a retry. A request whose step throws unexpectedly is
 * recorded with its error and retried in the next pass, and rejected with check-failed after maxTxFailures
 * such passes; RPC failures never count. The pass itself only throws when the desk cannot be read at all or
 * the desk's worker changed.
 */
export async function runWorkerPass(input: RunWorkerPassInput): Promise<WorkerPassResult> {
  const { effects, store } = input;
  const config: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...input.config };
  const emit = input.onEvent ?? (() => {});
  const { desk } = effects;
  const state = store.state;

  await assertStillWorker(effects);
  const count = await desk.requestCount();
  const start = BigInt(state.cursor);
  if (start > count) throw new Error(`state cursor ${start} is past requestCount ${count}; state.json does not belong to this desk`);
  pruneTimedOut(store, effects.now(), config);
  // Given-up requests below the cursor stay Pending until the requester refunds; notice when that happens.
  for (const key of Object.keys(state.requests)) {
    if (!state.requests[key]!.gaveUp || BigInt(key) >= start) continue;
    const r = await desk.requestOf(BigInt(key));
    if (r.status !== PENDING) observeClosed(BigInt(key), r, store, effects, emit);
  }
  const seen: Array<{ id: bigint; request: DeskRequest }> = [];
  for (let id = start; id < count; id++) seen.push({ id, request: await desk.requestOf(id) });

  const isOpen = (id: bigint, r: DeskRequest) => r.status === PENDING && !state.requests[String(id)]?.gaveUp;
  const openIds = seen.filter((s) => isOpen(s.id, s.request)).map((s) => s.id);
  emit({ type: 'worker-pass', requestCount: count.toString(), cursor: start.toString(), open: openIds.map(String) });
  for (const id of openIds) {
    if (store.status[String(id)] === undefined) {
      withStage(store.status, String(id), { stage: 'queued' }, effects.now());
      emit({ type: 'worker-stage', id: String(id), stage: 'queued' });
    }
  }
  await store.save();

  // The desk's clock and timeout, read once per pass and only when a request needs them.
  let clock: { desk: bigint; wall: number; timeout: bigint } | null = null;
  const deskClock = async () => (clock ??= { desk: await effects.deskTime(), wall: effects.now().getTime(), timeout: await desk.timeout() });
  const ctx: Ctx = { effects, store, config, emit, deskClock };

  const closed = new Set<bigint>();
  const fulfilled: bigint[] = [];
  const rejected: bigint[] = [];
  let worked = false;
  for (const s of seen) {
    const key = String(s.id);
    let request = s.request;
    try {
      // Earlier requests of this pass can take minutes; read again so a refunded request is not checked.
      if (worked && request.status === PENDING) request = await desk.requestOf(s.id);
      if (request.status !== PENDING) {
        observeClosed(s.id, request, store, effects, emit);
        closed.add(s.id);
        continue;
      }
      if (state.requests[key]?.gaveUp) {
        closed.add(s.id);
        continue;
      }
      worked = true;
      const outcome = await processRequest(s.id, request, ctx);
      if (outcome === 'fulfilled') fulfilled.push(s.id);
      if (outcome === 'rejected') rejected.push(s.id);
      if (outcome !== 'open') closed.add(s.id);
    } catch (err) {
      if (err instanceof WorkerReplacedError) {
        await store.save();
        throw err;
      }
      const error = errorText(err);
      withStage(store.status, key, { error }, effects.now());
      emit({ type: 'worker-error', id: key, error });
      // An error outside the transaction steps (a report that cannot be written, a broken file) would rerun
      // the whole check every pass. After maxTxFailures such passes the request is rejected and refunded.
      // A sent attest is never given up this way: its receipt is looked up first.
      const entry = state.requests[key];
      if (entry && countsAsUnexpected(err) && !entry.attestationId && !entry.attestTx && !entry.reject) {
        entry.failures += 1;
        if (entry.failures >= config.maxTxFailures) {
          entry.reject = 'check-failed';
          entry.detail = `worker error ${entry.failures} passes in a row: ${error}`;
          entry.failures = 0;
        }
      }
    }
    await store.save();
  }

  const cursor = advanceCursor(start, count, closed);
  state.cursor = cursor.toString();
  await store.save();
  const open = seen.filter((s) => s.id >= cursor && !closed.has(s.id)).map((s) => s.id);
  emit({ type: 'worker-pass-done', cursor: cursor.toString(), fulfilled: fulfilled.map(String), rejected: rejected.map(String), open: open.map(String) });
  return { cursor, fulfilled, rejected, open };
}

/** Errors thrown out of a request that are not RPC failures: no outage, rate limit, node error or JSON-RPC server error. */
function countsAsUnexpected(err: unknown): boolean {
  return !(isTransportFailure(err) || isRateLimited(err) || isNodeError(err) || isRpcServerError(err));
}

/** Throws WorkerReplacedError when desk.worker() is no longer this worker (setWorker). */
async function assertStillWorker(effects: WorkerEffects): Promise<void> {
  const current = await effects.desk.worker();
  if (!sameAddress(current, effects.workerAddress)) {
    throw new WorkerReplacedError(`the desk's worker is now ${current}, not ${effects.workerAddress}; this worker attests and closes nothing until it is the worker again`);
  }
}

/** Forgets timed-out subjects whose cool-off has passed. */
function pruneTimedOut(store: WorkerStore, now: Date, config: WorkerConfig): void {
  const t = store.state.timedOut;
  if (!t) return;
  for (const [subject, v] of Object.entries(t)) if (now.getTime() - Date.parse(v.at) >= config.timeoutCooldownMs) delete t[subject];
  if (Object.keys(t).length === 0) delete store.state.timedOut;
}

/** A request closed by someone else (refundExpired) or by a transaction whose result the worker did not record. */
function observeClosed(id: bigint, r: DeskRequest, store: WorkerStore, effects: WorkerEffects, emit: (e: WorkerEvent) => void): void {
  const key = String(id);
  const entry = store.status[key] as WorkerRequestStatus | undefined;
  delete store.state.requests[key];
  if (!entry || entry.stage === 'fulfilled' || entry.stage === 'rejected') return;
  const name = REQUEST_STATUS[r.status] ?? 'None';
  if (name === 'Fulfilled') withStage(store.status, key, { stage: 'fulfilled', attestationId: r.attestationId.toString(), error: undefined }, effects.now());
  else if (name === 'Rejected') withStage(store.status, key, { stage: 'rejected', error: reasonOf(r.rejectReason) }, effects.now());
  else withStage(store.status, key, { error: `request is ${name} onchain; the worker did not close it` }, effects.now());
  emit({ type: 'worker-closed', id: key, status: name });
}

interface Ctx {
  effects: WorkerEffects;
  store: WorkerStore;
  config: WorkerConfig;
  emit: (e: WorkerEvent) => void;
  /** Desk chain time at the first call of the pass (with the wall clock then) and the desk's timeout. */
  deskClock(): Promise<{ desk: bigint; wall: number; timeout: bigint }>;
}

type Outcome = 'fulfilled' | 'rejected' | 'gave-up' | 'closed' | 'open';

function stageOf(id: bigint, ctx: Ctx): (s: WorkerStage, extra?: Partial<WorkerRequestStatus>) => void {
  const key = String(id);
  return (s, extra = {}) => {
    withStage(ctx.store.status, key, { stage: s, error: undefined, ...extra }, ctx.effects.now());
    ctx.emit({ type: 'worker-stage', id: key, stage: s, ...pickEventFields(extra) });
  };
}

async function processRequest(id: bigint, r: DeskRequest, ctx: Ctx): Promise<Outcome> {
  const { effects, store, config, emit } = ctx;
  const key = String(id);
  const entry: WorkerStateEntry = (store.state.requests[key] ??= { failures: 0 });
  const stage = stageOf(id, ctx);

  if (entry.reject) return doReject(id, r, entry, ctx);
  if (entry.attestationId) return doFulfill(id, r, entry, ctx);

  const screen = screenRequest(r, effects.subjectChainId);
  if (!screen.ok) {
    stage('prechecking');
    return decideReject(id, r, entry, screen.reason, screen.detail, ctx);
  }

  // An attest sent earlier is looked up before anything else: it may have been mined meanwhile.
  let resendNonce: number | undefined;
  if (entry.attestTx) {
    const sent = await resolveAttestTx(id, entry, ctx);
    if (sent === 'attested') return doFulfill(id, r, entry, ctx);
    if (sent === 'pending') return 'open';
    if (sent === 'attest-failed') return decideReject(id, r, entry, 'attest-failed', `attest tx reverted ${config.maxTxFailures} times`, ctx);
    if (typeof sent === 'object') resendNonce = sent.resend;
  }
  if (entry.retryAt && entry.retryAt > effects.now().toISOString()) return 'open';
  delete entry.retryAt;

  // An attestation that can deliver the request (canDeliver, any issuer) does: no check, no second attest.
  const found = await findDelivery(r, entry, ctx);
  if (found) return deliver(id, r, entry, found, ctx);

  let report: StandardCheckReport | undefined;
  if (entry.reportPath && entry.reportURI) {
    try {
      report = await effects.loadReport(entry.reportPath);
    } catch (err) {
      // The saved copy is gone or broken: check again from the start.
      emit({ type: 'worker-step-failed', id: key, step: 'save', failures: entry.failures, error: `saved report unreadable, checking again: ${errorText(err)}` });
      dropReport(entry);
    }
  }

  if (!report) {
    const checked = await runCheckStep(id, r, entry, ctx);
    if (typeof checked === 'string') return checked;
    report = checked;
    const saved = await effects.saveReport(report);
    entry.block = report.blockNumber;
    entry.reportPath = saved.reportPath;
    entry.reportURI = saved.reportURI;
    stage('attesting', { block: report.blockNumber, reportPath: saved.reportPath });
    await store.save();
  } else {
    stage('attesting', { block: report.blockNumber, reportPath: entry.reportPath });
  }

  const checked = report;
  const identity = await withRetries(ctx, key, 'identity', () => effects.verifySubject(checked), (err) => !(err instanceof AttestationError));
  if (!identity.ok) {
    if (!(identity.error instanceof AttestationError) && isSubjectRpcFailure(identity.error)) return defer(id, entry, 'identity', identity.error, ctx);
    return decideReject(id, r, entry, 'check-failed', `identity: ${errorText(identity.error)}`, ctx);
  }
  delete entry.deferrals;
  if (identity.value.unknownProxy && !config.allowUnknownProxy) {
    return decideReject(id, r, entry, 'unknown-proxy', `${r.subject} is proxy-shaped but its implementation could not be resolved`, ctx);
  }
  let params: AttestParams;
  try {
    params = attestationParamsFromReport(checked, { reportURI: entry.reportURI! });
  } catch (err) {
    if (err instanceof AttestationError) return decideReject(id, r, entry, 'check-failed', `report: ${err.message}`, ctx);
    throw err;
  }
  // The check took minutes: do not attest for a request that was refunded meanwhile, after setWorker, or twice.
  const fresh = await effects.desk.requestOf(id);
  if (fresh.status !== PENDING) {
    observeClosed(id, fresh, store, effects, emit);
    return 'closed';
  }
  await assertStillWorker(effects);
  const again = await findDelivery(r, entry, ctx);
  if (again) return deliver(id, r, entry, again, ctx);

  let sentNow = false;
  let attested;
  try {
    attested = await effects.attest(params, {
      ...(resendNonce !== undefined ? { nonce: resendNonce } : {}),
      // Recorded before the receipt is awaited: a crash or a lost receipt from here on is resolved by looking
      // this transaction up, never by sending a second attestation.
      onSent: async (sent) => {
        sentNow = true;
        entry.attestTx = { hash: sent.hash, nonce: sent.nonce };
        withStage(store.status, key, { stage: 'attesting', txs: { attest: sent.hash }, error: undefined }, effects.now());
        emit({ type: 'worker-stage', id: key, stage: 'attesting', txHash: sent.hash });
        await store.save();
      },
    });
  } catch (err) {
    if (sentNow) {
      const error = errorText(err);
      withStage(store.status, key, { error: `attest tx ${entry.attestTx?.hash} was sent, its receipt is looked up in the next pass: ${error}` }, effects.now());
      emit({ type: 'worker-step-failed', id: key, step: 'attest', failures: entry.failures, error });
      return 'open';
    }
    if (errorNameOf(err) === 'OlderThanLatest') return superseded(id, r, entry, err, ctx);
    if (stepFailed(id, entry, 'attest', err, ctx)) return decideReject(id, r, entry, 'attest-failed', errorText(err), ctx);
    return 'open';
  }
  entry.attestationId = attested.id.toString();
  delete entry.attestTx;
  entry.failures = 0;
  withStage(store.status, key, { stage: 'fulfilling', attestationId: entry.attestationId, txs: { attest: attested.hash }, addGasWei: attested.gasCostWei, error: undefined }, effects.now());
  emit({ type: 'worker-stage', id: key, stage: 'fulfilling', attestationId: entry.attestationId, txHash: attested.hash });
  await store.save();
  return doFulfill(id, r, entry, ctx);
}

/**
 * Pre-check and suite run of a request, or the outcome when there is no report to attest: rejected when there
 * is no time left for a check, when the subject is cooling off after a timeout, when it is not a vault, when
 * the check timed out or failed on its own; open (tried again later) after a subject RPC failure or a report
 * with fork RPC errors.
 */
async function runCheckStep(id: bigint, r: DeskRequest, entry: WorkerStateEntry, ctx: Ctx): Promise<StandardCheckReport | Outcome> {
  const { effects, store, config } = ctx;
  const key = String(id);
  const stage = stageOf(id, ctx);

  const c = await ctx.deskClock();
  const deskNow = c.desk + BigInt(Math.floor((effects.now().getTime() - c.wall) / 1000));
  const left = r.requestedAt + c.timeout - deskNow;
  const need = BigInt(config.checkTimeoutSec + config.startMarginSec);
  if (left < need) {
    const last = (store.status[key] as WorkerRequestStatus | undefined)?.error;
    const detail = `not checked: the request times out in ${left > 0n ? left : 0n} s, a check needs up to ${need} s${last ? `; last: ${last}` : ''}`;
    return decideReject(id, r, entry, 'check-failed', detail, ctx);
  }
  const cooling = coolingOff(r.subject, ctx);
  if (cooling) return decideReject(id, r, entry, 'check-failed', cooling, ctx);

  stage('prechecking');
  const pre = await withRetries(ctx, key, 'precheck', async () => {
    const block = checkBlockOf(await effects.latestSubjectBlock(), config.blockLag);
    return { block, result: await effects.precheck(r.subject, block) };
  });
  // precheckErc4626 answers "not a vault" only on the contract's own answer and throws everything else.
  if (!pre.ok) return defer(id, entry, 'precheck', pre.error, ctx);
  delete entry.deferrals;
  if (!pre.value.result.ok) return decideReject(id, r, entry, 'not-erc4626', pre.value.result.reason, ctx);
  const block = pre.value.block;
  stage('running', { block: block.toString() });
  const started = effects.now().getTime();
  const run = await withRetries(
    ctx,
    key,
    'check',
    async () => {
      // One budget per request: attempts after a failure get what the earlier ones left.
      const budget = config.checkTimeoutSec - Math.floor((effects.now().getTime() - started) / 1000);
      if (budget <= 0) throw new StandardCheckTimeoutError(config.checkTimeoutSec);
      return effects.runCheck(r.subject, block, budget);
    },
    (err) => !isCheckTimeout(err),
  );
  if (!run.ok) {
    if (isCheckTimeout(run.error)) {
      const at = effects.now();
      (store.state.timedOut ??= {})[r.subject.toLowerCase()] = { at: at.toISOString(), block: block.toString() };
      const until = new Date(at.getTime() + config.timeoutCooldownMs).toISOString();
      return decideReject(id, r, entry, 'check-failed', `check: ${errorText(run.error)}, the budget of one request's check; not retried, and ${r.subject} is not checked again before ${until}`, ctx);
    }
    if (isSubjectRpcFailure(run.error)) return defer(id, entry, 'check', run.error, ctx);
    return decideReject(id, r, entry, 'check-failed', `check: ${errorText(run.error)}`, ctx);
  }
  // A property the fork could not read says nothing about the vault: not attested, checked again later.
  const forkErrors = forkRpcErrorsOf(run.value);
  if (forkErrors.length > 0) {
    entry.checkRuns = (entry.checkRuns ?? 0) + 1;
    const why = `${forkErrors.length} of ${run.value.results.length} properties inconclusive on a fork RPC error (${forkErrors[0]!.id}: ${forkErrors[0]!.reason})`;
    if (entry.checkRuns >= config.maxCheckRuns) return decideReject(id, r, entry, 'check-failed', `check: ${entry.checkRuns} runs could not be attested; last: ${why}`, ctx);
    return holdBack(id, entry, 'check', `${why}; not attested`, config.rerunDelayMs * entry.checkRuns, ctx);
  }
  return run.value;
}

/** Why the subject is not checked now (a check of it timed out within timeoutCooldownMs), or null. */
function coolingOff(subject: Address, ctx: Ctx): string | null {
  const t = ctx.store.state.timedOut?.[subject.toLowerCase()];
  if (!t) return null;
  const until = Date.parse(t.at) + ctx.config.timeoutCooldownMs;
  if (ctx.effects.now().getTime() >= until) return null;
  return `not checked: a check of ${subject} at block ${t.block} ran out of its time budget at ${t.at}; it is not checked again before ${new Date(until).toISOString()}`;
}

/** A subject RPC failure: the request waits, the wait doubling from rpcRetryMs up to maxRetryMs. Never a verdict. */
function defer(id: bigint, entry: WorkerStateEntry, step: WorkerStep, err: unknown, ctx: Ctx): Outcome {
  entry.deferrals = (entry.deferrals ?? 0) + 1;
  const delay = Math.min(ctx.config.rpcRetryMs * 2 ** Math.min(entry.deferrals - 1, 20), ctx.config.maxRetryMs);
  return holdBack(id, entry, step, `subject RPC failed, not a verdict: ${errorText(err)}`, delay, ctx);
}

/** Leaves the request open until `delayMs` from now, with `why` in status.json and a worker-deferred event. */
function holdBack(id: bigint, entry: WorkerStateEntry, step: WorkerStep, why: string, delayMs: number, ctx: Ctx): Outcome {
  const retryAt = new Date(ctx.effects.now().getTime() + delayMs).toISOString();
  entry.retryAt = retryAt;
  withStage(ctx.store.status, String(id), { error: `${step}: ${why}; trying again from ${retryAt}` }, ctx.effects.now());
  ctx.emit({ type: 'worker-deferred', id: String(id), step, retryAt, error: why });
  return 'open';
}

function dropReport(entry: WorkerStateEntry): void {
  delete entry.reportPath;
  delete entry.reportURI;
  delete entry.block;
}

/**
 * attest reverted with OlderThanLatest: another issuer (the watcher, say) attested a later block of the
 * subject while this check ran. Not a failure. That attestation delivers the request when it can; otherwise
 * the request is checked again at a new block, at most maxCheckRuns checks in all.
 */
async function superseded(id: bigint, r: DeskRequest, entry: WorkerStateEntry, err: unknown, ctx: Ctx): Promise<Outcome> {
  const found = await findDelivery(r, entry, ctx);
  if (found) return deliver(id, r, entry, found, ctx);
  dropReport(entry);
  entry.checkRuns = (entry.checkRuns ?? 0) + 1;
  const why = `a later block of the subject is attested (${errorText(err)}) by an attestation that cannot deliver this request`;
  if (entry.checkRuns >= ctx.config.maxCheckRuns) return decideReject(id, r, entry, 'check-failed', `${entry.checkRuns} checks could not be attested; last: ${why}`, ctx);
  return holdBack(id, entry, 'attest', `${why}; checking again at a new block`, 0, ctx);
}

/**
 * The registry's latest attestation of the request's subject when it delivers the request (canDeliver): Valid,
 * issued at or after the request, and either this request's own report attested by this worker or a check of
 * a subject block at or after the request by an issuer the registry still allows. `skip` is an attestation
 * id whose fulfill kept failing.
 */
async function findDelivery(r: DeskRequest, entry: WorkerStateEntry, ctx: Ctx, skip?: bigint): Promise<{ id: bigint; issuer: Address } | null> {
  const { effects } = ctx;
  const latest = await effects.latestAttestation(r.subjectChainId, r.subject, r.standardId);
  if (!latest || latest.id === skip || !fulfillable(latest.attestation, r)) return null;
  const a = latest.attestation;
  const own = { worker: effects.workerAddress, ...(entry.reportURI ? { reportURI: entry.reportURI } : {}) };
  const found = { id: latest.id, issuer: a.issuer };
  if (canDeliver(a, r, own)) return found;
  if (!sameAddress(a.issuer, effects.workerAddress) && !(await effects.isIssuer(a.issuer))) return null;
  return canDeliver(a, r, { ...own, subjectBlockTime: await effects.subjectBlockTime(a.blockNumber) }) ? found : null;
}

/** Records `found` as the request's delivery and fulfills with it. */
async function deliver(id: bigint, r: DeskRequest, entry: WorkerStateEntry, found: { id: bigint; issuer: Address }, ctx: Ctx): Promise<Outcome> {
  const key = String(id);
  entry.attestationId = found.id.toString();
  entry.failures = 0;
  delete entry.reject;
  delete entry.detail;
  delete entry.retryAt;
  withStage(ctx.store.status, key, { stage: 'fulfilling', attestationId: entry.attestationId, error: undefined }, ctx.effects.now());
  ctx.emit({ type: 'worker-reused', id: key, attestationId: entry.attestationId, issuer: found.issuer });
  ctx.emit({ type: 'worker-stage', id: key, stage: 'fulfilling', attestationId: entry.attestationId });
  await ctx.store.save();
  return doFulfill(id, r, entry, ctx);
}

/**
 * Looks up the attest transaction recorded in state.json. mined: its attestation is the request's.
 * reverted: counted like any revert. pending: wait. dropped: when its nonce is still unused it is sent again
 * with that nonce (so at most one of the two can be mined); when another transaction used the nonce the
 * request goes on without it (an attestation of this report that did land is found by findDelivery).
 */
async function resolveAttestTx(id: bigint, entry: WorkerStateEntry, ctx: Ctx): Promise<'attested' | 'pending' | 'retry' | 'attest-failed' | { resend: number }> {
  const { effects, store, config, emit } = ctx;
  const key = String(id);
  const sent = entry.attestTx!;
  const hash = sent.hash as Hex;
  const st = await effects.attestTxStatus({ hash, nonce: sent.nonce });
  switch (st.state) {
    case 'mined':
      entry.attestationId = st.id.toString();
      delete entry.attestTx;
      entry.failures = 0;
      withStage(store.status, key, { stage: 'fulfilling', attestationId: entry.attestationId, txs: { attest: hash }, addGasWei: st.gasCostWei, error: undefined }, effects.now());
      emit({ type: 'worker-stage', id: key, stage: 'fulfilling', attestationId: entry.attestationId, txHash: hash });
      await store.save();
      return 'attested';
    case 'reverted': {
      delete entry.attestTx;
      entry.failures += 1;
      const error = `attest tx ${hash} reverted`;
      withStage(store.status, key, { error: `attest failed (${entry.failures} of ${config.maxTxFailures}): ${error}`, addGasWei: st.gasCostWei }, effects.now());
      emit({ type: 'worker-step-failed', id: key, step: 'attest', failures: entry.failures, error });
      return entry.failures >= config.maxTxFailures ? 'attest-failed' : 'retry';
    }
    case 'pending':
      withStage(store.status, key, { error: `attest tx ${hash} is not mined yet` }, effects.now());
      return 'pending';
    case 'dropped':
      delete entry.attestTx;
      return st.nonceUsed ? 'retry' : { resend: sent.nonce };
  }
}

function pickEventFields(extra: Partial<WorkerRequestStatus>): { block?: string; reportPath?: string } {
  return {
    ...(extra.block !== undefined ? { block: extra.block } : {}),
    ...(extra.reportPath !== undefined ? { reportPath: extra.reportPath } : {}),
  };
}

/**
 * Records a failed transaction step; true once it has failed maxTxFailures passes in a row. Only reverts
 * count (countsAsFailure): an RPC outage is retried in the next pass without moving toward a refund.
 * NotWorker means setWorker replaced this worker: WorkerReplacedError, nothing counted.
 */
function stepFailed(id: bigint, entry: WorkerStateEntry, step: WorkerStep, err: unknown, ctx: Ctx): boolean {
  if (errorNameOf(err) === 'NotWorker') throw new WorkerReplacedError(`${step} of request ${id} reverted with NotWorker: the desk's worker is no longer ${ctx.effects.workerAddress}`);
  const counted = countsAsFailure(err);
  if (counted) entry.failures += 1;
  const error = errorText(err);
  const note = counted ? `${entry.failures} of ${ctx.config.maxTxFailures}` : 'not counted, RPC';
  withStage(ctx.store.status, String(id), { error: `${step} failed (${note}): ${error}` }, ctx.effects.now());
  ctx.emit({ type: 'worker-step-failed', id: String(id), step, failures: entry.failures, error });
  return counted && entry.failures >= ctx.config.maxTxFailures;
}

async function doFulfill(id: bigint, r: DeskRequest, entry: WorkerStateEntry, ctx: Ctx): Promise<Outcome> {
  const key = String(id);
  let tx: DeskTx;
  try {
    tx = await ctx.effects.desk.fulfill(id, BigInt(entry.attestationId!));
  } catch (err) {
    if (stepFailed(id, entry, 'fulfill', err, ctx)) return decideReject(id, r, entry, 'fulfill-failed', errorText(err), ctx);
    return 'open';
  }
  withStage(ctx.store.status, key, { stage: 'fulfilled', attestationId: entry.attestationId, txs: { fulfill: tx.hash }, addGasWei: tx.gasCostWei, error: undefined }, ctx.effects.now());
  delete ctx.store.state.requests[key];
  ctx.emit({ type: 'worker-fulfilled', id: key, attestationId: entry.attestationId!, txHash: tx.hash, gasCostWei: tx.gasCostWei.toString() });
  return 'fulfilled';
}

async function decideReject(id: bigint, r: DeskRequest, entry: WorkerStateEntry, reason: RejectReason, detail: string, ctx: Ctx): Promise<Outcome> {
  entry.reject = reason;
  entry.detail = detail;
  entry.failures = 0;
  delete entry.retryAt;
  await ctx.store.save();
  return doReject(id, r, entry, ctx);
}

/**
 * Rejects with the decided reason, unless an attestation delivers the request after all (findDelivery, for a
 * request the worker serves; an attestation whose fulfill kept failing is skipped).
 */
async function doReject(id: bigint, r: DeskRequest, entry: WorkerStateEntry, ctx: Ctx): Promise<Outcome> {
  const key = String(id);
  if (screenRequest(r, ctx.effects.subjectChainId).ok) {
    const failed = entry.reject === 'fulfill-failed' && entry.attestationId ? BigInt(entry.attestationId) : undefined;
    const found = await findDelivery(r, entry, ctx, failed);
    if (found) return deliver(id, r, entry, found, ctx);
  }
  const reason = entry.reject!;
  const detail = entry.detail ?? '';
  let tx: DeskTx;
  try {
    tx = await ctx.effects.desk.reject(id, reason, { maxGas: ctx.config.maxRejectGas });
  } catch (err) {
    const capped = (err as { errorName?: string }).errorName === GAS_CAP_EXCEEDED;
    if (capped || stepFailed(id, entry, 'reject', err, ctx)) {
      entry.gaveUp = true;
      const error = capped
        ? `gave up: ${errorText(err)}; the requester can call refundExpired after the timeout`
        : `gave up after ${entry.failures} failed rejects (${errorText(err)}); the requester can call refundExpired after the timeout`;
      withStage(ctx.store.status, key, { error }, ctx.effects.now());
      ctx.emit({ type: 'worker-gave-up', id: key, error });
      return 'gave-up';
    }
    return 'open';
  }
  withStage(ctx.store.status, key, { stage: 'rejected', txs: { reject: tx.hash }, addGasWei: tx.gasCostWei, error: detail ? `${reason}: ${detail}` : reason }, ctx.effects.now());
  delete ctx.store.state.requests[key];
  ctx.emit({ type: 'worker-rejected', id: key, reason, detail, txHash: tx.hash, gasCostWei: tx.gasCostWei.toString() });
  return 'rejected';
}

async function withRetries<T>(
  ctx: Ctx,
  id: string,
  step: WorkerStep,
  fn: () => Promise<T>,
  retryIf: (err: unknown) => boolean = () => true,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      if (attempt >= ctx.config.maxAttempts || !retryIf(err)) return { ok: false, error: err };
      ctx.emit({ type: 'worker-retry', id, step, attempt, error: errorText(err) });
      const delays = ctx.config.retryDelaysMs;
      await ctx.effects.sleep(delays.length ? delays[Math.min(attempt - 1, delays.length - 1)]! : 0);
    }
  }
}

// ---------------------------------------------------------------- live effects

export interface LiveWorkerEffectsInput {
  desk: WorkerDesk;
  /** The desk chain: its latest block's timestamp is the desk's clock, and the worker's nonce is read there. */
  deskClient: Pick<PublicClient, 'getBlock' | 'getTransactionCount'>;
  /** Registry client with the worker's wallet (the worker must be an issuer). */
  registry: Pick<AttestationRegistryClient, 'attest' | 'attestTx' | 'latest' | 'isIssuer'>;
  /** The worker's address (the desk's worker, a registry issuer). */
  workerAddress: Address;
  subjectClient: StandardCheckClient & SubjectClient & Pick<PublicClient, 'getBlock'>;
  subjectChainId: number;
  /** RPC forge forks from; the same node subjectClient reads. */
  subjectRpcUrl: string;
  projectDir: string;
  /** reportURI = <reportBaseUrl>/<chainId>/<address>/<block>-<hash8>.json. No trailing slash. */
  reportBaseUrl: string;
  runs: number;
  cacheDir?: string;
  /** runStandardCheck by default; tests pass a stand-in. */
  runCheck?: (input: RunStandardCheckInput) => Promise<StandardCheckReport>;
  onCheckEvent?: (e: StandardCheckEvent) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

/**
 * The effects of a real worker: reads and forks the subject chain, runs the ERC-4626 suite (runStandardCheck,
 * report under .specfirst/checks like `specfirst check`) within the budget the loop passes, copies the report
 * to certs/checks/<chainId>/<address>/<block>-<hash8>.json (the cert attest rule), attests with the registry
 * (the nonce fixed before sending, so the loop can record it with the hash) and looks attest transactions up.
 */
export function liveWorkerEffects(i: LiveWorkerEffectsInput): WorkerEffects {
  return {
    desk: i.desk,
    workerAddress: i.workerAddress,
    subjectChainId: i.subjectChainId,
    latestSubjectBlock: () => i.subjectClient.getBlockNumber({ cacheTime: 0 }),
    subjectBlockTime: async (block) => (await i.subjectClient.getBlock({ blockNumber: block })).timestamp,
    deskTime: async () => (await i.deskClient.getBlock({ blockTag: 'latest' })).timestamp,
    precheck: (subject, block) => precheckErc4626(i.subjectClient, subject, block),
    runCheck: (subject, block, timeoutSec) => runSubjectCheck({ ...i, timeoutSec }, subject, block),
    saveReport: (report) => saveReportCopy(i.projectDir, i.reportBaseUrl, report),
    loadReport: (reportPath) => loadReportCopy(i.projectDir, reportPath),
    verifySubject: (report) => verifySubjectCode(i.subjectClient, report, { allowUnknownProxy: true }),
    attest: async (params, send) => {
      const out = await i.registry.attest(params, send);
      return { id: out.id, hash: out.hash, gasCostWei: out.gasUsed * out.effectiveGasPrice };
    },
    attestTxStatus: async (sent) => {
      const st = await i.registry.attestTx(sent.hash);
      if (st.state !== 'unknown') return st;
      const used = await i.deskClient.getTransactionCount({ address: i.workerAddress, blockTag: 'latest' });
      return { state: 'dropped', nonceUsed: used > sent.nonce };
    },
    latestAttestation: (subjectChainId, subject, standardId) => i.registry.latest(subjectChainId, subject, standardId),
    isIssuer: (who) => i.registry.isIssuer(who),
    sleep: i.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: i.now ?? (() => new Date()),
  };
}
