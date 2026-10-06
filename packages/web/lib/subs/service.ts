import { memo } from '../desk/cache';
import { testnetClient } from '../desk/clients';
import { DESK_CHAIN_ID } from '../desk/config';
import type { ContractReader } from '../desk/read';
import { checksum, labelFor, vaultPathOf, type LabelContext } from '../watch/view';
import { subsAddress } from './contract';
import { isActiveAt, refundAt, runDaysOf } from './core';
import { latestSubscriptionIds, readSubsSummary, readSubscriptions, type SubscriptionWithId, type SubsSummary } from './read';
import type { SubscriptionJson, SubsSummaryJson } from './types';

/*
 * Server-side reads of CheckSubscriptions, shared by every page and poller through memo(): the summary every
 * 10 s, the scan of subscriptions every 10 s per subscription count. A scan reads the newest SCAN_LIMIT ids in
 * multicalls, so one page view costs a handful of eth_calls, not one per subscription.
 */

export const SCAN_LIMIT = 2000;

function s(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export async function subsSummary(
  reader: ContractReader = testnetClient(),
): Promise<{ address: `0x${string}` | null; summary: SubsSummary | null; error: string | null }> {
  const address = subsAddress();
  if (!address) return { address, summary: null, error: null };
  try {
    return { address, summary: await memo(`subs:${address}:summary`, 10_000, () => readSubsSummary(reader, address)), error: null };
  } catch (err) {
    return { address, summary: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export function subsSummaryJson(address: string | null, sm: SubsSummary | null, errors: string[] = []): SubsSummaryJson {
  return {
    deployed: address !== null,
    address,
    chainId: DESK_CHAIN_ID,
    feePerDayWei: s(sm?.feePerDayWei ?? null),
    count: s(sm?.count ?? null),
    earnedWei: s(sm?.earnedWei ?? null),
    withdrawnWei: s(sm?.withdrawnWei ?? null),
    escrowedWei: s(sm?.escrowedWei ?? null),
    owner: sm?.owner ?? null,
    errors: [...(sm?.errors ?? []), ...errors],
    readAt: new Date().toISOString(),
  };
}

/** The newest SCAN_LIMIT subscriptions, newest first. */
export async function scanSubscriptions(
  reader: ContractReader = testnetClient(),
): Promise<{ deployed: boolean; subscriptions: SubscriptionWithId[]; truncated: boolean; error: string | null }> {
  const { address, summary, error } = await subsSummary(reader);
  if (!address) return { deployed: false, subscriptions: [], truncated: false, error: null };
  if (!summary || summary.count === null) return { deployed: true, subscriptions: [], truncated: false, error: error ?? 'subscriptionCount could not be read' };
  const count = summary.count;
  if (count === 0n) return { deployed: true, subscriptions: [], truncated: false, error: null };
  const ids = latestSubscriptionIds(count, SCAN_LIMIT);
  const read = await memo(`subs:${address}:scan:${count}`, 10_000, () => readSubscriptions(reader, address, ids));
  return {
    deployed: true,
    subscriptions: read.subscriptions,
    truncated: count > BigInt(SCAN_LIMIT),
    error: read.failed ? `${read.failed} subscriptions could not be read` : null,
  };
}

export function subscriptionJson(x: SubscriptionWithId, ctx: LabelContext, now: number = nowSec()): SubscriptionJson {
  const chainId = Number(x.subjectChainId);
  return {
    id: x.id.toString(),
    subscriber: checksum(x.subscriber),
    subjectChainId: chainId,
    subject: checksum(x.subject),
    vaultPath: vaultPathOf(chainId, x.subject),
    label: labelFor(chainId, x.subject, ctx),
    standardId: x.standardId,
    feePerDayWei: x.feePerDay.toString(),
    startsAt: new Date(Number(x.startsAt) * 1000).toISOString(),
    endsAt: new Date(Number(x.endsAt) * 1000).toISOString(),
    startsAtSec: Number(x.startsAt),
    endsAtSec: Number(x.endsAt),
    days: Number(runDaysOf(x)),
    paidWei: x.paid.toString(),
    settledWei: x.settled.toString(),
    cancelled: x.cancelled,
    active: isActiveAt(x, BigInt(now)),
    refundEstimateWei: refundAt(x, BigInt(now)).toString(),
  };
}

export async function subscriptionsOf(
  subscriber: string,
  reader?: ContractReader,
): Promise<{ deployed: boolean; subscriptions: SubscriptionWithId[]; scanned: number; truncated: boolean; error: string | null }> {
  const scan = await scanSubscriptions(reader);
  const mine = scan.subscriptions.filter((x) => x.subscriber.toLowerCase() === subscriber.toLowerCase());
  return { deployed: scan.deployed, subscriptions: mine, scanned: scan.subscriptions.length, truncated: scan.truncated, error: scan.error };
}
