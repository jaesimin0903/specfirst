import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const widgetSource = readFileSync(join(here, '..', 'public', 'widget.js'), 'utf8');

/**
 * public/widget.js is a plain, unbundled browser script (no build step), so it is exercised here
 * by evaluating its real source against a jsdom document rather than importing a TypeScript
 * mirror of its logic. A <script> element with a src containing "widget.js" stands in for the
 * real embed tag; document.currentScript is unset when eval'ing text this way (same as it would
 * be by the time a deferred DOMContentLoaded handler runs), which exercises widget.js's own
 * fallback lookup path, not just the currentScript happy path.
 */
function mountWidget(address: string) {
  document.body.innerHTML = '';
  const script = document.createElement('script');
  script.src = 'http://localhost/widget.js';
  script.setAttribute('data-address', address);
  document.body.appendChild(script);
  // eslint-disable-next-line no-eval
  (0, eval)(widgetSource);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const THREE_DAYS_AGO = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();

describe('widget.js', () => {
  it('renders a certified badge that links to the certificate page', async () => {
    const address = '0x4a1f00000000000000000000000000000000c9e2';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ status: 'valid', total: 7, issuedAt: THREE_DAYS_AGO }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    mountWidget(address);
    await vi.waitFor(() => {
      const link = document.querySelector('.specfirst-widget a');
      if (!link) throw new Error('badge not rendered yet');
    });

    const container = document.querySelector('.specfirst-widget');
    expect(container).toBeTruthy();
    expect(container!.innerHTML).toMatchSnapshot();

    const link = container!.querySelector('a')!;
    expect(link.getAttribute('href')).toBe(`http://localhost/c/${address}`);
    expect(link.textContent).toBe('certified, 7 invariants, 3 days ago');
  });

  it('renders a neutral "no certificate" badge for an unlisted address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ status: 'none', total: 0, issuedAt: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    mountWidget('0x1d2e00000000000000000000000000000000dead');
    await vi.waitFor(() => {
      const link = document.querySelector('.specfirst-widget a');
      if (!link) throw new Error('badge not rendered yet');
    });

    const link = document.querySelector('.specfirst-widget a')!;
    expect(link.textContent).toBe('no certificate');
  });

  it('falls back to an "unavailable" badge when the REST call fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })));

    mountWidget('0x1d2e00000000000000000000000000000000dead');
    await vi.waitFor(() => {
      const span = document.querySelector('.specfirst-widget span');
      if (!span) throw new Error('fallback not rendered yet');
    });

    expect(document.querySelector('.specfirst-widget span')!.textContent).toBe('certificate unavailable');
  });
});
