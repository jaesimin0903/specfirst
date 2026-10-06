import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FeedItem } from '../components/watch/FeedItem';
import { WatcherVaultView } from '../components/watch/WatcherVaultView';
import { RevenueView } from '../components/watch/RevenueView';
import { BoardExplorer } from '../components/board/BoardExplorer';
import type { ExplorerRow } from '../lib/board/view';
import { parseFeedText } from '../lib/watch/read';
import { eventJson, foundOf, indexFeed, type LabelContext } from '../lib/watch/view';
import type { VaultWatchJson } from '../lib/watch/types';
import type { RevenueJson } from '../lib/subs/revenue';

/* The watch pieces as a reader sees them, on the synthetic fixtures. */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, 'fixtures/watch/143');
const { events } = parseFeedText(readFileSync(path.join(DIR, 'feed.ndjson'), 'utf8'));
const vaults = JSON.parse(readFileSync(path.join(DIR, 'vaults.json'), 'utf8')).vaults;
const MORPHO = '0xfeed000000000000000000000000000000000001';
const ctx: LabelContext = { meta: null, boardIds: new Set(), factories: indexFeed(events).factories };
const json = (i: number) => {
  const e = events[i]!;
  const a = e.subject.toLowerCase();
  return eventJson(
    e,
    ctx,
    { cells: e.check ? 'p'.repeat(26) + 'nnnn' : null, reportUrl: e.check ? '/api/v1/reports/x.json' : null, reportMatches: e.check ? true : null },
    foundOf(vaults[a], indexFeed(events).firstDetected.get(a)),
  );
};

afterEach(cleanup);

describe('FeedItem', () => {
  it('a factory find, then its first check with the creation block against the check time', () => {
    const detected = events.findIndex((e) => e.kind === 'detected' && e.subject.toLowerCase() === MORPHO);
    const checked = events.findIndex((e) => e.kind === 'checked' && e.subject.toLowerCase() === MORPHO);
    render(
      <ol>
        <FeedItem e={json(detected)} />
        <FeedItem e={json(checked)} />
      </ol>,
    );
    expect(screen.getByText(/Created by Morpho VaultV2Factory in block 110,930,586/)).toBeInTheDocument();
    expect(screen.getByText(/check finished at 08:05:00 UTC, 5 min later, forked 30 blocks after creation/)).toBeInTheDocument();
    expect(screen.getAllByText('not on our list')).toHaveLength(2);
    expect(screen.getByRole('img', { name: /30 property results: 26 pass, 4 not applicable/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('href', '/api/v1/reports/x.json');
  });

  it('a regression names the properties that now fail; a failed delivery says so', () => {
    const regressed = events.findIndex((e) => e.change?.kind === 'regressed');
    const failed = events.findIndex((e) => e.alert && !e.alert.ok);
    render(
      <ol>
        <FeedItem e={json(regressed)} />
        <FeedItem e={json(failed)} />
      </ol>,
    );
    expect(screen.getByText('Regressed')).toBeInTheDocument();
    expect(screen.getByText(/Now failing: sf-maxWithdraw-honored, sf-maxRedeem-honored/)).toBeInTheDocument();
    expect(screen.getByText('Alert failed')).toBeInTheDocument();
    expect(screen.getByText(/Webhook delivery for subscription #3, HTTP 500, failed after the retries/)).toBeInTheDocument();
  });
});

describe('a vault the watcher found but has not checked', () => {
  it('says how it was found and what it waits for', () => {
    const euler = '0xfeed000000000000000000000000000000000005';
    const mine = events.map((e, i) => [e, i] as const).filter(([e]) => e.subject.toLowerCase() === euler);
    const watch: VaultWatchJson = {
      chainId: 143,
      address: euler,
      watched: true,
      found: foundOf(vaults[euler], mine[0]![0]),
      lastCheck: null,
      lastAttestationId: null,
      label: { name: null, protocol: 'Euler EVK (eVault)', assetSymbol: null, onList: false, onBoard: false },
      history: mine.map(([, i]) => json(i)).reverse(),
      readAt: '2026-10-06T09:30:00.000Z',
    };
    render(<WatcherVaultView watch={watch} subscribe={<p>box</p>} />);
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Created by Euler EVK GenericFactory in block 110,976,900; the watcher found it 2026-10-06 09:28 UTC\. It was not on the hand-made list/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/Waiting in the watcher's queue for its first check/)).toBeInTheDocument();
    expect(screen.getByText('box')).toBeInTheDocument();
  });
});

describe('board overlay rows', () => {
  it('a row the watcher found carries the mark', () => {
    const row: ExplorerRow = {
      id: `143/${MORPHO}`,
      address: '0xFEeD000000000000000000000000000000000001',
      name: null,
      protocol: 'Morpho Vault V2',
      assetSymbol: null,
      status: 'complete',
      summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 },
      cells: 'p'.repeat(30),
      implementationKey: '0xabc',
      implementationKeyKind: { of: 'self', hash: 'h' },
      implementationAddress: null,
      groupSize: 1,
      failed: [],
      attestation: { kind: 'none' },
      found: { sourceText: 'from Morpho VaultV2Factory', block: '110930586', at: '2026-10-06T08:00:00.000Z' },
    };
    render(<BoardExplorer rows={[row]} protocols={['Morpho Vault V2']} split={26} />);
    const mark = screen.getByText('Found by the watcher');
    expect(mark).toHaveAttribute('title', 'Found by the watcher from Morpho VaultV2Factory at block 110930586, 2026-10-06');
  });
});

describe('revenue', () => {
  it('shows both contracts, both gas bills and a net, and says what it could not count', () => {
    const r: RevenueJson = {
      desk: { deployed: true, earnedWei: '200000000000000000', escrowedWei: '0', withdrawnWei: '0' },
      subs: { deployed: false, address: null, earnedWei: null, escrowedWei: null, withdrawnWei: null, feePerDayWei: null, count: null, errors: [] },
      earnedWei: '200000000000000000',
      escrowedWei: '0',
      withdrawnWei: '0',
      deskGasWei: '250000000000000000',
      watcherGasWei: null,
      watcherGasChains: [],
      gasWei: '250000000000000000',
      netWei: '-50000000000000000',
      missing: ['subscription fees', 'watcher gas'],
    };
    render(<RevenueView r={r} />);
    expect(screen.getByText('not deployed yet')).toBeInTheDocument();
    const facts = screen.getByText('Net').nextElementSibling as HTMLElement;
    expect(within(facts).getByText('-0.05 MON')).toBeInTheDocument();
    expect(screen.getByText(/Not counted, because it could not be read or is not reported: subscription fees, watcher gas\./)).toBeInTheDocument();
  });
});
