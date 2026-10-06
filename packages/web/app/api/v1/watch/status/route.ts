import { NextResponse } from 'next/server';
import { NO_STORE } from '../../../../../lib/watch/http';
import { pickChain, watchStatusView } from '../../../../../lib/watch/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/watch/status?chainId=143: what the watcher is doing, how far behind the head it is, its queue,
 * sources and counts, and how many vaults it found that the hand-made list does not have. A missing watch dir is
 * { running: false, problem: "not running" }, never an error.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { chainId, chains } = await pickChain(new URL(request.url).searchParams.get('chainId'));
  return NextResponse.json(await watchStatusView(chainId, chains), { headers: NO_STORE });
}
