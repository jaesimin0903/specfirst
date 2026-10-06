import { SECONDS_PER_DAY } from './contract';
import type { Subscription } from './read';

/*
 * Money arithmetic of CheckSubscriptions as ADR 0006 states it, for the pages: a started day counts as elapsed,
 * cancel settles and refunds the days not started. Pure; bigint wei, unix seconds.
 */

type Sub = Pick<Subscription, 'feePerDayWei' | 'startsAt' | 'endsAt' | 'paidWei' | 'cancelled'>;

/** Whole days paid for: (endsAt - startsAt) / 1 day. */
export function daysOf(s: Pick<Subscription, 'startsAt' | 'endsAt'>): number {
  return s.endsAt > s.startsAt ? Number((s.endsAt - s.startsAt) / SECONDS_PER_DAY) : 0;
}

/** Days that have started by `nowSec`, the current one included, at most the days paid for. */
export function startedDays(s: Pick<Subscription, 'startsAt' | 'endsAt'>, nowSec: number): number {
  const now = BigInt(nowSec);
  if (now < s.startsAt) return 0;
  const started = Number((now - s.startsAt) / SECONDS_PER_DAY) + 1;
  return Math.min(started, daysOf(s));
}

/**
 * What cancel would return at `nowSec`: the fee of the days not started. Zero once cancelled or ended. An
 * estimate for the button; the Cancelled event carries the real amount.
 */
export function refundEstimate(s: Sub, nowSec: number): bigint {
  if (s.cancelled || BigInt(nowSec) >= s.endsAt) return 0n;
  const kept = s.feePerDayWei * BigInt(startedDays(s, nowSec));
  return s.paidWei > kept ? s.paidWei - kept : 0n;
}

export function priceOf(feePerDayWei: bigint, days: number): bigint {
  return feePerDayWei * BigInt(days);
}

export interface ContractMoney {
  earnedWei: bigint | null;
  withdrawnWei: bigint | null;
  escrowedWei: bigint | null;
}

export interface CombinedRevenue {
  desk: ContractMoney | null;
  subs: ContractMoney | null;
  earnedWei: bigint | null;
  escrowedWei: bigint | null;
  withdrawnWei: bigint | null;
  deskGasWei: bigint | null;
  watcherGasWei: bigint | null;
  gasWei: bigint | null;
  /** earned (both contracts) - gas (both processes); null until something was earned or spent is known. */
  netWei: bigint | null;
  /** Figures that went into the totals; what is missing is said, not counted as zero. */
  missing: string[];
}

function sum(values: Array<bigint | null>): bigint | null {
  const known = values.filter((v): v is bigint => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0n) : null;
}

/**
 * Desk fees and subscription fees side by side, against the gas the desk worker and the watcher report. A
 * contract that is not deployed or could not be read is left out of the sums and listed in `missing`.
 */
export function combineRevenue(i: { desk: ContractMoney | null; subs: ContractMoney | null; deskGasWei: bigint | null; watcherGasWei: bigint | null }): CombinedRevenue {
  const missing: string[] = [];
  if (!i.desk || i.desk.earnedWei === null) missing.push('desk fees');
  if (!i.subs || i.subs.earnedWei === null) missing.push('subscription fees');
  if (i.deskGasWei === null) missing.push('desk worker gas');
  if (i.watcherGasWei === null) missing.push('watcher gas');
  const earned = sum([i.desk?.earnedWei ?? null, i.subs?.earnedWei ?? null]);
  const gas = sum([i.deskGasWei, i.watcherGasWei]);
  return {
    desk: i.desk,
    subs: i.subs,
    earnedWei: earned,
    escrowedWei: sum([i.desk?.escrowedWei ?? null, i.subs?.escrowedWei ?? null]),
    withdrawnWei: sum([i.desk?.withdrawnWei ?? null, i.subs?.withdrawnWei ?? null]),
    deskGasWei: i.deskGasWei,
    watcherGasWei: i.watcherGasWei,
    gasWei: gas,
    netWei: earned === null && gas === null ? null : (earned ?? 0n) - (gas ?? 0n),
    missing,
  };
}
