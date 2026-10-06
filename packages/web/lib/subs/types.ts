import type { FeedEventJson, VaultLabelJson } from '../watch/types';

/*
 * JSON of the subscription API routes. Wei and ids are decimal strings, times ISO 8601 with unix seconds beside
 * them for arithmetic in the browser. Client-safe: types only.
 */

export interface SubsSummaryJson {
  /** false: NEXT_PUBLIC_SPECFIRST_SUBS_10143 is unset, the contract is not deployed yet. */
  deployed: boolean;
  address: string | null;
  chainId: number;
  feePerDayWei: string | null;
  count: string | null;
  earnedWei: string | null;
  withdrawnWei: string | null;
  escrowedWei: string | null;
  owner: string | null;
  errors: string[];
  readAt: string;
}

export interface SubscriptionJson {
  id: string;
  subscriber: string;
  subjectChainId: number;
  subject: string;
  vaultPath: string;
  label: VaultLabelJson;
  standardId: string;
  feePerDayWei: string;
  startsAt: string;
  endsAt: string;
  startsAtSec: number;
  endsAtSec: number;
  days: number;
  paidWei: string;
  settledWei: string;
  cancelled: boolean;
  active: boolean;
  /** What cancel would return now (ADR rule: the days not started). */
  refundEstimateWei: string;
}

export interface SubscriberJson {
  deployed: boolean;
  subscriber: string;
  /** Newest first. */
  subscriptions: SubscriptionJson[];
  /** Subscriptions read in the scan, and whether the scan stopped before the oldest. */
  scanned: number;
  truncated: boolean;
  error: string | null;
  readAt: string;
}

export interface InboxItemJson {
  subscriptionId: string;
  /** change: the result changed; first-check: the first check after the subscription started; delivery: a webhook or inbox delivery. */
  kind: 'change' | 'first-check' | 'delivery';
  event: FeedEventJson;
}

export interface InboxJson {
  deployed: boolean;
  subscriber: string;
  active: SubscriptionJson[];
  ended: number;
  /** Newest first. */
  items: InboxItemJson[];
  webhook: { url: string; issued: number } | null;
  error: string | null;
  readAt: string;
}
