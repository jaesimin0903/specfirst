import { NextResponse } from 'next/server';
import { overlayRows } from '../../../../../lib/watch/service';

export const dynamic = 'force-dynamic';

/**
 * GET /api/v1/watch/overlay: board rows for the vaults the watcher found that the board build does not have,
 * marked with how they were found. The board merges them into its table in the browser.
 */
export async function GET(): Promise<NextResponse> {
  const rows = await overlayRows().catch(() => []);
  return NextResponse.json({ rows, readAt: new Date().toISOString() }, { headers: { 'Cache-Control': 'public, max-age=10' } });
}
