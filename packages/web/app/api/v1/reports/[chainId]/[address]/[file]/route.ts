import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { checksDir } from '../../../../../../../lib/desk/paths';

export const dynamic = 'force-dynamic';

/**
 * A report written after the board was built (a paid check), served byte for byte so anyone can recompute its
 * reportHash. Build-time reports stay under /reports. Names are checked before they touch the file system.
 */
export async function GET(_request: Request, context: { params: Promise<{ chainId: string; address: string; file: string }> }): Promise<Response> {
  const { chainId, address, file } = await context.params;
  if (!/^\d{1,12}$/.test(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(address) || !/^[\w.-]{1,120}\.json$/.test(file) || file.includes('..') || file.endsWith('.forge.json')) {
    return new Response('not found', { status: 404 });
  }
  const base = path.join(checksDir(), chainId);
  for (const dir of [address, address.toLowerCase()]) {
    try {
      const body = await readFile(path.join(base, dir, file));
      return new Response(new Uint8Array(body), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' },
      });
    } catch {
      // Try the other letter case of the directory.
    }
  }
  return new Response('not found', { status: 404 });
}
