import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RequestProgress, type RequestLoad } from '../../../../components/desk/RequestProgress';
import { faucetUrl, testnetRpc } from '../../../../lib/desk/config';
import { requestView } from '../../../../lib/desk/service';
import { describeReadError } from '../../../../lib/board/attestations';

export const dynamic = 'force-dynamic';

type Params = Promise<{ requestId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { requestId } = await params;
  return { title: `Request #${requestId} | Specfirst`, robots: { index: false } };
}

export default async function RequestPage({ params, searchParams }: { params: Params; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { requestId } = await params;
  if (!/^\d{1,20}$/.test(requestId)) notFound();
  const sp = await searchParams;
  const tx = typeof sp.tx === 'string' && /^0x[0-9a-fA-F]{64}$/.test(sp.tx) ? sp.tx : null;

  let initial: RequestLoad;
  try {
    const v = await requestView(BigInt(requestId));
    initial = 'error' in v ? { kind: v.error } : { kind: 'ok', view: v };
  } catch (err) {
    initial = { kind: 'error', reason: describeReadError(err) };
  }

  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/check">Request a check</a> / <a href="/desk">Desk</a>
      </p>
      <RequestProgress id={requestId} initial={initial} rpc={testnetRpc()} faucet={faucetUrl()} txParam={tx} />
    </main>
  );
}
