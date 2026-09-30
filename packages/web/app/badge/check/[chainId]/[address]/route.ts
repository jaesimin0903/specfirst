import { describeReadError } from '../../../../../lib/board/attestations';
import { checkBadgeOf, renderCheckBadgeSvg } from '../../../../../lib/desk/checkBadge';
import type { LiveAttestation } from '../../../../../lib/desk/registry';
import { liveAttestation } from '../../../../../lib/desk/vault';

export const dynamic = 'force-dynamic';

function svg(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=60, stale-while-revalidate=60' },
  });
}

/**
 * GET /badge/check/<chainId>/<address>.svg: Compliant, Mismatch, Partly checked or Not attested, from the
 * registry's latest attestation for the vault. Separate from /badge/<address>, which is for spec certificates.
 */
export async function GET(_request: Request, context: { params: Promise<{ chainId: string; address: string }> }): Promise<Response> {
  const { chainId, address: raw } = await context.params;
  const address = raw.replace(/\.svg$/i, '');
  if (!/^\d{1,12}$/.test(chainId) || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return svg(renderCheckBadgeSvg({ state: 'unavailable', text: 'invalid address', attestationId: null }), 400);
  }
  const live: LiveAttestation = await liveAttestation(Number(chainId), address.toLowerCase()).catch((err) => ({ kind: 'unread' as const, reason: describeReadError(err) }));
  return svg(renderCheckBadgeSvg(checkBadgeOf(live)));
}
