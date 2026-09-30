import { NextResponse } from 'next/server';
import { requestView } from '../../../../../lib/desk/service';
import { describeReadError } from '../../../../../lib/board/attestations';

export const dynamic = 'force-dynamic';

/**
 * One request: onchain requestOf, the worker's progress from status.json, the computed timeline and, once
 * fulfilled, the result. The request page polls this every few seconds; chain reads behind it are cached.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await context.params;
  if (!/^\d{1,20}$/.test(id)) return NextResponse.json({ error: 'invalid request id' }, { status: 400 });
  try {
    const view = await requestView(BigInt(id));
    if ('error' in view) {
      return NextResponse.json(view, { status: view.error === 'not-found' ? 404 : 503, headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(view, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ error: 'unreadable', reason: describeReadError(err) }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  }
}
