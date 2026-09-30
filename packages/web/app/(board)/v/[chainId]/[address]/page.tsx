import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { VaultView } from '../../../../../components/board/VaultView';
import { resolveVault } from '../../../../../lib/desk/vault';

type Params = Promise<{ chainId: string; address: string }>;

/*
 * Rendered per request: the board's build-time data is the default, but a newer report from a paid check (under
 * certs/checks) replaces it at once, and a vault the board never had is shown from that report alone. Reading the
 * prebuilt JSON is a file read, so this costs little; only a vault shown from a newer report reads the registry
 * (cached for 30 s).
 */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chainId, address } = await params;
  const { detail: d } = await resolveVault(chainId, address);
  if (!d) return { title: 'Vault not checked yet | Specfirst' };
  const name = d.row.name ?? d.row.address;
  return {
    title: `${name} | ERC-4626 check | Specfirst`,
    description: `${d.row.protocol ?? 'ERC-4626 vault'} on Monad: ${d.report.summary.pass} pass, ${d.report.summary.fail} fail, ${d.report.summary.inconclusive} inconclusive, ${d.report.summary.notApplicable} not applicable at block ${d.report.blockNumber}.`,
  };
}

export default async function VaultPage({ params }: { params: Params }) {
  const { chainId, address } = await params;
  if (address !== address.toLowerCase()) permanentRedirect(`/v/${chainId}/${address.toLowerCase()}`);
  const { detail, source } = await resolveVault(chainId, address);
  if (!detail) notFound();
  return <VaultView detail={detail} source={source ?? 'board'} />;
}
