'use client';

import { useEffect, useState } from 'react';
import { alertSummary } from '../../lib/watch/words';

interface Received {
  n: number;
  receivedAt: string;
  userAgent: string | null;
  bytes: number;
  body: unknown;
  isAlert: boolean;
}

/** What the demo receiver got, read every three seconds. */
export function DemoHookLive({ initial, enabled }: { initial: Received[]; enabled: boolean }) {
  const [items, setItems] = useState<Received[]>(initial);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    setUrl(`${window.location.origin}/api/v1/watch/demo-hook`);
    if (!enabled) return;
    let stop = false;
    const t = window.setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await fetch('/api/v1/watch/demo-hook', { cache: 'no-store' });
        const d = (await r.json()) as { received?: Received[] };
        if (!stop && Array.isArray(d.received)) setItems(d.received);
      } catch {
        // Try again on the next tick.
      }
    }, 3_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [enabled]);

  if (!enabled) {
    return (
      <div className="sb-notice">
        <h2>The demo receiver is off</h2>
        <p>This server runs with SPECFIRST_DEMO_HOOK=off, so it does not accept or show webhook bodies.</p>
      </div>
    );
  }
  return (
    <>
      <section className="sw-section" style={{ borderTop: 0, paddingTop: 0 }} aria-labelledby="url-h">
        <h2 className="sb-h3" id="url-h">
          Register this URL as your webhook
        </h2>
        <code className="sw-url">{url ?? '/api/v1/watch/demo-hook'}</code>
        <p className="soft" style={{ fontSize: 13.5 }}>
          On <a href="/watch/inbox">your inbox</a>, under Webhook. A watcher delivery for a vault you watch then appears below within seconds. It keeps the last
          50 JSON bodies of at most 64 KB; anyone can post to it, so treat what it shows as untrusted.
        </p>
      </section>
      <section className="sw-section" aria-labelledby="got-h">
        <h2 className="sb-h2" id="got-h">
          Received
        </h2>
        {items.length === 0 ? (
          <p className="sb-empty">Nothing received yet.</p>
        ) : (
          <ol className="sw-hooks">
            {items.map((it) => (
              <li key={it.n}>
                <p className="sw-hook-head">
                  <strong>#{it.n}</strong>
                  <time dateTime={it.receivedAt}>{it.receivedAt.slice(0, 19).replace('T', ' ')} UTC</time>
                  <span className={it.isAlert ? 'sw-tag' : 'soft'}>{it.isAlert ? 'alert payload' : 'not an alert payload'}</span>
                  <span className="soft">{it.bytes.toLocaleString('en-US')} bytes</span>
                  {it.userAgent && <span className="soft mono">{it.userAgent}</span>}
                </p>
                {alertSummary(it.body) && <p style={{ margin: '4px 0 0', fontSize: 14 }}>{alertSummary(it.body)}</p>}
                <pre>{JSON.stringify(it.body, null, 2)}</pre>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
