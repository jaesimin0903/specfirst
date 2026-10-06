import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { NO_STORE } from '../../../../../lib/watch/http';
import { inboxView } from '../../../../../lib/watch/inboxView';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/watch/inbox?subscriber=0x...: the subscriber's active subscriptions, the changes and first checks
 * the feed holds for them, delivery results, and the registered webhook. Everything here is public data (chain
 * state and the feed), so no signature is asked for.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const subscriber = new URL(request.url).searchParams.get('subscriber') ?? '';
  if (!isAddress(subscriber, { strict: false })) return NextResponse.json({ error: 'expected ?subscriber=<0x address>' }, { status: 400 });
  return NextResponse.json(await inboxView(subscriber), { headers: NO_STORE });
}
