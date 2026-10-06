import type { DeskViewJson } from '../desk/types';
import { toWei } from '../desk/format';
import { readStatus, watchedChains } from '../watch/read';
import { combineRevenue, type ContractMoney } from './economics';
import { subsSummary } from './service';

/*
 * /desk's "both contracts" section: desk fees and subscription fees, against the gas the desk worker and the
 * watcher report in their status files. Server only.
 */

export interface RevenueJson {
  desk: { deployed: boolean; earnedWei: string | null; escrowedWei: string | null; withdrawnWei: string | null };
  subs: {
    deployed: boolean;
    address: string | null;
    earnedWei: string | null;
    escrowedWei: string | null;
    withdrawnWei: string | null;
    feePerDayWei: string | null;
    count: string | null;
    errors: string[];
  };
  earnedWei: string | null;
  escrowedWei: string | null;
  withdrawnWei: string | null;
  deskGasWei: string | null;
  watcherGasWei: string | null;
  /** Chains whose watcher status.json reported gasCostWei. */
  watcherGasChains: number[];
  gasWei: string | null;
  netWei: string | null;
  missing: string[];
}

const str = (v: bigint | null | undefined): string | null => (v === null || v === undefined ? null : v.toString());

/** Sum of gasCostWei over every watched chain that reports it; null when none does. */
export async function watcherGas(): Promise<{ wei: bigint | null; chains: number[] }> {
  const chains = await watchedChains();
  let wei: bigint | null = null;
  const reported: number[] = [];
  for (const c of chains) {
    const s = await readStatus(c);
    if (s.gasCostWei !== null) {
      wei = (wei ?? 0n) + s.gasCostWei;
      reported.push(c);
    }
  }
  return { wei, chains: reported };
}

export async function revenueView(desk: DeskViewJson): Promise<RevenueJson> {
  const [{ address, summary, error }, gas] = await Promise.all([subsSummary(), watcherGas()]);
  const deskMoney: ContractMoney | null = desk.summary.deployed
    ? { earnedWei: toWei(desk.economics.earnedWei), withdrawnWei: toWei(desk.economics.withdrawnWei), escrowedWei: toWei(desk.economics.escrowedWei) }
    : null;
  const subsMoney: ContractMoney | null = summary
    ? { earnedWei: summary.earnedWei, withdrawnWei: summary.withdrawnWei, escrowedWei: summary.escrowedWei }
    : null;
  const r = combineRevenue({ desk: deskMoney, subs: subsMoney, deskGasWei: toWei(desk.economics.gasCostWei), watcherGasWei: gas.wei });
  return {
    desk: {
      deployed: desk.summary.deployed,
      earnedWei: str(deskMoney?.earnedWei),
      escrowedWei: str(deskMoney?.escrowedWei),
      withdrawnWei: str(deskMoney?.withdrawnWei),
    },
    subs: {
      deployed: address !== null,
      address,
      earnedWei: str(summary?.earnedWei),
      escrowedWei: str(summary?.escrowedWei),
      withdrawnWei: str(summary?.withdrawnWei),
      feePerDayWei: str(summary?.feePerDayWei),
      count: str(summary?.count),
      errors: [...(summary?.errors ?? []), ...(error ? [error] : [])],
    },
    earnedWei: str(r.earnedWei),
    escrowedWei: str(r.escrowedWei),
    withdrawnWei: str(r.withdrawnWei),
    deskGasWei: str(r.deskGasWei),
    watcherGasWei: str(r.watcherGasWei),
    watcherGasChains: gas.chains,
    gasWei: str(r.gasWei),
    netWei: str(r.netWei),
    missing: r.missing,
  };
}
