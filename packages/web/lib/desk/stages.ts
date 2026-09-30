import type { RequestStatusName, WorkerRequestStatus, WorkerStage } from './contract';
import { decodeRejectCode, rejectReasonText } from './contract';
import { toIso } from './format';
import { PROPERTY_COUNT } from './config';

/*
 * Where a request is, from two sources: the desk's requestOf (the truth about money: Pending, Fulfilled,
 * Rejected, Refunded) and the worker's status.json (how far the check got). The chain always wins: a worker
 * that says "fulfilled" while the request is still Pending means the fulfil transaction has not landed yet.
 * Pure, so the server API and the tests share it.
 */

export type StepKey = 'paid' | 'queued' | 'prechecking' | 'running' | 'attesting' | 'outcome';
/** done: finished; active: happening now; waiting: not reached yet; failed: ended the request; skipped: never reached. */
export type StepState = 'done' | 'active' | 'waiting' | 'failed' | 'skipped';
export type Outcome = 'fulfilled' | 'rejected' | 'refunded' | 'expired' | null;

export interface Step {
  key: StepKey;
  label: string;
  state: StepState;
  detail: string | null;
  /** When the step started or ended, ISO 8601, when known. */
  at: string | null;
}

export interface Progress {
  steps: Step[];
  outcome: Outcome;
  /** The step that is happening now, null once the request has ended. */
  activeKey: StepKey | null;
  /** The request has ended onchain (Fulfilled, Rejected or Refunded). Polling can stop. */
  terminal: boolean;
  /** Pending past requestedAt + timeout: anyone may call refundExpired. */
  expired: boolean;
  refundable: boolean;
  expiresAt: string | null;
  /** Seconds until refundExpired opens; 0 once it has, null when the request is not pending. */
  secondsToExpiry: number | null;
  source: 'chain' | 'chain+worker';
  rejectCode: string | null;
  rejectText: string | null;
  /** Anything the reader should know that the steps do not say. */
  note: string | null;
}

export interface ProgressInput {
  status: RequestStatusName;
  /** requestOf(id).requestedAt, unix seconds. */
  requestedAt: bigint | number;
  rejectReason?: string | null;
  /** desk.timeout(), seconds; null when it could not be read. */
  timeoutSec: bigint | number | null;
  worker: WorkerRequestStatus | null;
  /** unix seconds */
  nowSec: number;
}

const ORDER: WorkerStage[] = ['queued', 'prechecking', 'running', 'attesting', 'fulfilling', 'fulfilled', 'rejected'];
const STEP_OF_STAGE: Record<WorkerStage, StepKey> = {
  queued: 'queued',
  prechecking: 'prechecking',
  running: 'running',
  attesting: 'attesting',
  fulfilling: 'outcome',
  fulfilled: 'outcome',
  rejected: 'outcome',
};
const STEP_KEYS: StepKey[] = ['paid', 'queued', 'prechecking', 'running', 'attesting', 'outcome'];

export const STEP_LABEL: Record<Exclude<StepKey, 'outcome'>, string> = {
  paid: 'Paid',
  queued: 'Queued',
  prechecking: 'Prechecking',
  running: `Running ${PROPERTY_COUNT} properties`,
  attesting: 'Attesting onchain',
};

const STEP_DETAIL: Record<Exclude<StepKey, 'outcome' | 'paid'>, string> = {
  queued: 'The worker picks requests up in order.',
  prechecking: 'Code, proxy and asset() read on Monad mainnet at a fixed block.',
  running: `Forge forks the vault and runs ${PROPERTY_COUNT} properties with fuzzed amounts.`,
  attesting: 'The report hash and results go to CheckAttestationRegistry on Monad testnet.',
};

function stageIndex(s: WorkerStage | null): number {
  return s === null ? -1 : ORDER.indexOf(s);
}

