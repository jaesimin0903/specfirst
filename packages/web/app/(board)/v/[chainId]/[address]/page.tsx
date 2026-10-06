import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { VaultView, type VaultViewSource } from '../../../../../components/board/VaultView';
import { WatchBox } from '../../../../../components/watch/WatchBox';
import { WatcherVaultView } from '../../../../../components/watch/WatcherVaultView';
import { faucetUrl, testnetRpc } from '../../../../../lib/desk/config';
import { resolveVault } from '../../../../../lib/desk/vault';
import { subsAddress } from '../../../../../lib/subs/contract';
import { isChainId } from '../../../../../lib/watch/paths';
import { vaultWatchView } from '../../../../../lib/watch/service';
import type { VaultWatchJson } from '../../../../../lib/watch/types';

type Params = Promise<{ chainId: string; address: string }>;

/*
 * Rendered per request: the board's build-time data is the default, but a newer report from a paid check or from
 * the watcher (under certs/checks) replaces it at once, and a vault the board never had is shown from that report
 * alone. A vault the watcher found but has not checked yet gets a page too. Reading the prebuilt JSON is a file
 * read, so this costs little; only a vault shown from a newer report reads the registry (cached for 30 s).
 */
export const dynamic = 'force-dynamic';

async function watchOf(chainId: string, address: string): Promise<VaultWatchJson | null> {
  if (!isChainId(chainId) || !/^0x[0-9a-f]{40}$/.test(address)) return null;
  return vaultWatchView(Number(chainId), address).catch(() => null);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chainId, address } = await params;
  const { detail: d } = await resolveVault(chainId, address);
  if (!d) {
    const w = await watchOf(chainId, address.toLowerCase());
    return { title: w?.watched ? 'Found by the watcher, not checked yet | Specfirst' : 'Vault not checked yet | Specfirst' };
  }
  const name = d.row.name ?? d.row.address;
  return {
    title: `${name} | ERC-4626 check | Specfirst`,
    description: `${d.row.protocol ?? 'ERC-4626 vault'} on Monad: ${d.report.summary.pass} pass, ${d.report.summary.fail} fail, ${d.report.summary.inconclusive} inconclusive, ${d.report.summary.notApplicable} not applicable at block ${d.report.blockNumber}.`,
  };
}

export default async function VaultPage({ params }: { params: Params }) {
  const { chainId, address } = await params;
  if (address !== address.toLowerCase()) permanentRedirect(`/v/${chainId}/${address.toLowerCase()}`);
  const [{ detail, source }, watch] = await Promise.all([resolveVault(chainId, address), watchOf(chainId, address)]);
  const box = <WatchBox chainId={Number(chainId)} address={address} contract={subsAddress()} rpc={testnetRpc()} faucet={faucetUrl()} />;
  if (!detail) {
    if (watch?.watched) return <WatcherVaultView watch={watch} subscribe={box} />;
    notFound();
  }
  // A report newer than the build is the watcher's when its own feed recorded a check with that report's hash.
  const byWatcher = source === 'requested' && Boolean(watch?.history.some((e) => e.check?.reportHash.toLowerCase() === detail.reportHash.toLowerCase()));
  const shown: VaultViewSource = byWatcher ? 'watcher' : (source ?? 'board');
  // A vault off the hand-made list has no protocol in the metadata; the factory that created it names one.
  const named = !detail.row.protocol && watch?.label.protocol ? { ...detail, row: { ...detail.row, protocol: watch.label.protocol } } : detail;
  return <VaultView detail={named} source={shown} watch={watch?.watched ? watch : null} subscribe={box} />;
}
