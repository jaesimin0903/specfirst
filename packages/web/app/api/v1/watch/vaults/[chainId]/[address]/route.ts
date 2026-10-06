import { NextResponse } from 'next/server';
import { NO_STORE } from '../../../../../../../lib/watch/http';
import { isChainId } from '../../../../../../../lib/watch/paths';
import { vaultWatchView } from '../../../../../../../lib/watch/service';

export const dynamic = 'force-dynamic';

/** GET /api/v1/watch/vaults/<chainId>/<address>: what the watcher knows about one vault and its feed history, newest first. */
export async function GET(_request: Request, context: { params: Promise<{ chainId: string; address: string }> }): Promise<NextResponse> {
  const { chainId, address } = await context.params;
  if (!isChainId(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: 'expected /api/v1/watch/vaults/<chainId>/<0x address>' }, { status: 400 });
  }
  const body = await vaultWatchView(Number(chainId), address);
  return NextResponse.json(body, { status: body.watched ? 200 : 404, headers: NO_STORE });
}
