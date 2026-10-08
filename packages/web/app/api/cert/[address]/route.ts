import { NextResponse } from 'next/server';
import type { Address, Hex } from 'viem';
import { CHAIN_ID, getRegistryAddress, publicClient } from '../../../../lib/chain';
import { fetchCertLookup, ZERO_ADDRESS } from '../../../../lib/certStatus';
import { resolveReportUrl } from '../../../../lib/report';
import { publicOrigin } from '../../../../lib/origin';

export const revalidate = 60;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface CertApiResponse {
  address: string;
  chainId: number;
  certified: boolean;
  isLatest: boolean | null;
  status: 'valid' | 'superseded' | 'revoked' | 'partial' | 'none';
  projectId: Hex | null;
  specHash: Hex | null;
  invariantSetHash: Hex | null;
  propertyHash: Hex | null;
  codeMatches: boolean | null;
  passed: number;
  total: number;
  issuedAt: string | null;
  supersededBy: Address | null;
  certificateUrl: string;
  reportUrl: string | null;
}

export async function GET(request: Request, context: { params: Promise<{ address: string }> }): Promise<NextResponse> {
  const { address } = await context.params;

  if (!ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: 'invalid address' }, { status: 400 });
  }

  const registry = getRegistryAddress();
  if (!registry) {
    return NextResponse.json({ error: 'registry not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  const invariantSetHashParam = url.searchParams.get('invariantSetHash');
  const invariantSetHash = invariantSetHashParam && /^0x[0-9a-fA-F]{64}$/.test(invariantSetHashParam) ? (invariantSetHashParam as Hex) : undefined;

  const lookup = await fetchCertLookup({
    client: publicClient(),
    registry,
    address: address as Address,
    invariantSetHash,
  });

  const cert = lookup.certificate;
  const origin = publicOrigin(request.url);

  const body: CertApiResponse = {
    address: lookup.address,
    chainId: CHAIN_ID,
    certified: lookup.certified,
    isLatest: lookup.isLatest,
    status: lookup.status,
    projectId: cert?.projectId ?? null,
    specHash: cert?.specHash ?? null,
    invariantSetHash: cert?.invariantSetHash ?? null,
    propertyHash: cert?.propertyHash ?? null,
    codeMatches: lookup.codeMatches,
    passed: cert?.passedCount ?? 0,
    total: cert?.totalCount ?? 0,
    issuedAt: cert ? new Date(Number(cert.issuedAt) * 1000).toISOString() : null,
    supersededBy: cert && cert.supersededBy !== ZERO_ADDRESS ? cert.supersededBy : null,
    certificateUrl: `${origin}/c/${lookup.address}`,
    reportUrl: cert?.reportURI ? resolveReportUrl(cert.reportURI) : null,
  };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=30' },
  });
}
