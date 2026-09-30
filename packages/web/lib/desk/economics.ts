import { formatMon, percent } from './format';

/*
 * What the desk earns. Money facts come from the contract (earned, withdrawn, escrowed, fee); request counts from
 * scanning requestOf; the worker's gas bill from status.json totals. Pure.
 */

export interface RequestCounts {
  total: number;
  pending: number;
  fulfilled: number;
  rejected: number;
  refunded: number;
  /** Pending requests past their timeout, refundable by anyone. */
  expired: number;
  /** Sum of the fees of every scanned request, whatever happened to it. */
  paidWei: bigint;
  /** Fees returned by reject or refundExpired. */
  returnedWei: bigint;
  /** True when requestCount() was larger than the scan; counts then cover the latest requests only. */
  truncated: boolean;
}

export interface EconomicsInput {
  feeWei: bigint | null;
  earnedWei: bigint | null;
  withdrawnWei: bigint | null;
  escrowedWei: bigint | null;
  counts: RequestCounts | null;
  /** status.json totals.gasCostWei: every attest, fulfil and reject transaction the worker paid for. */
  gasCostWei: bigint | null;
  workerFulfilled: number | null;
  workerRejected: number | null;
}

export interface Economics {
  feeWei: bigint | null;
  earnedWei: bigint | null;
  withdrawnWei: bigint | null;
  escrowedWei: bigint | null;
  /** earned - withdrawn: what the owner can still withdraw. */
  withdrawableWei: bigint | null;
  gasCostWei: bigint | null;
  /** earned - gas. Null until both are known. */
  netWei: bigint | null;
  /** net / earned in percent, two decimals. */
  marginPct: number | null;
  /** Worker gas per finished request (fulfilled or rejected: a reject costs gas and earns nothing). */
  gasPerCheckWei: bigint | null;
  /** fee - gas per check: what one more fulfilled check adds, if costs stay where they are. */
  unitProfitWei: bigint | null;
  counts: RequestCounts | null;
  /** One sentence for someone deciding whether this is a business. */
  summary: string;
}

export function emptyCounts(): RequestCounts {
  return { total: 0, pending: 0, fulfilled: 0, rejected: 0, refunded: 0, expired: 0, paidWei: 0n, returnedWei: 0n, truncated: false };
}

/** Tallies decoded requests. `nowSec` and `timeoutSec` mark pending ones past their timeout. */
export function countRequests(
  requests: ReadonlyArray<{ status: string; feeWei: bigint; requestedAt: bigint | number }>,
  opts: { total: number; nowSec: number; timeoutSec: number | null },
): RequestCounts {
  const c = emptyCounts();
  c.total = opts.total;
  c.truncated = requests.length < opts.total;
  for (const r of requests) {
    c.paidWei += r.feeWei;
    if (r.status === 'Pending') {
      c.pending++;
      if (opts.timeoutSec !== null && opts.nowSec >= Number(r.requestedAt) + opts.timeoutSec) c.expired++;
    } else if (r.status === 'Fulfilled') c.fulfilled++;
    else if (r.status === 'Rejected') {
      c.rejected++;
      c.returnedWei += r.feeWei;
    } else if (r.status === 'Refunded') {
      c.refunded++;
      c.returnedWei += r.feeWei;
    }
  }
  return c;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function computeEconomics(i: EconomicsInput): Economics {
  const earned = i.earnedWei;
  const gas = i.gasCostWei;
  const net = earned !== null && gas !== null ? earned - gas : null;
  const finished = (i.workerFulfilled ?? i.counts?.fulfilled ?? 0) + (i.workerRejected ?? i.counts?.rejected ?? 0);
  const gasPerCheck = gas !== null && finished > 0 ? gas / BigInt(finished) : null;
  const e: Omit<Economics, 'summary'> = {
    feeWei: i.feeWei,
    earnedWei: earned,
    withdrawnWei: i.withdrawnWei,
    escrowedWei: i.escrowedWei,
    withdrawableWei: earned !== null && i.withdrawnWei !== null ? earned - i.withdrawnWei : null,
    gasCostWei: gas,
    netWei: net,
    marginPct: net !== null && earned !== null ? percent(net, earned) : null,
    gasPerCheckWei: gasPerCheck,
    unitProfitWei: gasPerCheck !== null && i.feeWei !== null ? i.feeWei - gasPerCheck : null,
    counts: i.counts,
  };
  return { ...e, summary: summarize(e) };
}

function summarize(e: Omit<Economics, 'summary'>): string {
  const c = e.counts;
  const fee = e.feeWei !== null ? formatMon(e.feeWei) : null;
  if (!c || c.total === 0) {
    return fee
      ? `No check has been paid for yet. Each one costs ${fee}, held in escrow and earned only when its attestation lands onchain.`
      : 'The desk could not be read, so there is nothing to report yet.';
  }
  const parts: string[] = [];
  const scope = c.truncated ? `Of the latest ${plural(c.fulfilled + c.pending + c.rejected + c.refunded, 'paid check')}` : `Of ${plural(c.total, 'paid check')}`;
  parts.push(`${scope}, ${c.fulfilled} ${c.fulfilled === 1 ? 'was' : 'were'} fulfilled`);
  let s = parts.join('');
  if (e.earnedWei !== null && e.netWei !== null && e.gasCostWei !== null) {
    s += `, earning ${formatMon(e.earnedWei)} against ${formatMon(e.gasCostWei)} of worker gas: ${formatMon(e.netWei)} net`;
    if (e.marginPct !== null) s += `, a ${e.marginPct.toFixed(e.marginPct % 1 === 0 ? 0 : 1)}% margin`;
    s += '.';
  } else if (e.earnedWei !== null) {
    s += `, earning ${formatMon(e.earnedWei)}. Worker gas is not reported yet, so there is no net figure.`;
  } else {
    s += '.';
  }
  if (c.pending > 0 && e.escrowedWei !== null) s += ` ${formatMon(e.escrowedWei)} waits in escrow for ${plural(c.pending, 'check')} in progress.`;
  const returned = c.rejected + c.refunded;
  if (returned > 0) s += ` ${plural(returned, 'request')} ended without a result and got the fee back.`;
  return s;
}
