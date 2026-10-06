import type { VaultWatchJson } from '../../lib/watch/types';
import { FeedItem } from './FeedItem';

/** The watcher's record of one vault on its page: every feed event about it, newest first. */
export function VaultHistory({ watch }: { watch: VaultWatchJson }) {
  if (watch.history.length === 0) return null;
  return (
    <section className="sw-history" aria-labelledby="hist-h">
      <h2 className="sb-h2" id="hist-h">
        What the watcher saw
      </h2>
      <p className="sb-lede">
        Every event the watcher recorded for this vault, newest first. Each check is a statement about one block; a re-check with the same outcome is recorded
        here without a new attestation.
      </p>
      <ol className="sw-feed">
        {watch.history.map((e) => (
          <FeedItem key={e.seq} e={e} showVault={false} />
        ))}
      </ol>
      <p className="soft" style={{ fontSize: 13 }}>
        JSON: <a href={`/api/v1/watch/vaults/${watch.chainId}/${watch.address}`}>this vault&apos;s history</a>
      </p>
    </section>
  );
}
