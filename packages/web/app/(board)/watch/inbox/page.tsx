import type { Metadata } from 'next';
import { InboxView } from '../../../../components/watch/InboxView';
import { faucetUrl, testnetRpc } from '../../../../lib/desk/config';
import { subsAddress } from '../../../../lib/subs/contract';

// The subscriptions contract address is read per request, so deploying it needs a restart, not a rebuild.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Alerts inbox | Specfirst',
  description: 'Alerts for the vaults you watch: result changes found by the watcher, your subscriptions and your webhook.',
  robots: { index: false },
};

export default function InboxPage() {
  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/watch">Watch</a>
      </p>
      <header className="sb-desk-hero">
        <p className="sb-eyebrow">Inbox</p>
        <h1 className="sb-claim">Alerts for the vaults you watch.</h1>
        <p className="sb-sub">
          A subscription pays for delivery and freshness, not for access: every result the watcher records stays public. Here you see when a vault you watch
          changed, cancel a subscription with the days not started refunded, and register a webhook.
        </p>
      </header>
      <InboxView contract={subsAddress()} rpc={testnetRpc()} faucet={faucetUrl()} />
    </main>
  );
}
