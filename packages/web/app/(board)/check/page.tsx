import type { Metadata } from 'next';
import { isAddress } from 'viem';
import { CheckFlow } from '../../../components/desk/CheckFlow';
import { deskAddress, faucetUrl, testnetRpc } from '../../../lib/desk/config';
import { cachedBoard } from '../../../lib/desk/vault';

// The desk address and fee are read per request, so a desk deployed after the build needs a restart, not a rebuild.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Request a check | Specfirst',
  description: 'Pay a testnet MON fee to have an ERC-4626 vault on Monad checked against 30 properties and the result attested onchain.',
};

export default async function CheckPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const raw = typeof sp.vault === 'string' ? sp.vault.trim() : '';
  const initialVault = isAddress(raw, { strict: false }) ? raw : '';
  const example = cachedBoard().vaults.find((v) => v.status === 'complete' && v.attestation.kind === 'attested') ?? cachedBoard().vaults[0];
  return (
    <main className="sb-wrap">
      <header className="sb-desk-hero">
        <p className="sb-eyebrow">Request a check</p>
        <h1 className="sb-claim">Your vault, checked at today&apos;s block and attested onchain.</h1>
        <p className="sb-sub">
          Paste an ERC-4626 vault on Monad mainnet and pay a small testnet fee. Our worker forks the vault, runs <strong>30 properties</strong> nobody
          wrote for themselves, and records the result on Monad testnet. You get the result, the attestation, a badge and an API. The fee is held in
          escrow and becomes ours only when the attestation lands.
        </p>
      </header>
      <CheckFlow deskAddress={deskAddress()} rpc={testnetRpc()} faucet={faucetUrl()} initialVault={initialVault} exampleVault={example ? `/v/${example.id}` : null} />
    </main>
  );
}
