import { isActiveAt } from '../subs/core';
import { nowSec, subscriptionJson, subscriptionsOf } from '../subs/service';
import type { InboxJson } from '../subs/types';
import type { ContractReader } from '../desk/read';
import type { FeedEvent } from './core';
import { inboxEntries, isActiveSub, type InboxSubscription } from './inbox';
import { watchFile } from './paths';
import { readFeed } from './read';
import { feedEventsJson, labelContext } from './service';
import { publicWebhook, webhookOf } from './webhooks';

/*
 * /watch/inbox for one subscriber: their active subscriptions (read from CheckSubscriptions), the alerts the feed
 * holds for them, and the webhook they registered. Server only.
 */

export const INBOX_LIMIT = 100;

export async function inboxView(subscriber: string, reader?: ContractReader): Promise<InboxJson> {
  const readAt = new Date().toISOString();
  const [subs, webhook] = await Promise.all([subscriptionsOf(subscriber, reader), webhookOf(subscriber).catch(() => null)]);
  const hook = publicWebhook(webhook);
  if (!subs.deployed) return { deployed: false, subscriber, active: [], ended: 0, items: [], webhook: hook, error: null, readAt };
  const now = nowSec();
  const lite: InboxSubscription[] = subs.subscriptions.map((x) => ({
    id: x.id.toString(),
    subjectChainId: Number(x.subjectChainId),
    subject: x.subject,
    startsAtSec: Number(x.startsAt),
    endsAtSec: Number(x.endsAt),
    cancelled: x.cancelled,
  }));
  const active = lite.filter((x) => isActiveSub(x, now));
  const chains = [...new Set(active.map((x) => x.subjectChainId))];
  const feeds = new Map<number, readonly FeedEvent[]>();
  for (const c of chains) feeds.set(c, (await readFeed(watchFile.feed(c))).events);
  const entries = inboxEntries(
    active,
    chains.flatMap((c) => feeds.get(c) ?? []),
    now,
  ).slice(0, INBOX_LIMIT);
  const json = new Map<string, Awaited<ReturnType<typeof feedEventsJson>>[number]>();
  for (const c of chains) {
    const mine = entries.filter((e) => e.event.chainId === c).map((e) => e.event);
    const unique = [...new Map(mine.map((e) => [e.seq, e])).values()];
    for (const j of await feedEventsJson(unique, c, feeds.get(c) ?? [])) json.set(`${c}:${j.seq}`, j);
  }
  const ctx = labelContext(chains.flatMap((c) => feeds.get(c) ?? []));
  return {
    deployed: true,
    subscriber,
    active: subs.subscriptions.filter((x) => isActiveAt(x, BigInt(now))).map((x) => subscriptionJson(x, ctx, now)),
    ended: subs.subscriptions.length - active.length,
    items: entries
      .map((e) => ({ subscriptionId: e.subscriptionId, kind: e.kind, event: json.get(`${e.event.chainId}:${e.event.seq}`)! }))
      .filter((x) => x.event),
    webhook: hook,
    error: subs.error,
    readAt,
  };
}
