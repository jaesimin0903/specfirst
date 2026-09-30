import { NextResponse } from 'next/server';
import { deskSummary, recentJson, recentRequests } from '../../../../lib/desk/service';
import { readWorkerStatus } from '../../../../lib/desk/worker';

export const dynamic = 'force-dynamic';

/** The newest requests with their stage, newest first. ?limit= 1 to 20, default 6. */
export async function GET(request: Request): Promise<NextResponse> {
  const raw = Number(new URL(request.url).searchParams.get('limit') ?? 6);
  const limit = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 20) : 6;
  const { desk, summary } = await deskSummary();
  if (!desk) return NextResponse.json({ deployed: false, requests: [] }, { headers: { 'Cache-Control': 'no-store' } });
  const [requests, worker] = await Promise.all([recentRequests(limit).catch(() => []), readWorkerStatus()]);
  return NextResponse.json(
    { deployed: true, requestCount: summary?.requestCount?.toString() ?? null, requests: recentJson(requests, worker, summary?.timeoutSec ?? null) },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
