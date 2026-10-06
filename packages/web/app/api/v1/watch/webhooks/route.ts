import { NextResponse } from 'next/server';
import { isAddress } from 'viem';
import { NO_STORE } from '../../../../../lib/watch/http';
import { registerWebhook, webhookOf } from '../../../../../lib/watch/webhooks';

export const dynamic = 'force-dynamic';

const MAX_BODY = 8 * 1024;

/** GET /api/v1/watch/webhooks?subscriber=0x...: the URL registered for a subscriber and when it was signed. */
export async function GET(request: Request): Promise<NextResponse> {
  const subscriber = new URL(request.url).searchParams.get('subscriber') ?? '';
  if (!isAddress(subscriber, { strict: false })) return NextResponse.json({ error: 'expected ?subscriber=<0x address>' }, { status: 400 });
  const w = await webhookOf(subscriber);
  return NextResponse.json({ subscriber, webhook: w ? { url: w.url, issued: w.issued } : null }, { headers: NO_STORE });
}

/**
 * POST /api/v1/watch/webhooks { subscriber, url, issued, signature }: registers the URL the watcher POSTs alerts
 * to (ADR 0006). The signature is EIP-191 over the exact registration text, by the subscriber, at most 10 minutes
 * old; the URL must be https. The latest registration per subscriber wins.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY) return NextResponse.json({ ok: false, error: 'body too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: 'expected JSON' }, { status: 400 });
  }
  const r = await registerWebhook(body);
  if (!r.ok) return NextResponse.json({ ok: false, error: r.reason }, { status: r.status, headers: NO_STORE });
  return NextResponse.json({ ok: true, webhook: { subscriber: r.webhook.subscriber, url: r.webhook.url, issued: r.webhook.issued } }, { headers: NO_STORE });
}
