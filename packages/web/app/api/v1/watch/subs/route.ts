import { NextResponse } from 'next/server';
import { NO_STORE } from '../../../../../lib/watch/http';
import { subsSummary, subsSummaryJson } from '../../../../../lib/subs/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/watch/subs: CheckSubscriptions' fee per day and money counters. { deployed: false } when NEXT_PUBLIC_SPECFIRST_SUBS_10143 is unset. */
export async function GET(): Promise<NextResponse> {
  const { address, summary, error } = await subsSummary();
  return NextResponse.json(subsSummaryJson(address, summary, error ? [error] : []), { headers: NO_STORE });
}