export function computeProgress(i: ProgressInput): Progress {
  const requestedAtSec = Number(i.requestedAt);
  const paidAt = requestedAtSec > 0 ? new Date(requestedAtSec * 1000).toISOString() : null;
  const timeout = i.timeoutSec === null ? null : Number(i.timeoutSec);
  const expiresAtSec = timeout !== null && requestedAtSec > 0 ? requestedAtSec + timeout : null;
  const worker = i.worker;
  const stage = worker?.stage ?? null;
  const workerAt = worker ? toIso(worker.updatedAt) : null;
  const rejectCode = decodeRejectCode(i.rejectReason);
  const base = {
    source: worker ? ('chain+worker' as const) : ('chain' as const),
    expiresAt: expiresAtSec !== null ? new Date(expiresAtSec * 1000).toISOString() : null,
    rejectCode,
    rejectText: rejectReasonText(rejectCode),
  };

  const step = (key: StepKey, state: StepState, extra: Partial<Step> = {}): Step => ({
    key,
    label: key === 'outcome' ? 'Fulfilled' : STEP_LABEL[key],
    state,
    detail: key === 'outcome' || key === 'paid' ? null : STEP_DETAIL[key],
    at: null,
    ...extra,
  });
  const paid = step('paid', 'done', { at: paidAt, detail: 'The fee sits in the desk contract, in escrow.' });

  if (i.status === 'Fulfilled') {
    return {
      ...base,
      steps: [
        { ...paid, detail: 'The fee left escrow when the request was fulfilled.' },
        ...(['queued', 'prechecking', 'running', 'attesting'] as const).map((k) => step(k, 'done')),
        step('outcome', 'done', { label: 'Fulfilled', detail: 'Attestation recorded; the fee is now earned by the desk.', at: stage === 'fulfilled' ? workerAt : null }),
      ],
      outcome: 'fulfilled',
      activeKey: null,
      terminal: true,
      expired: false,
      refundable: false,
      secondsToExpiry: null,
      note: null,
    };
  }

  if (i.status === 'Rejected' || i.status === 'Refunded') {
    const rejected = i.status === 'Rejected';
    // How far the worker got before it stopped, when it said so; the chain alone does not record it.
    const reached = rejected ? 'queued' : null;
    const steps = STEP_KEYS.slice(0, -1).map((k) =>
      k === 'paid' ? { ...paid, detail: 'The fee went back to the requester.' } : k === reached ? step(k, 'done') : step(k, 'skipped', { detail: null }),
    );
    steps.push(
      step('outcome', 'failed', {
        label: rejected ? 'Rejected' : 'Refunded',
        detail: rejected
          ? `${base.rejectText ?? 'The worker rejected the request.'} The full fee was returned in the same transaction.`
          : 'The request expired before it was fulfilled and the fee was returned to the requester.',
        at: rejected && stage === 'rejected' ? workerAt : null,
      }),
    );
    return {
      ...base,
      steps,
      outcome: rejected ? 'rejected' : 'refunded',
      activeKey: null,
      terminal: true,
      expired: false,
      refundable: false,
      secondsToExpiry: null,
      note: rejected && worker?.error ? `Worker: ${worker.error}` : null,
    };
  }

  if (i.status !== 'Pending') {
    return {
      ...base,
      steps: [step('paid', 'waiting', { detail: null })],
      outcome: null,
      activeKey: null,
      terminal: false,
      expired: false,
      refundable: false,
      secondsToExpiry: null,
      note: 'The desk has no request with this id.',
    };
  }

  // Pending: the worker says how far it got; without it, the chain says only that it was paid.
  const activeStep: StepKey = stage === null ? 'queued' : STEP_OF_STAGE[stage];
  const activeIdx = STEP_KEYS.indexOf(activeStep);
  const expired = expiresAtSec !== null && i.nowSec >= expiresAtSec;
  const steps = STEP_KEYS.map((k, idx) => {
    if (k === 'paid') return paid;
    if (idx < activeIdx) return step(k, 'done');
    if (idx > activeIdx) return step(k, 'waiting');
    // Past the timeout the step it stalled on is not failing, it simply never finished: shown as stopped, not red.
    if (k !== 'outcome') return expired ? step(k, 'skipped', { at: workerAt, detail: 'Stopped here before the timeout.' }) : step(k, 'active', { at: workerAt });
    const label = stage === 'rejected' ? 'Rejecting' : 'Fulfilling';
    const detail =
      stage === 'rejected'
        ? 'The worker is sending the reject transaction, which returns the fee.'
        : stage === 'fulfilled'
          ? 'The worker has sent the fulfil transaction; waiting for Monad testnet to include it.'
          : 'The attestation is recorded; the fulfil transaction moves the fee out of escrow.';
    return step(k, expired ? 'failed' : 'active', { label, detail, at: workerAt });
  });
  if (expired) {
    const out = steps[steps.length - 1]!;
    steps[steps.length - 1] = {
      ...out,
      label: 'Expired',
      state: 'failed',
      detail: 'The timeout passed before the request was fulfilled. Anyone can now call refundExpired to return the fee.',
    };
  }

  return {
    ...base,
    steps,
    outcome: expired ? 'expired' : null,
    activeKey: expired ? null : activeStep,
    terminal: false,
    expired,
    refundable: expired,
    secondsToExpiry: expiresAtSec === null ? null : Math.max(0, expiresAtSec - i.nowSec),
    note: worker
      ? stageIndex(stage) >= stageIndex('fulfilled')
        ? 'The worker has finished; the chain has not recorded the outcome yet.'
        : null
      : 'No worker status for this request yet. The steps after Paid follow the worker, so they start once it picks the request up.',
  };
}

/** One word for a request in a list, and how loud to show it. */
export function listLabel(
  status: RequestStatusName,
  stage: WorkerStage | null,
  expired: boolean,
): { label: string; tone: 'active' | 'done' | 'ended' } {
  if (status === 'Fulfilled') return { label: 'Fulfilled', tone: 'done' };
  if (status === 'Rejected') return { label: 'Rejected', tone: 'ended' };
  if (status === 'Refunded') return { label: 'Refunded', tone: 'ended' };
  if (status !== 'Pending') return { label: 'Unknown', tone: 'ended' };
  if (expired) return { label: 'Expired', tone: 'ended' };
  switch (stage) {
    case null:
    case 'queued':
      return { label: 'Queued', tone: 'active' };
    case 'prechecking':
      return { label: 'Prechecking', tone: 'active' };
    case 'running':
      return { label: 'Running', tone: 'active' };
    case 'attesting':
      return { label: 'Attesting', tone: 'active' };
    case 'rejected':
      return { label: 'Rejecting', tone: 'active' };
    default:
      return { label: 'Fulfilling', tone: 'active' };
  }
}
