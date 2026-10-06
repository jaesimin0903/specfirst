import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { NO_STORE } from '../../../../../../lib/watch/http';
import { labelContext } from '../../../../../../lib/watch/service';
import { nowSec, subscriptionJson, subscriptionsOf } from '../../../../../../lib/subs/service';
import type { SubscriberJson } from '../../../../../../lib/subs/types';

export const dynamic = 'force-dynamic';

/** GET /api/v1/watch/subs/<subscriber>: that address's subscriptions, newest first, with what cancel would refund now. */
export async function GET(_request: Request, context: { params: Promise<{ subscriber: string }> }): Promise<NextResponse> {
  const { subscriber } = await context.params;
  if (!isAddress(subscriber, { strict: false })) return NextResponse.json({ error: 'expected /api/v1/watch/subs/<0x address>' }, { status: 400 });
  const r = await subscriptionsOf(subscriber);
  const ctx = labelContext([]);
  const now = nowSec();
  const body: SubscriberJson = {
    deployed: r.deployed,
    subscriber,
    subscriptions: r.subscriptions.map((x) => subscriptionJson(x, ctx, now)),
    scanned: r.scanned,
    truncated: r.truncated,
    error: r.error,
    readAt: new Date().toISOString(),
  };
  return NextResponse.json(body, { headers: NO_STORE });
}
