import type { Address, Hex } from 'viem';
import { attestationParamsFromReport, AttestationError, standardIdOf, type AttestParams } from '../attest/params.js';
import { ATTESTATION_STATUS, type AttestationRegistryClient } from '../attest/registry.js';
import {
  checkBlockOf,
  countsAsFailure,
  DEFAULT_BLOCK_LAG,
  errorText,
  loadReportCopy,
  precheckErc4626,
  runSubjectCheck,
  saveReportCopy,
  type Erc4626Precheck,
} from '../attest/subjectCheck.js';
import { verifySubjectCode, type SubjectClient, type SubjectCodeCheck } from '../attest/verify.js';
import { isRateLimited, isTransportFailure } from '../chain/transport.js';
import type { RunStandardCheckInput, StandardCheckClient, StandardCheckEvent } from '../standards/check.js';
import type { StandardCheckReport } from '../standards/report.js';
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
export type WorkerDesk = Pick<RequestDeskClient, 'requestCount' | 'requestOf' | 'fulfill' | 'reject'>;

/** DeskError name of a reject whose gas estimate is above WorkerConfig.maxRejectGas. */
export const GAS_CAP_EXCEEDED = 'GasCapExceeded';



/**
 * Everything the worker does outside its own files, injected so the loop is testable: desk reads and
 * writes, the subject chain, the property suite, report copies, the identity check and the attestation.
 */
export interface WorkerEffects {
  desk: WorkerDesk;
  /** The one subject chain this worker reads. Requests for other chains are rejected (unsupported-chain). */
  subjectChainId: number;
  latestSubjectBlock(): Promise<bigint>;
  precheck(subject: Address, block: bigint): Promise<Erc4626Precheck>;
  runCheck(subject: Address, block: bigint): Promise<StandardCheckReport>;
  /** Writes the report copy under certs/checks; returns its repository relative path and its public URI. */
  saveReport(report: StandardCheckReport): Promise<{ reportPath: string; reportURI: string }>;
  loadReport(reportPath: string): Promise<StandardCheckReport>;
  /** verifySubjectCode with allowUnknownProxy, so the worker decides about unknown proxies itself. */
  verifySubject(report: StandardCheckReport): Promise<SubjectCodeCheck>;
  attest(params: AttestParams): Promise<{ id: bigint; hash: Hex; gasCostWei: bigint }>;
  /**
   * The latest registry attestation of (subjectChainId, subject, standardId) when it is Valid and this worker
   * issued it, else null. Lets a request be fulfilled with an attestation the worker already made (after a
   * crash between attest and saving state, or for another request of the same subject) instead of attesting
   * again.
   */
  latestOwnAttestation(subjectChainId: bigint, subject: Address, standardId: Hex): Promise<{ id: bigint; issuedAt: bigint } | null>;
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
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  blockLag: DEFAULT_BLOCK_LAG,
  maxAttempts: 3,
  retryDelaysMs: [5_000, 20_000],
  maxTxFailures: 3,
  allowUnknownProxy: false,
  maxRejectGas: 300_000n,
};

export type WorkerStep = 'precheck' | 'check' | 'identity' | 'save' | 'attest' | 'fulfill' | 'reject';

export type WorkerEvent =
  | { type: 'worker-pass'; requestCount: string; cursor: string; open: string[] }
  | { type: 'worker-stage'; id: string; stage: WorkerStage; block?: string; reportPath?: string; attestationId?: string; txHash?: Hex }
  | { type: 'worker-retry'; id: string; step: WorkerStep; attempt: number; error: string }
  | { type: 'worker-step-failed'; id: string; step: WorkerStep; failures: number; error: string }
  | { type: 'worker-fulfilled'; id: string; attestationId: string; txHash: Hex; gasCostWei: string }
  | { type: 'worker-rejected'; id: string; reason: RejectReason; detail: string; txHash: Hex; gasCostWei: string }
  | { type: 'worker-closed'; id: string; status: RequestStatusName }
  | { type: 'worker-reused'; id: string; attestationId: string }
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

