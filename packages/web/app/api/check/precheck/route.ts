import { NextResponse } from 'next/server';
import { loadVaultDetail } from '../../../../lib/board/load';
import { metaFor } from '../../../../lib/board/aggregate';
import { memo } from '../../../../lib/desk/cache';
import { mainnetClient } from '../../../../lib/desk/clients';
import { deskAddress, SUBJECT_CHAIN_ID } from '../../../../lib/desk/config';
import { precheckVault } from '../../../../lib/desk/precheck';
import { latestVaultReport } from '../../../../lib/desk/reportFiles';
import { pendingFor } from '../../../../lib/desk/service';
import { liveAttestation, vaultMeta } from '../../../../lib/desk/vault';

export const dynamic = 'force-dynamic';

/** GET /api/check/precheck?address=0x...&chainId=143: what the desk knows before anyone pays. Reads only. */
export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const address = (url.searchParams.get('address') ?? '').trim().slice(0, 80);
  const chainId = Number(url.searchParams.get('chainId') ?? SUBJECT_CHAIN_ID);
  const mainnet = mainnetClient();
  const result = await memo(`precheck:${chainId}:${address.toLowerCase()}`, 20_000, () =>
    precheckVault(address, chainId, {
      mainnet,
      boardDetail: (c, a) => loadVaultDetail(String(c), a),
      latestReport: (c, a) => latestVaultReport(c, a),
      attestation: (c, a) => liveAttestation(c, a),
      pending: deskAddress() ? (a) => pendingFor(a) : undefined,
      meta: (c, a) => metaFor(vaultMeta(), c, a),
    }),
  );
  return NextResponse.json(result, { status: result.address ? 200 : 400, headers: { 'Cache-Control': 'no-store' } });
}
