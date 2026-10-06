import type { Metadata } from 'next';
import { WatchLive } from '../../../components/watch/WatchLive';
import { chainName } from '../../../lib/board/reproduce';
import { feedPageView, pickChain, watchStatusView } from '../../../lib/watch/service';

// The watcher's files are read per request; the page then polls the same data through /api/v1/watch.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Watch | Specfirst',
  description:
    'The watcher finds ERC-4626 vaults on Monad when they are created or first used, checks them against 30 properties and attests the results, without anyone asking.',
};

export default async function WatchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const { chainId, chains } = await pickChain(typeof sp.chain === 'string' ? sp.chain : null);
  const [status, feed] = await Promise.all([watchStatusView(chainId, chains), feedPageView(chainId, { limit: 40 })]);
  const f = status.found;
  return (
    <main className="sb-wrap">
      <header className="sb-desk-hero sw-hero">
        <p className="sb-eyebrow">Watcher, {chainName(chainId)}</p>
        <h1 className="sb-claim">Vaults are found on chain, checked and recorded without anyone asking.</h1>
        <p className="sb-sub">
          The watcher reads {chainName(chainId)}. When a factory creates an ERC-4626 vault, an unknown address takes its first deposit or a proxy is upgraded,
          it checks that vault against <strong>30 properties</strong> and attests the result on Monad testnet. Nobody pastes an address or pays for that. This
          page reads its files every few seconds.
        </p>
        <p className="sw-headline">
          <b>{f.notOnList.toLocaleString('en-US')}</b>
          <span>
            {f.notOnList === 1 ? 'vault' : 'vaults'} found by the watcher that {f.notOnList === 1 ? 'was' : 'were'} not on our hand-made list
            {f.listSize ? ` of ${f.listSize.toLocaleString('en-US')}` : ''}.{' '}
            {f.notOnBoard > 0 ? 'The board lists each of them as soon as it has a check, without a rebuild.' : ''}
          </span>
        </p>
        {chains.length > 1 && (
          <p className="sw-chains">
            Chain:{' '}
            {chains.map((c) => (
              <a key={c} href={`/watch?chain=${c}`} aria-current={c === chainId ? 'page' : undefined}>
                {chainName(c)}
              </a>
            ))}
          </p>
        )}
        <p className="sw-links">
          <a href="/watch/inbox">Your alerts inbox</a>
          <a href="/watch/demo-hook">Demo webhook receiver</a>
        </p>
      </header>
      <WatchLive initialStatus={status} initialFeed={feed} />
    </main>
  );
}
