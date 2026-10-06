import { describeReadError } from '../board/attestations';
import type { ContractReader } from '../desk/read';
import { checkSubscriptionsAbi, FIRST_SUBSCRIPTION_ID } from './contract';
import type { Subscription } from './core';

/*
 * View calls against CheckSubscriptions. Takes any reader with viem's readContract; with the server client,
 * calls made together travel as one multicall, which keeps a scan under the testnet RPC's 15 requests a second.
 */

/** core's Subscription (the struct as viem decodes it) with its id. */
export type SubscriptionWithId = Subscription & { id: bigint };

export interface SubsSummary {
  address: `0x${string}`;
  feePerDayWei: bigint | null;
  count: bigint | null;
  earnedWei: bigint | null;
  withdrawnWei: bigint | null;
  escrowedWei: bigint | null;
  owner: `0x${string}` | null;
  errors: string[];
}

type RawSubscription = Record<keyof Subscription, unknown>;

/** subscriptionOf's struct as viem decodes it, named fields or a positional tuple. */
export function normalizeSubscription(id: bigint, raw: unknown): SubscriptionWithId {
  const r = (
    Array.isArray(raw)
      ? {
          subscriber: raw[0],
          subjectChainId: raw[1],
          subject: raw[2],
          standardId: raw[3],
          feePerDay: raw[4],
          startsAt: raw[5],
          endsAt: raw[6],
          paid: raw[7],
          settled: raw[8],
          cancelled: raw[9],
        }
      : raw
  ) as RawSubscription;
  return {
    id,
    subscriber: r.subscriber as `0x${string}`,
    subjectChainId: BigInt(r.subjectChainId as bigint),
    subject: r.subject as `0x${string}`,
    standardId: r.standardId as `0x${string}`,
    feePerDay: BigInt(r.feePerDay as bigint),
    startsAt: BigInt(r.startsAt as bigint),
    endsAt: BigInt(r.endsAt as bigint),
    paid: BigInt(r.paid as bigint),
    settled: BigInt(r.settled as bigint),
    cancelled: Boolean(r.cancelled),
  };
}

const SUMMARY_FIELDS = ['feePerDay', 'subscriptionCount', 'earned', 'withdrawn', 'escrowed', 'owner'] as const;

export async function readSubsSummary(reader: ContractReader, address: `0x${string}`): Promise<SubsSummary> {
  const settled = await Promise.allSettled(SUMMARY_FIELDS.map((functionName) => reader.readContract({ address, abi: checkSubscriptionsAbi, functionName })));
  const errors: string[] = [];
  const value = <T>(i: number, map: (v: unknown) => T): T | null => {
    const s = settled[i]!;
    if (s.status === 'fulfilled') return map(s.value);
    errors.push(`${SUMMARY_FIELDS[i]}: ${describeReadError(s.reason)}`);
    return null;
  };
  const big = (v: unknown) => BigInt(v as bigint);
  const summary: SubsSummary = {
    address,
    feePerDayWei: value(0, big),
    count: value(1, big),
    earnedWei: value(2, big),
    withdrawnWei: value(3, big),
    escrowedWei: value(4, big),
    owner: value(5, (v) => v as `0x${string}`),
    errors,
  };
  if (errors.length === SUMMARY_FIELDS.length) throw new Error(`subscriptions contract not reachable: ${errors[0]}`);
  return summary;
}

/** The newest `limit` ids, newest first. */
export function latestSubscriptionIds(count: bigint, limit: number): bigint[] {
  const ids: bigint[] = [];
  for (let id = count - 1n + FIRST_SUBSCRIPTION_ID; id >= FIRST_SUBSCRIPTION_ID && ids.length < limit; id--) ids.push(id);
  return ids;
}

/** Reads the given ids together; ones that fail are left out and counted. */
export async function readSubscriptions(
  reader: ContractReader,
  address: `0x${string}`,
  ids: readonly bigint[],
): Promise<{ subscriptions: SubscriptionWithId[]; failed: number }> {
  const settled = await Promise.allSettled(
    ids.map((id) => reader.readContract({ address, abi: checkSubscriptionsAbi, functionName: 'subscriptionOf', args: [id] })),
  );
  const subscriptions: SubscriptionWithId[] = [];
  let failed = 0;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') subscriptions.push(normalizeSubscription(ids[i]!, s.value));
    else failed++;
  });
  return { subscriptions, failed };
}
