import type { Metadata } from 'next';
import { AutoRefresh } from '../../../../components/desk/AutoRefresh';
import { GateView } from '../../../../components/watch/GateView';
import { gatePageView } from '../../../../lib/gate/service';

// Read from Monad testnet per request; the page refreshes itself while it is open.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Allocation gate | Specfirst',
  description:
    'A demo contract that reads Specfirst attestations on chain: it allocates only into vaults the registry calls compliant, and lets anyone pull the money out once they are not.',
};

export default async function GatePage() {
  const data = await gatePageView();
  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/watch">Watch</a> / Allocation gate
      </p>
      <header className="sb-desk-hero">
        <p className="sb-eyebrow">Demo integrator, Monad testnet</p>
        <h1 className="sb-claim">A contract that reads the attestations before it moves money.</h1>
        <p className="sb-sub">
          AllocationGate deposits into an ERC-4626 vault only while the registry&apos;s latest attestation of that vault passed every property, is fresh, comes
          from a current issuer and is about the code at that address. When a newer attestation fails, is revoked or its issuer is removed, anyone can make the
          gate pull its money out; nobody has to hold the owner&apos;s key. It trusts the issuers of the registry, nothing more.
        </p>
      </header>
      <GateView data={data} />
      <AutoRefresh seconds={15} />
    </main>
  );
}
