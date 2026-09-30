'use client';

import { useEffect, useState } from 'react';
import type { RecentRequestJson } from '../../lib/desk/types';
import { shortAddress, timeAgo } from '../../lib/format';
import { StageTag } from './Marks';

interface RecentResponse {
  deployed: boolean;
  requests: RecentRequestJson[];
}

/**
 * The band at the top of the board. The board itself is prerendered from the build; this line is read when the
 * page is opened, so a check someone paid for a minute ago shows here before the next build.
 */
export function RecentRequests({ limit = 5 }: { limit?: number }) {
  const [data, setData] = useState<RecentResponse | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch(`/api/desk/requests?limit=${limit}`, { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: RecentResponse | null) => !stop && d && setData(d))
        .catch(() => {});
    load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && load(), 20_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [limit]);

  const items = data?.requests ?? [];
  return (
    <div className="sb-recent" aria-label="Recently requested checks">
      <div className="sb-wrap">
        <span className="sb-recent-h">Recently requested</span>
        {items.length > 0 ? (
          <ol>
            {items.map((it) => {
              const name = it.vault.name ?? shortAddress(it.request.subject);
              const href = it.request.status === 'Fulfilled' ? `/v/${it.request.subjectChainId}/${it.request.subject.toLowerCase()}` : `/check/${it.request.id}`;
              return (
                <li key={it.request.id}>
                  <StageTag label={it.label} tone={it.tone} />
                  <a href={href} title={`Request #${it.request.id}, ${it.request.subject}`}>
                    {name}
                  </a>
                  <time className="soft" dateTime={it.request.requestedAt}>
                    {timeAgo(it.request.requestedAt)}
                  </time>
                </li>
              );
            })}
          </ol>
        ) : (
          <span style={{ flex: '1 1 auto' }}>{data === null ? '' : data.deployed ? 'No requests yet. Be the first.' : 'Paid re-checks open when the desk is deployed.'}</span>
        )}
        <a className="sb-recent-cta" href="/check">
          Request a check
        </a>
      </div>
    </div>
  );
}
