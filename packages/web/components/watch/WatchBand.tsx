'use client';

import { useEffect, useState } from 'react';
import type { WatchStatusJson } from '../../lib/watch/types';
import { STAGE_LABEL } from '../../lib/watch/words';
import { shortAddress } from '../../lib/format';

/**
 * One line at the top of the board: the watcher is running, what it is doing, and how many vaults it found that
 * the hand-made list did not have. Read when the page opens and every 15 s; nothing shows when no watcher runs here.
 */
export function WatchBand() {
  const [s, setS] = useState<WatchStatusJson | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch('/api/v1/watch/status', { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<WatchStatusJson>) : null))
        .then((d) => !stop && d && setS(d))
        .catch(() => {});
    load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && load(), 15_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, []);

  if (!s || (!s.running && s.found.watched === 0)) return null;
  return (
    <div className="sw-band" aria-label="The watcher">
      <div className="sb-wrap">
        <span className="sw-band-h">
          <span className="sw-pulse" data-state={!s.running ? 'off' : s.stale ? 'stale' : 'live'} aria-hidden="true" />
          Watcher
        </span>
        <span>
          <b>{s.found.notOnList}</b> {s.found.notOnList === 1 ? 'vault' : 'vaults'} found on chain that our list did not have
        </span>
        {s.now ? (
          <span>
            {STAGE_LABEL[s.now.stage]} <a href={s.now.vaultPath}>{s.now.label.name ?? shortAddress(s.now.subject)}</a>
          </span>
        ) : (
          <span>{s.running ? 'listening' : 'not running'}</span>
        )}
        {s.behindBlocks !== null && <span>{s.behindBlocks.toLocaleString('en-US')} blocks behind the head</span>}
        <a className="sw-band-cta" href="/watch">
          Watch it work
        </a>
      </div>
    </div>
  );
}
