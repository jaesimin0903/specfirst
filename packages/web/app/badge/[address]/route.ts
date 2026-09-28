import type { Address } from 'viem';
import { getRegistryAddress, publicClient } from '../../../lib/chain';
import { fetchCertLookup } from '../../../lib/certStatus';
import { renderBadgeSvg } from '../../../lib/badge';

export const revalidate = 60;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function svgResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60, stale-while-revalidate=30',
    },
  });
}

export async function GET(_request: Request, context: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await context.params;

  if (!ADDRESS_RE.test(address)) {
    return svgResponse(renderBadgeSvg({ status: 'none', passed: 0, total: 0, issuedAt: null }), 400);
  }

  const registry = getRegistryAddress();
  if (!registry) {
    return svgResponse(renderBadgeSvg({ status: 'none', passed: 0, total: 0, issuedAt: null }));
  }

  const lookup = await fetchCertLookup({ client: publicClient(), registry, address: address as Address });
  const cert = lookup.certificate;

  return svgResponse(
    renderBadgeSvg({
      status: lookup.status,
      passed: cert?.passedCount ?? 0,
      total: cert?.totalCount ?? 0,
      issuedAt: cert ? new Date(Number(cert.issuedAt) * 1000).toISOString() : null,
    }),
  );
}
