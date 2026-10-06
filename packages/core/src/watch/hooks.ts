// Hooks the subscription side (docs/adr/0006, CheckSubscriptions and alerts) plugs into the watcher. The
// watcher runs without them: no subscriptions, no alerts.
import type { Address, Hex } from 'viem';
import type { FeedEvent } from './schema.js';

/** An active CheckSubscriptions entry (isActive(id) at the time it was read). Times are unix seconds. */
export interface ActiveSubscription {
  id: bigint;
  subscriber: Address;
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
  startsAt: bigint;
  endsAt: bigint;
}

/** Reads the subscriptions that are active now for subjects on `subjectChainId`. */
export interface SubscriptionSource {
  active(subjectChainId: number): Promise<ActiveSubscription[]>;
}

/**
 * Delivers one feed event (a `changed` event, or the `checked` event of the first check after a
 * subscription started) to the given subscriptions. Returns the `alerted` events to append to the feed; the
 * watcher assigns their seq.
 */
export interface AlertSink {
  deliver(event: FeedEvent, subs: ActiveSubscription[]): Promise<FeedEvent[]>;
}

export const NO_SUBSCRIPTIONS: SubscriptionSource = { active: async () => [] };
export const NO_ALERTS: AlertSink = { deliver: async () => [] };
