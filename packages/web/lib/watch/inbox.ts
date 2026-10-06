import type { FeedEvent } from './core';

/*
 * The inbox (ADR 0006, "Alerts"): for each active subscription, the feed's changed events for its subject since
 * the subscription started, the first check after it started, and the deliveries made for it. Pure.
 */

export interface InboxSubscription {
  id: string;
  subjectChainId: number;
  subject: string;
  startsAtSec: number;
  endsAtSec: number;
  cancelled: boolean;
}

export interface InboxEntry {
  subscriptionId: string;
  kind: 'change' | 'first-check' | 'delivery';
  event: FeedEvent;
}

export function isActiveSub(s: InboxSubscription, nowSec: number): boolean {
  return !s.cancelled && nowSec < s.endsAtSec;
}

function sec(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Newest first; an event that matches several subscriptions appears once per subscription. */
export function inboxEntries(subs: readonly InboxSubscription[], events: readonly FeedEvent[], nowSec: number): InboxEntry[] {
  const out: InboxEntry[] = [];
  for (const s of subs) {
    if (!isActiveSub(s, nowSec)) continue;
    const subject = s.subject.toLowerCase();
    const mine = events
      .filter((e) => e.chainId === s.subjectChainId && e.subject.toLowerCase() === subject)
      .filter((e) => {
        const t = sec(e.at);
        return t >= s.startsAtSec && t < s.endsAtSec;
      })
      .sort((a, b) => a.seq - b.seq);
    const firstCheck = mine.find((e) => e.kind === 'checked');
    for (const e of mine) {
      if (e.kind === 'changed') out.push({ subscriptionId: s.id, kind: 'change', event: e });
      else if (e === firstCheck) out.push({ subscriptionId: s.id, kind: 'first-check', event: e });
      else if (e.kind === 'alerted' && e.alert?.subscriptionId === s.id) out.push({ subscriptionId: s.id, kind: 'delivery', event: e });
    }
  }
  return out.sort((a, b) => b.event.seq - a.event.seq || Number(BigInt(b.subscriptionId) - BigInt(a.subscriptionId)));
}
