import type { ReactNode } from 'react';
import type { VaultWatchJson } from '../../lib/watch/types';
import { chainName } from '../../lib/board/reproduce';
import { foundSentence, KIND_LABEL } from '../../lib/watch/words';
import { VaultHistory } from './VaultHistory';

function stateSentence(w: VaultWatchJson): string {
  const last = w.history[0];
  if (!last) return 'The watcher knows this vault but has not recorded anything about it yet.';
  switch (last.kind) {
    case 'probe-rejected':
      return `The watcher's pre-check refused it: ${last.reason ?? 'not an ERC-4626 vault'}. It is not retried until a new signal arrives.`;
    case 'error':
      return `The last check could not finish: ${last.reason ?? 'no reason given'}. The watcher tries again on the next signal or scheduled re-check.`;
    case 'queued':
    case 'detected':
      return "Waiting in the watcher's queue for its first check. This page shows the result once the report is written.";
    default:
      return `Last event: ${KIND_LABEL[last.kind].toLowerCase()}. The report file is not on this server yet.`;
  }
}

/** A vault the watcher found that has no report here yet: how it was found and what happened since. */
export function WatcherVaultView({ watch, subscribe }: { watch: VaultWatchJson; subscribe?: ReactNode }) {
  const title = watch.label.name ?? watch.address;
  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/">All vaults</a> / <a href="/watch">Watch</a>
      </p>
      <header className="sb-vault-head">
        <span className="sb-chip" data-s="not_applicable">
          Not checked yet
        </span>
        <h1 className="sb-vault-name">{title}</h1>
        <p className="sb-vault-meta">
          {watch.label.protocol && <span>{watch.label.protocol}</span>}
          <span className="mono break">{watch.address}</span>
          <span>{chainName(watch.chainId)}</span>
        </p>
        {watch.found && (
          <p className="sw-vault-found">
            {foundSentence(watch.found)}
            {watch.label.onList ? '' : ' It was not on the hand-made list the board started from.'}
          </p>
        )}
        <p className="sb-verdict">{stateSentence(watch)}</p>
      </header>
      <div className="sb-vault-grid">
        <div>
          <VaultHistory watch={watch} />
        </div>
        <aside className="sb-aside">{subscribe}</aside>
      </div>
    </main>
  );
}
