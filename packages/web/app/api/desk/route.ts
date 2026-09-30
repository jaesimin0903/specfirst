import { NextResponse } from 'next/server';
import { deskSummary, summaryJson } from '../../../lib/desk/service';

export const dynamic = 'force-dynamic';

/** The desk's fee, timeout and money counters. { deployed: false } when NEXT_PUBLIC_SPECFIRST_DESK_10143 is unset. */
export async function GET(): Promise<NextResponse> {
  const { desk, summary, error } = await deskSummary();
  return NextResponse.json(summaryJson(desk, summary, error ? [error] : []), { headers: { 'Cache-Control': 'no-store' } });
}
