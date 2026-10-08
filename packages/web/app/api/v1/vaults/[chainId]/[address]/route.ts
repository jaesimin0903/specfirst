import { NextResponse } from 'next/server';
import { describeReadError } from '../../../../../../lib/board/attestations';
import { buildVaultApi } from '../../../../../../lib/desk/vaultApi';
import { liveAttestation, resolveVault } from '../../../../../../lib/desk/vault';
import { publicOrigin } from '../../../../../../lib/origin';
import type { LiveAttestation } from '../../../../../../lib/desk/registry';

export const dynamic = 'force-dynamic';

const CHAIN_RE = /^\d{1,12}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * GET /api/v1/vaults/<chainId>/<address>: the latest check report summary, the four max-honored flags, the
 * onchain attestation (read now, not at build time) and the command that replays the check. 404 with the same
 * shape when the vault was never checked, so a client can still read its attestation state.
 */
export async function GET(request: Request, context: { params: Promise<{ chainId: string; address: string }> }): Promise<NextResponse> {
  const { chainId, address } = await context.params;
  if (!CHAIN_RE.test(chainId) || !ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: 'expected /api/v1/vaults/<chainId>/<0x address>' }, { status: 400 });
  }
  const origin = publicOrigin(request.url);
  const resolved = await resolveVault(chainId, address);
  const live: LiveAttestation = await liveAttestation(Number(chainId), address.toLowerCase()).catch((err) => ({ kind: 'unread' as const, reason: describeReadError(err) }));
  const body = buildVaultApi({ resolved, live, origin });
  return NextResponse.json(body, {
    status: resolved.detail ? 200 : 404,
    headers: { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=30', 'Access-Control-Allow-Origin': '*' },
  });
}
