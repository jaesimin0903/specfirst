import type { Metadata } from 'next';
import { DemoHookLive } from '../../../../components/watch/DemoHookLive';
import { alertPayloadSchema, demoHookEnabled, readDemoHooks } from '../../../../lib/watch/demoHook';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Demo webhook receiver | Specfirst',
  description: 'A demo receiver that shows the alerts the watcher POSTs to a webhook, so a delivery is visible without an outside service.',
  robots: { index: false },
};

export default async function DemoHookPage() {
  const enabled = demoHookEnabled();
  const received = enabled ? (await readDemoHooks()).map((e) => ({ ...e, isAlert: alertPayloadSchema.safeParse(e.body).success })) : [];
  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/watch">Watch</a> / <a href="/watch/inbox">Inbox</a>
      </p>
      <header className="sb-desk-hero">
        <p className="sb-eyebrow">
          <span className="sw-demo-tag">Demo receiver</span>
        </p>
        <h1 className="sb-claim">What a webhook alert looks like when it arrives.</h1>
        <p className="sb-sub">
          This page is a stand-in for your own server: point a webhook at it and every POST it gets is listed here as received. It exists for demos and is not
          where real alerts should go.
        </p>
      </header>
      <DemoHookLive initial={received} enabled={enabled} />
    </main>
  );
}
