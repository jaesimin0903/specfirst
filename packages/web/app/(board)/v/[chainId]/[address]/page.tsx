import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { loadBoard, loadVaultDetail } from '../../../../../lib/board/load';
import { VaultView } from '../../../../../components/board/VaultView';

type Params = Promise<{ chainId: string; address: string }>;

/** Every vault on the board is prerendered; anything else is looked up on demand and 404s when unknown. */
export function generateStaticParams(): { chainId: string; address: string }[] {
  return loadBoard().vaults.map((r) => {
    const [chainId, address] = r.id.split('/');
    return { chainId: chainId!, address: address! };
  });
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chainId, address } = await params;
  const d = loadVaultDetail(chainId, address);
  if (!d) return { title: 'Vault not on the board | Specfirst' };
  const name = d.row.name ?? d.row.address;
  return {
    title: `${name} | ERC-4626 check | Specfirst`,
    description: `${d.row.protocol ?? 'ERC-4626 vault'} on Monad: ${d.report.summary.pass} pass, ${d.report.summary.fail} fail, ${d.report.summary.inconclusive} inconclusive, ${d.report.summary.notApplicable} not applicable at block ${d.report.blockNumber}.`,
  };
}

export default async function VaultPage({ params }: { params: Params }) {
  const { chainId, address } = await params;
  if (address !== address.toLowerCase()) permanentRedirect(`/v/${chainId}/${address.toLowerCase()}`);
  const detail = loadVaultDetail(chainId, address);
  if (!detail) notFound();
  return <VaultView detail={detail} />;
}
