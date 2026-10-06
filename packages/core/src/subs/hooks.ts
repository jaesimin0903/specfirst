// Stand-ins for the watcher's hook interfaces (packages/core/src/watch/hooks.ts on the watcher branch, docs/adr/0006).
// The shapes are structurally identical to that file's ActiveSubscription, SubscriptionSource and AlertSink, and
// FeedEvent carries the feed.ndjson fields of the ADR; when both branches are merged, this file goes and its
// importers take the types from watch/hooks.ts instead.
import type { Address, Hex } from 'viem';

/** One subscription that is active (not cancelled, block.timestamp < endsAt) at the time it was read. */
export interface ActiveSubscription {
  id: bigint;
  subscriber: Address;
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
  startsAt: bigint;
  endsAt: bigint;
}

/** Where the watcher gets the active subscriptions of a subject chain from. */
export interface SubscriptionSource {
  active(subjectChainId: number): Promise<ActiveSubscription[]>;
}

/** Delivers alerts for one feed event to the given subscriptions; returns the `alerted` events to append. */
export interface AlertSink {
  deliver(event: FeedEvent, subs: ActiveSubscription[]): Promise<FeedEvent[]>;
}

export type FeedKind = 'detected' | 'probe-rejected' | 'queued' | 'checked' | 'attested' | 'changed' | 'alerted' | 'error';
export type FeedSource = 'factory' | 'deposit' | 'upgrade' | 'beacon-upgrade' | 'implementation' | 'first-deposit' | 'sweep' | 'subscribed' | 'backfill';

export interface FeedSummary {
  pass: number;
  fail: number;
  inconclusive: number;
  notApplicable: number;
}

export interface FeedCheck {
  block: string;
  summary: FeedSummary;
  failed: string[];
  implementationKey: Hex | null;
  /** Repository relative, e.g. certs/checks/143/<address>/<block>-<hash8>.json. */
  reportPath: string;
  reportHash: Hex;
  durationMs: number;
}

export interface FeedChange {
  kind: 'new' | 'regressed' | 'recovered' | 'changed' | 'implementation';
  from: { summary: FeedSummary; failed: string[] } | null;
  to: { summary: FeedSummary; failed: string[] };
}

export interface FeedAttestation {
  id: string;
  txHash: Hex;
  supersedes: string | null;
}

export interface FeedAlert {
  subscriptionId: string;
  subscriber: Address;
  channel: 'webhook' | 'inbox';
  ok: boolean;
  status?: number;
}

/** One line of feed.ndjson (ADR 0006, Watcher files). Block numbers are decimal strings, `at` is ISO 8601. */
export interface FeedEvent {
  v: 1;
  seq: number;
  at: string;
  kind: FeedKind;
  chainId: number;
  subject: Address;
  source?: FeedSource;
  block?: string;
  txHash?: Hex;
  factory?: { address: Address; name: string };
  check?: FeedCheck;
  attestation?: FeedAttestation;
  change?: FeedChange;
  alert?: FeedAlert;
  reason?: string;
}
