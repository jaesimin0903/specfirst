/*
 * Money arithmetic for the subscription pages that core does not cover: the price of a choice, and desk and
 * subscription fees together against both gas bills. The day accounting itself (runDaysOf, startedDaysAt,
 * refundAt) is core's, in lib/subs/core.ts. Pure; bigint wei.
 */

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
  /** earned (both contracts) - gas (both processes); null until some earnings and some gas are known. */
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
export function combineRevenue(i: {
  desk: ContractMoney | null;
  subs: ContractMoney | null;
  deskGasWei: bigint | null;
  watcherGasWei: bigint | null;
}): CombinedRevenue {
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
    netWei: earned !== null && gas !== null ? earned - gas : null,
    missing,
  };
}
