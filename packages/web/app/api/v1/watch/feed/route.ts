import { NextResponse } from 'next/server';
import { intParam, NO_STORE } from '../../../../../lib/watch/http';
import { feedPageView, pickChain } from '../../../../../lib/watch/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/watch/feed?chainId=143&after=<seq>&before=<seq>&limit=40: feed events, newest first, with each
 * check's 30 results read from its report. after= returns only events newer than that seq (for polling; gap is
 * true when more arrived than limit), before= pages back. Lines the reader could not parse are counted in skipped.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const sp = new URL(request.url).searchParams;
  const { chainId } = await pickChain(sp.get('chainId'));
  const body = await feedPageView(chainId, {
    after: intParam(sp.get('after')),
    before: intParam(sp.get('before')),
    limit: intParam(sp.get('limit')) ?? undefined,
  });
  return NextResponse.json(body, { headers: NO_STORE });
}