/** An attestation this worker issued can deliver a request when it was issued at or after the request. */
export function canDeliver(a: { issuedAt: bigint } | null, r: Pick<DeskRequest, 'requestedAt'>): boolean {
  return a !== null && a.issuedAt >= r.requestedAt;
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
 * One pass over the desk: reads requestCount() and requestOf(cursor .. count - 1) (no event logs, so it
 * stays under RPC log range and rate limits), marks new Pending requests queued, then works through them
 * one at a time in id order and advances the cursor past every closed request. Per Pending request: screen
 * (standard, chain), pre-check the subject at latest - lag (no ERC-4626: reject not-erc4626), run the suite
 * (retries, then reject check-failed), save the report copy, check the identity on the subject chain, attest,
 * fulfill. Before checking and again before attesting, a Valid attestation this worker issued after the
 * request is reused instead (so a crash between attest and saving state never attests twice). A request
 * whose step throws unexpectedly is recorded with its error and retried in the next pass, and rejected with
 * check-failed after maxTxFailures such passes; RPC outages never count. The pass itself only throws when the
 * desk cannot be read at all.
 */
export async function runWorkerPass(input: RunWorkerPassInput): Promise<WorkerPassResult> {
  const { effects, store } = input;
  const config: WorkerConfig = { ...DEFAULT_WORKER_CONFIG, ...input.config };
  const emit = input.onEvent ?? (() => {});
  const { desk } = effects;
  const state = store.state;

  const count = await desk.requestCount();
  const start = BigInt(state.cursor);
  if (start > count) throw new Error(`state cursor ${start} is past requestCount ${count}; state.json does not belong to this desk`);
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
      const outcome = await processRequest(s.id, request, { effects, store, config, emit });
      if (outcome === 'fulfilled') fulfilled.push(s.id);
      if (outcome === 'rejected') rejected.push(s.id);
      if (outcome !== 'open') closed.add(s.id);
    } catch (err) {
      const error = errorText(err);
      withStage(store.status, key, { error }, effects.now());
      emit({ type: 'worker-error', id: key, error });
      // An error outside the transaction steps (a report that cannot be written, a broken file) would rerun
      // the whole check every pass. After maxTxFailures such passes the request is rejected and refunded.
      const entry = state.requests[key];
      if (entry && countsAsUnexpected(err) && !entry.attestationId && !entry.reject) {
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

/** Errors thrown out of a request that are not RPC outages or rate limits. */
function countsAsUnexpected(err: unknown): boolean {
  return !(isTransportFailure(err) || isRateLimited(err));
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
}

type Outcome = 'fulfilled' | 'rejected' | 'gave-up' | 'closed' | 'open';

async function processRequest(id: bigint, r: DeskRequest, ctx: Ctx): Promise<Outcome> {
  const { effects, store, config, emit } = ctx;
  const key = String(id);
  const entry: WorkerStateEntry = (store.state.requests[key] ??= { failures: 0 });
  const stage = (s: WorkerStage, extra: Partial<WorkerRequestStatus> = {}) => {
    withStage(store.status, key, { stage: s, error: undefined, ...extra }, effects.now());
    emit({ type: 'worker-stage', id: key, stage: s, ...pickEventFields(extra) });
  };

  if (entry.reject) return doReject(id, entry, ctx);
  if (entry.attestationId) return doFulfill(id, entry, ctx);

  const screen = screenRequest(r, effects.subjectChainId);
  if (!screen.ok) {
    stage('prechecking');
    return decideReject(id, entry, screen.reason, screen.detail, ctx);
  }
  // An attestation this worker already made after the request delivers it: no second check or attest.
  if (await reuseOwnAttestation(id, r, entry, ctx)) return doFulfill(id, entry, ctx);

  let report: StandardCheckReport | undefined;
  if (entry.reportPath && entry.reportURI) {
    try {
      report = await effects.loadReport(entry.reportPath);
    } catch (err) {
      // The saved copy is gone or broken: check again from the start.
      emit({ type: 'worker-step-failed', id: key, step: 'save', failures: entry.failures, error: `saved report unreadable, checking again: ${errorText(err)}` });
      delete entry.reportPath;
      delete entry.reportURI;
      delete entry.block;
    }
  }

  if (!report) {
    stage('prechecking');
    const pre = await withRetries(ctx, key, 'precheck', async () => {
      const block = checkBlockOf(await effects.latestSubjectBlock(), config.blockLag);
      return { block, result: await effects.precheck(r.subject, block) };
    });
    if (!pre.ok) return decideReject(id, entry, 'check-failed', `pre-check: ${errorText(pre.error)}`, ctx);
    if (!pre.value.result.ok) return decideReject(id, entry, 'not-erc4626', pre.value.result.reason, ctx);
    const block = pre.value.block;
    stage('running', { block: block.toString() });
    const run = await withRetries(ctx, key, 'check', () => effects.runCheck(r.subject, block));
    if (!run.ok) return decideReject(id, entry, 'check-failed', `check: ${errorText(run.error)}`, ctx);
    report = run.value;
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
  if (!identity.ok) return decideReject(id, entry, 'check-failed', `identity: ${errorText(identity.error)}`, ctx);
  if (identity.value.unknownProxy && !config.allowUnknownProxy) {
    return decideReject(id, entry, 'unknown-proxy', `${r.subject} is proxy-shaped but its implementation could not be resolved`, ctx);
  }
  let params: AttestParams;
  try {
    params = attestationParamsFromReport(checked, { reportURI: entry.reportURI! });
  } catch (err) {
    if (err instanceof AttestationError) return decideReject(id, entry, 'check-failed', `report: ${err.message}`, ctx);
    throw err;
  }
  // The check took minutes: do not attest for a request that was refunded meanwhile, and do not attest twice.
  const fresh = await effects.desk.requestOf(id);
  if (fresh.status !== PENDING) {
    observeClosed(id, fresh, store, effects, emit);
    return 'closed';
  }
  if (await reuseOwnAttestation(id, r, entry, ctx)) return doFulfill(id, entry, ctx);
  let attested;
  try {
    attested = await effects.attest(params);
  } catch (err) {
    if (stepFailed(id, entry, 'attest', err, ctx)) return decideReject(id, entry, 'attest-failed', errorText(err), ctx);
    return 'open';
  }
  entry.attestationId = attested.id.toString();
  entry.failures = 0;
  withStage(store.status, key, { stage: 'fulfilling', attestationId: entry.attestationId, txs: { attest: attested.hash }, addGasWei: attested.gasCostWei, error: undefined }, effects.now());
  emit({ type: 'worker-stage', id: key, stage: 'fulfilling', attestationId: entry.attestationId, txHash: attested.hash });
  await store.save();
  return doFulfill(id, entry, ctx);
}

/** Records a Valid attestation of this worker, issued at or after the request, as the request's delivery. */
async function reuseOwnAttestation(id: bigint, r: DeskRequest, entry: WorkerStateEntry, ctx: Ctx): Promise<boolean> {
  const own = await ctx.effects.latestOwnAttestation(r.subjectChainId, r.subject, r.standardId);
  if (!own || !canDeliver(own, r)) return false;
  const key = String(id);
  entry.attestationId = own.id.toString();
  entry.failures = 0;
  withStage(ctx.store.status, key, { stage: 'fulfilling', attestationId: entry.attestationId, error: undefined }, ctx.effects.now());
  ctx.emit({ type: 'worker-reused', id: key, attestationId: entry.attestationId });
  ctx.emit({ type: 'worker-stage', id: key, stage: 'fulfilling', attestationId: entry.attestationId });
  await ctx.store.save();
  return true;
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
 */
function stepFailed(id: bigint, entry: WorkerStateEntry, step: WorkerStep, err: unknown, ctx: Ctx): boolean {
  const counted = countsAsFailure(err);
  if (counted) entry.failures += 1;
  const error = errorText(err);
  const note = counted ? `${entry.failures} of ${ctx.config.maxTxFailures}` : 'not counted, RPC';
  withStage(ctx.store.status, String(id), { error: `${step} failed (${note}): ${error}` }, ctx.effects.now());
  ctx.emit({ type: 'worker-step-failed', id: String(id), step, failures: entry.failures, error });
  return counted && entry.failures >= ctx.config.maxTxFailures;
}

async function doFulfill(id: bigint, entry: WorkerStateEntry, ctx: Ctx): Promise<Outcome> {
  const key = String(id);
  let tx: DeskTx;
  try {
    tx = await ctx.effects.desk.fulfill(id, BigInt(entry.attestationId!));
  } catch (err) {
    if (stepFailed(id, entry, 'fulfill', err, ctx)) return decideReject(id, entry, 'fulfill-failed', errorText(err), ctx);
    return 'open';
  }
  withStage(ctx.store.status, key, { stage: 'fulfilled', attestationId: entry.attestationId, txs: { fulfill: tx.hash }, addGasWei: tx.gasCostWei, error: undefined }, ctx.effects.now());
  delete ctx.store.state.requests[key];
  ctx.emit({ type: 'worker-fulfilled', id: key, attestationId: entry.attestationId!, txHash: tx.hash, gasCostWei: tx.gasCostWei.toString() });
  return 'fulfilled';
}

async function decideReject(id: bigint, entry: WorkerStateEntry, reason: RejectReason, detail: string, ctx: Ctx): Promise<Outcome> {
  entry.reject = reason;
  entry.detail = detail;
  entry.failures = 0;
  await ctx.store.save();
  return doReject(id, entry, ctx);
}

async function doReject(id: bigint, entry: WorkerStateEntry, ctx: Ctx): Promise<Outcome> {
  const key = String(id);
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
  /** Registry client with the worker's wallet (the worker must be an issuer). */
  registry: Pick<AttestationRegistryClient, 'attest' | 'latest'>;
  /** The worker's address: only its own attestations are reused. */
  workerAddress: Address;
  subjectClient: StandardCheckClient & SubjectClient;
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
 * report under .specfirst/checks like `specfirst check`), copies the report to
 * certs/checks/<chainId>/<address>/<block>-<hash8>.json (the cert attest rule) and attests with the registry.
 */
export function liveWorkerEffects(i: LiveWorkerEffectsInput): WorkerEffects {
  return {
    desk: i.desk,
    subjectChainId: i.subjectChainId,
    latestSubjectBlock: () => i.subjectClient.getBlockNumber({ cacheTime: 0 }),
    precheck: (subject, block) => precheckErc4626(i.subjectClient, subject, block),
    runCheck: (subject, block) => runSubjectCheck(i, subject, block),
    saveReport: (report) => saveReportCopy(i.projectDir, i.reportBaseUrl, report),
    loadReport: (reportPath) => loadReportCopy(i.projectDir, reportPath),
    verifySubject: (report) => verifySubjectCode(i.subjectClient, report, { allowUnknownProxy: true }),
    attest: async (params) => {
      const out = await i.registry.attest(params);
      return { id: out.id, hash: out.hash, gasCostWei: out.gasUsed * out.effectiveGasPrice };
    },
    latestOwnAttestation: async (subjectChainId, subject, standardId) => {
      const latest = await i.registry.latest(subjectChainId, subject, standardId);
      if (!latest) return null;
      const a = latest.attestation;
      if (ATTESTATION_STATUS[a.status] !== 'Valid' || a.issuer.toLowerCase() !== i.workerAddress.toLowerCase()) return null;
      return { id: latest.id, issuedAt: a.issuedAt };
    },
    sleep: i.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: i.now ?? (() => new Date()),
  };
}
