import { NextResponse } from 'next/server';
import { NO_STORE } from '../../../../../lib/watch/http';
import { alertPayloadSchema, demoHookEnabled, MAX_DEMO_HOOK_BYTES, readDemoHooks, storeDemoHook } from '../../../../../lib/watch/demoHook';

export const dynamic = 'force-dynamic';

/** GET /api/v1/watch/demo-hook: the bodies the demo receiver got, newest first, each marked with whether it is an ADR 0006 alert payload. */
export async function GET(): Promise<NextResponse> {
  if (!demoHookEnabled()) return NextResponse.json({ enabled: false, received: [] }, { status: 404, headers: NO_STORE });
  const received = await readDemoHooks();
  return NextResponse.json(
    { enabled: true, received: received.map((e) => ({ ...e, isAlert: alertPayloadSchema.safeParse(e.body).success })) },
    { headers: NO_STORE },
  );
}

/** POST /api/v1/watch/demo-hook: a demo webhook receiver. Keeps the last 50 JSON bodies of at most 64 KB. */
export async function POST(request: Request): Promise<NextResponse> {
  if (!demoHookEnabled()) return NextResponse.json({ ok: false, error: 'the demo receiver is off' }, { status: 404 });
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (declared > MAX_DEMO_HOOK_BYTES) return NextResponse.json({ ok: false, error: 'body too large' }, { status: 413 });
  const text = await request.text().catch(() => '');
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_DEMO_HOOK_BYTES) return NextResponse.json({ ok: false, error: 'body too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: 'expected a JSON body' }, { status: 400 });
  }
  const entry = await storeDemoHook(body, { userAgent: request.headers.get('user-agent'), bytes });
  return NextResponse.json({ ok: true, n: entry.n, receivedAt: entry.receivedAt }, { headers: NO_STORE });
}
