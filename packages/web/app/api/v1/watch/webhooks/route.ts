import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { NO_STORE } from '../../../../../lib/watch/http';
import { watchFile } from '../../../../../lib/watch/paths';
import { allowLocalHttp, publicWebhook, registerStatus, registerWebhook, webhookOf, WebhookStoreError } from '../../../../../lib/watch/webhooks';

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
 * minutes ago; the URL must be https to a public host. The latest registration per subscriber wins.
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
    const r = await registerWebhook(watchFile.webhooks(), body, { allowLocalHttp: allowLocalHttp() });
    const status = registerStatus(r);
    if (!r.ok) return NextResponse.json({ ok: false, reason: r.reason, error: r.message }, { status, headers: NO_STORE });
    if (!r.stored) return NextResponse.json({ ok: false, error: 'a newer registration for this subscriber is already stored' }, { status, headers: NO_STORE });
    return NextResponse.json({ ok: true, webhook: { subscriber: r.registration.subscriber, ...publicWebhook(r.registration) } }, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof WebhookStoreError ? 'webhooks.json on this server is unreadable, so nothing was stored' : 'could not store the registration';
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: NO_STORE });
  }
}
