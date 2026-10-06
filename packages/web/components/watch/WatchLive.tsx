'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedEventJson, FeedPageJson, WatchStatusJson } from '../../lib/watch/types';
import { blockText, STAGE_LABEL } from '../../lib/watch/words';
import { formatDuration } from '../../lib/desk/format';
import { shortAddress } from '../../lib/format';
import { FeedItem } from './FeedItem';

const POLL_MS = 3_000;
const MAX_EVENTS = 400;

type Filter = 'all' | 'results' | 'finds';
const FILTERS: Record<Filter, { label: string; kinds: ReadonlySet<string> | null }> = {
  all: { label: 'Everything', kinds: null },
  results: { label: 'Results', kinds: new Set(['checked', 'attested', 'changed']) },
  finds: { label: 'Finds', kinds: new Set(['detected', 'probe-rejected']) },
};

function merge(cur: FeedEventJson[], incoming: FeedEventJson[]): FeedEventJson[] {
  const seen = new Set(cur.map((e) => e.seq));
  return [...incoming.filter((e) => !seen.has(e.seq)), ...cur].sort((a, b) => b.seq - a.seq).slice(0, MAX_EVENTS);
}

/**
 * The live part of /watch: what the watcher is doing, how far behind it is, and its feed, read again every three
 * seconds while the tab is visible. New events slide in at the top.
 */
