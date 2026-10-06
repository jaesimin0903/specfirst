import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { subscriberStanding } from '../../../../../lib/subs/service';
import { NO_STORE } from '../../../../../lib/watch/http';
import { watchFile } from '../../../../../lib/watch/paths';
import { localOriginsFor, registerWithPolicy } from '../../../../../lib/watch/registration';
import { publicWebhook, webhookOf } from '../../../../../lib/watch/webhooks';

export const dynamic = 'force-dynamic';

const MAX_BODY = 8 * 1024;

/**
 * GET /api/v1/watch/webhooks?subscriber=0x...: whether a subscriber has a webhook, its origin and when it was
 * signed. The full URL is not shown: it can be a secret, and anyone can ask for any address.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const subscriber = new URL(request.url).searchParams.get('subscriber') ?? '';
  if (!isAddress(subscriber, { strict: false })) return NextResponse.json({ error: 'expected ?subscriber=<0x address>' }, { status: 400 });
  return NextResponse.json({ subscriber, webhook: publicWebhook(await webhookOf(subscriber)) }, { headers: NO_STORE });
}

/**
 * POST /api/v1/watch/webhooks { subscriber, url, issued, signature }: registers the URL the watcher POSTs alerts
 * to (ADR 0006). The signature is EIP-191 over the exact registration text, by the subscriber, issued at most 10
 * minutes ago; the URL must be https to a public host; the subscriber must hold an active subscription (409
 * otherwise, 503 when subscriptions are not deployed); at most 1000 subscribers are stored (429 for a new one past
 * that). The latest registration per subscriber wins.
 */
export async function POST(request: Request): Promise<NextResponse> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return NextResponse.json({ ok: false, error: 'body too large' }, { status: 413 });
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY) return NextResponse.json({ ok: false, error: 'body too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: 'expected JSON' }, { status: 400 });
  }
  try {
    const r = await registerWithPolicy(body, {
      file: watchFile.webhooks(),
      allowedLocalOrigins: localOriginsFor(request.url),
      standing: (subscriber) => subscriberStanding(subscriber),
    });
    return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
  } catch {
    return NextResponse.json({ ok: false, error: 'could not store the registration' }, { status: 500, headers: NO_STORE });
  }
}
