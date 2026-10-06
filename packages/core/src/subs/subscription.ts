import type { Address, Hex } from 'viem';

/** Length of one paid day in CheckSubscriptions, in seconds of block.timestamp. */
export const SUBSCRIPTION_DAY_SECONDS = 86_400n;
/** Most days one subscribe or extend can pay for. */
export const MAX_SUBSCRIPTION_DAYS = 365;

/** CheckSubscriptions.Subscription as viem decodes it. */
export interface Subscription {
  subscriber: Address;
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
  feePerDay: bigint;
  /** Start of the current run: block.timestamp of subscribe, or of an extend after the subscription expired. */
  startsAt: bigint;
  /** End of the current run, exclusive; startsAt plus whole days. */
  endsAt: bigint;
  /** Sum of the fees paid (subscribe and every extend). */
  paid: bigint;
  /** Part of paid moved to earned. */
  settled: bigint;
  cancelled: boolean;
}

type Run = Pick<Subscription, 'startsAt' | 'endsAt' | 'feePerDay' | 'paid' | 'settled' | 'cancelled'>;

/** isActive(id) of the contract at block timestamp `now`: not cancelled and now < endsAt. */
export function isActiveAt(s: Pick<Subscription, 'endsAt' | 'cancelled'>, now: bigint): boolean {
  return !s.cancelled && now < s.endsAt;
}

/** Whole days of the current run, (endsAt - startsAt) / 86400. */
export function runDaysOf(s: Pick<Subscription, 'startsAt' | 'endsAt'>): bigint {
  return (s.endsAt - s.startsAt) / SUBSCRIPTION_DAY_SECONDS;
}

/**
 * Days of the current run that have started at `now`: a day that has started counts as used, so the first day
 * counts from startsAt and, exactly at a day boundary, the next day has started. Capped at the run's days.
 */
export function startedDaysAt(s: Pick<Subscription, 'startsAt' | 'endsAt'>, now: bigint): bigint {
  const days = runDaysOf(s);
  if (now >= s.endsAt) return days;
  if (now < s.startsAt) return 0n;
  return (now - s.startsAt) / SUBSCRIPTION_DAY_SECONDS + 1n;
}

/** The fee of the started days, earlier runs included: paid minus the fee of the days of the run not started. */
export function dueAt(s: Run, now: bigint): bigint {
  return s.paid - (runDaysOf(s) - startedDaysAt(s, now)) * s.feePerDay;
}

/** What settle([id]) would move to earned at `now`; 0 for a cancelled subscription. */
export function settleableAt(s: Run, now: bigint): bigint {
  return s.cancelled ? 0n : dueAt(s, now) - s.settled;
}

/** What cancel(id) would refund at `now`: the fee of the days not started; 0 for a cancelled subscription. */
export function refundAt(s: Run, now: bigint): bigint {
  return s.cancelled ? 0n : s.paid - dueAt(s, now);
}