export function WatchLive({ initialStatus, initialFeed }: { initialStatus: WatchStatusJson; initialFeed: FeedPageJson }) {
  const chainId = initialStatus.chainId;
  const [status, setStatus] = useState(initialStatus);
  const [events, setEvents] = useState(initialFeed.events);
  const [hasOlder, setHasOlder] = useState(initialFeed.hasOlder);
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [offline, setOffline] = useState(false);
  const latest = useRef<number | null>(initialFeed.latestSeq);

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const after = latest.current;
        const [s, f] = await Promise.all([
          fetch(`/api/v1/watch/status?chainId=${chainId}`, { cache: 'no-store' }).then((r) => r.json() as Promise<WatchStatusJson>),
          fetch(`/api/v1/watch/feed?chainId=${chainId}&limit=60${after !== null ? `&after=${after}` : ''}`, { cache: 'no-store' }).then(
            (r) => r.json() as Promise<FeedPageJson>,
          ),
        ]);
        if (stop) return;
        setStatus(s);
        setOffline(false);
        if (f.latestSeq !== null && after !== null && f.latestSeq < after) {
          // The feed was replaced (a new watcher run): start over from what is there now.
          setEvents(f.events);
          setHasOlder(f.hasOlder);
        } else if (f.gap) {
          setEvents(f.events);
          setHasOlder(true);
        } else if (f.events.length) {
          setEvents((cur) => merge(cur, f.events));
          const ids = new Set(f.events.map((e) => e.seq));
          setFresh(ids);
          window.setTimeout(() => !stop && setFresh(new Set()), 4_000);
        }
        latest.current = f.latestSeq;
      } catch {
        if (!stop) setOffline(true);
      }
    };
    const t = window.setInterval(tick, POLL_MS);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [chainId]);

  const loadOlder = useCallback(async () => {
    const oldest = events[events.length - 1];
    if (!oldest) return;
    setLoadingOlder(true);
    try {
      const f = (await fetch(`/api/v1/watch/feed?chainId=${chainId}&limit=40&before=${oldest.seq}`, { cache: 'no-store' }).then((r) =>
        r.json(),
      )) as FeedPageJson;
      setEvents((cur) => [...cur, ...f.events.filter((e) => !cur.some((c) => c.seq === e.seq))]);
      setHasOlder(f.hasOlder);
    } finally {
      setLoadingOlder(false);
    }
  }, [chainId, events]);

  const shown = useMemo(() => {
    const kinds = FILTERS[filter].kinds;
    return kinds ? events.filter((e) => kinds.has(e.kind)) : events;
  }, [events, filter]);

  const s = status;
  const state = !s.running ? 'off' : s.stale ? 'stale' : 'live';

  return (
    <>
      <section className="sw-now" aria-label="The watcher right now" data-state={state}>
        <div className="sw-now-cell">
          <span className="sw-now-label">
            <span className="sw-pulse" data-state={state} aria-hidden="true" />
            {state === 'live' ? 'Running' : state === 'stale' ? 'No update lately' : 'Not running'}
          </span>
          <span className="sw-now-n">{s.head ? blockText(s.head) : 'n/a'}</span>
          <span className="sw-now-note">
            {s.running
              ? `head block of ${s.chainName}, status written ${s.updatedAgoSec !== null ? `${formatDuration(s.updatedAgoSec)} ago` : 'at an unknown time'}`
              : s.problem === 'not running'
                ? `no watcher files under ${s.dir}/${s.chainId}`
                : (s.problem ?? 'status unavailable')}
          </span>
        </div>
        <div className="sw-now-cell">
          <span className="sw-now-label">Behind the head</span>
          <span className="sw-now-n">
            {s.behindBlocks !== null ? s.behindBlocks.toLocaleString('en-US') : 'n/a'}
            <small>blocks</small>
          </span>
          <span className="sw-now-note">
            {s.behindSeconds !== null ? `about ${formatDuration(s.behindSeconds)} at 0.4 s a block` : 'unknown'}
            {s.lagBlocks !== null ? `; checks fork ${s.lagBlocks} blocks below the head` : ''}
          </span>
        </div>
        <div className="sw-now-cell sw-now-wide">
          <span className="sw-now-label">Doing now</span>
          {s.now ? (
            <>
              <span className="sw-now-what">
                <span className="sw-stage" data-stage={s.now.stage}>
                  {STAGE_LABEL[s.now.stage]}
                </span>{' '}
                <a href={s.now.vaultPath} className={s.now.label.name ? undefined : 'mono'}>
                  {s.now.label.name ?? shortAddress(s.now.subject)}
                </a>
              </span>
              <span className="sw-now-note">
                {s.now.label.protocol ? `${s.now.label.protocol}, ` : ''}because of a {s.now.source} signal, for {formatDuration(s.now.forSec)}
              </span>
            </>
          ) : (
            <>
              <span className="sw-now-what soft">{s.running ? 'Listening' : 'Nothing'}</span>
              <span className="sw-now-note">
                {s.running ? 'No check running; waiting for the next signal or the next scheduled re-check.' : 'Start the watcher to see it work here.'}
              </span>
            </>
          )}
        </div>
        <div className="sw-now-cell">
          <span className="sw-now-label">Queue</span>
          <span className="sw-now-n">{s.queueLength}</span>
          <span className="sw-now-note">
            {s.queue.length
              ? s.queue
                  .slice(0, 2)
                  .map((q) => `${q.label.name ?? shortAddress(q.subject)} (${q.source})`)
                  .join(', ')
              : 'empty'}
          </span>
        </div>
      </section>
      {offline && (
        <p className="sb-status-line" data-tone="error" role="status">
          This page could not reach the server for the last update; it keeps trying.
        </p>
      )}

      <div className="sb-figures sw-figures" data-count="5" aria-label="The last 24 hours">
        <Fig n={s.counts?.detected24h} label="Found" note="vault signals, last 24 h" />
        <Fig n={s.counts?.checked24h} label="Checked" note="30 properties each, last 24 h" />
        <Fig n={s.counts?.attested24h} label="Attested" note="on Monad testnet, last 24 h" tone="seal" />
        <Fig n={s.counts?.changed24h} label="Changed" note="results that moved, last 24 h" />
        <Fig
          n={s.attestBudget ? `${s.attestBudget.usedToday}/${s.attestBudget.perDay}` : undefined}
          label="Attestations today"
          note="the daily cap keeps testnet gas bounded"
        />
      </div>

      <div className="sw-grid">
        <section aria-labelledby="feed-h">
          <div className="sw-feed-head">
            <h2 className="sb-h2" id="feed-h">
              What it did
            </h2>
            <div className="sb-seg" role="group" aria-label="Show">
              {(Object.keys(FILTERS) as Filter[]).map((k) => (
                <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
                  {FILTERS[k].label}
                </button>
              ))}
            </div>
          </div>
          <p className="sb-lede">
            Newest first, from the watcher&apos;s feed. A check is a statement about one block: pass means no counterexample to these 30 properties was found
            there, not that the vault is safe.
          </p>
          {shown.length === 0 ? (
            <p className="sb-empty">
              {events.length === 0
                ? s.running
                  ? 'The feed is empty so far.'
                  : 'No feed to show: the watcher has not written one here.'
                : 'Nothing of this kind among the loaded events.'}
            </p>
          ) : (
            <ol className="sw-feed" aria-live="polite">
              {shown.map((e) => (
                <FeedItem key={e.seq} e={e} fresh={fresh.has(e.seq)} />
              ))}
            </ol>
          )}
          {hasOlder && (
            <p>
              <button type="button" className="sb-action" data-kind="quiet" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? 'Loading' : 'Older events'}
              </button>
            </p>
          )}
        </section>
        <aside className="sb-aside sw-aside">
          <section aria-labelledby="src-h">
            <h2 className="sb-h3" id="src-h">
              What it listens to
            </h2>
            {s.sources.length === 0 ? (
              <p className="soft">No sources reported.</p>
            ) : (
              <table className="sb-table sw-sources">
                <thead>
                  <tr>
                    <th scope="col">Signal</th>
                    <th scope="col" className="r">
                      Seen
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.sources.map((x) => (
                    <tr key={`${x.name}:${x.topic0}`}>
                      <td>
                        {x.name}
                        <span className="sb-vault-sub mono" title={x.topic0}>
                          {x.address ? shortAddress(x.address) : 'any address'}
                        </span>
                      </td>
                      <td className={`r ${x.seen ? '' : 'zero'}`}>{x.seen.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section aria-labelledby="q-h">
            <h2 className="sb-h3" id="q-h">
              Queue
            </h2>
            {s.queue.length === 0 ? (
              <p className="soft">Empty.</p>
            ) : (
              <ol className="sw-queue">
                {s.queue.map((q) => (
                  <li key={`${q.subject}:${q.enqueuedAt}`}>
                    <a href={q.vaultPath} className={q.label.name ? undefined : 'mono'}>
                      {q.label.name ?? shortAddress(q.subject)}
                    </a>
                    <span className="soft">{q.source}</span>
                  </li>
                ))}
              </ol>
            )}
            {s.queueLength > s.queue.length && <p className="soft">and {s.queueLength - s.queue.length} more</p>}
          </section>
          <section aria-labelledby="files-h">
            <h2 className="sb-h3" id="files-h">
              Files
            </h2>
            <dl className="sb-facts">
              <dt>Directory</dt>
              <dd className="mono">
                {s.dir}/{s.chainId}
              </dd>
              <dt>Feed</dt>
              <dd>
                {s.feed.available ? `${s.feed.events.toLocaleString('en-US')} events` : (s.feed.problem ?? 'unavailable')}
                {s.feed.skipped ? `, ${s.feed.skipped} lines skipped` : ''}
              </dd>
              <dt>Vaults</dt>
              <dd>
                {s.vaultsFile.available ? `${s.found.watched} known to the watcher` : (s.vaultsFile.problem ?? 'unavailable')}
                {s.vaultsFile.skipped ? `, ${s.vaultsFile.skipped} entries skipped` : ''}
              </dd>
              <dt>Started</dt>
              <dd>{s.startedAt ? `${s.startedAt.slice(0, 16).replace('T', ' ')} UTC` : 'n/a'}</dd>
              <dt>Known set</dt>
              <dd>{s.counts ? `${s.counts.known.toLocaleString('en-US')} vaults` : 'n/a'}</dd>
            </dl>
            <p className="soft" style={{ fontSize: 13, marginTop: 10 }}>
              JSON: <a href={`/api/v1/watch/status?chainId=${s.chainId}`}>status</a>, <a href={`/api/v1/watch/feed?chainId=${s.chainId}`}>feed</a>
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function Fig({ n, label, note, tone }: { n: number | string | undefined; label: string; note: string; tone?: string }) {
  return (
    <div className="sb-figure" data-tone={tone}>
      <span className="sb-figure-n">{n === undefined ? 'n/a' : n}</span>
      <span className="sb-figure-label">{label}</span>
      <span className="sb-figure-note">{note}</span>
    </div>
  );
}
