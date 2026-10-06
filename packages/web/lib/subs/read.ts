import { describeReadError } from '../board/attestations';
import type { ContractReader } from '../desk/read';
import { checkSubscriptionsAbi, FIRST_SUBSCRIPTION_ID } from './contract';

/*
 * View calls against CheckSubscriptions. Takes any reader with viem's readContract; with the server client,
 * calls made together travel as one multicall, which keeps a scan under the testnet RPC's 15 requests a second.
 */

export interface Subscription {
  id: bigint;
  subscriber: `0x${string}`;
  subjectChainId: number;
  subject: `0x${string}`;
  standardId: `0x${string}`;
  feePerDayWei: bigint;
  /** unix seconds */
  startsAt: bigint;
  endsAt: bigint;
  paidWei: bigint;
  settledWei: bigint;
  cancelled: boolean;
}

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

interface RawSubscription {
  subscriber: `0x${string}`;
  subjectChainId: bigint | number;
  subject: `0x${string}`;
  standardId: `0x${string}`;
  feePerDay: bigint | number;
  startsAt: bigint | number;
  endsAt: bigint | number;
  paid: bigint | number;
  settled: bigint | number;
  cancelled: boolean;
}

/** subscriptionOf's struct as viem decodes it, named fields or a positional tuple. */
export function normalizeSubscription(id: bigint, raw: unknown): Subscription {
  const r = (Array.isArray(raw)
    ? { subscriber: raw[0], subjectChainId: raw[1], subject: raw[2], standardId: raw[3], feePerDay: raw[4], startsAt: raw[5], endsAt: raw[6], paid: raw[7], settled: raw[8], cancelled: raw[9] }
    : raw) as RawSubscription;
  return {
    id,
    subscriber: r.subscriber,
    subjectChainId: Number(r.subjectChainId),
    subject: r.subject,
    standardId: r.standardId,
    feePerDayWei: BigInt(r.feePerDay),
    startsAt: BigInt(r.startsAt),
    endsAt: BigInt(r.endsAt),
    paidWei: BigInt(r.paid),
    settledWei: BigInt(r.settled),
    cancelled: Boolean(r.cancelled),
  };
}

/** The ADR's isActive: not cancelled and before endsAt. */
export function isActiveAt(s: Pick<Subscription, 'cancelled' | 'endsAt'>, nowSec: number): boolean {
  return !s.cancelled && BigInt(nowSec) < s.endsAt;
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
export async function readSubscriptions(reader: ContractReader, address: `0x${string}`, ids: readonly bigint[]): Promise<{ subscriptions: Subscription[]; failed: number }> {
  const settled = await Promise.allSettled(ids.map((id) => reader.readContract({ address, abi: checkSubscriptionsAbi, functionName: 'subscriptionOf', args: [id] })));
  const subscriptions: Subscription[] = [];
  let failed = 0;
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') subscriptions.push(normalizeSubscription(ids[i]!, s.value));
    else failed++;
  });
  return { subscriptions, failed };
}
