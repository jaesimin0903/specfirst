import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { FeedItem } from '../components/watch/FeedItem';
import { VaultHistory } from '../components/watch/VaultHistory';
import { alertPayloadSchema } from '../lib/watch/demoHook';
import { alertSummary, inboxNote } from '../lib/watch/words';
import { changedNote } from '../components/watch/WatchLive';
import type { FeedCheck, FeedEvent } from '../lib/watch/core';
import { WatcherVaultView } from '../components/watch/WatcherVaultView';
import { RevenueView } from '../components/watch/RevenueView';
import { BoardExplorer } from '../components/board/BoardExplorer';
import type { ExplorerRow } from '../lib/board/view';
import { parseFeedText } from '../lib/watch/read';
import { checkBefore, eventJson, foundOf, indexFeed, type LabelContext } from '../lib/watch/view';
import { clearReportCache, reportCandidate } from '../lib/watch/reports';
import { feedEventsJson } from '../lib/watch/service';
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
    { cells: e.check ? 'p'.repeat(26) + 'nnnn' : null, reportUrl: e.check ? '/api/v1/reports/x.json' : null, reportMatches: e.check ? true : null, failureLevel: null },
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

describe('MUST and SHOULD levels in the feed, as the board reads them', () => {
  // tyYIELD of test/fixtures/levels, three round trips off by 1 base unit, checked twice with the same result, the
  // second time on another implementation. The two report files live in a temp checks directory.
  const TY = '0xB4641064f64E2F3aAffc1b4b4A66BE75c1C81408';
  const RESULT = { summary: { pass: 27, fail: 3, inconclusive: 0, notApplicable: 0 }, failed: ['RT-redeem-deposit', 'RT-redeem-mint', 'RT-withdraw-deposit'] };
  const saved = { ...process.env };
  let dir: string;
  let feed: FeedEvent[];

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sf-watch-levels-'));
    const vaultDir = path.join(dir, 'checks', '143', TY.toLowerCase());
    await mkdir(vaultDir, { recursive: true });
    const report = JSON.parse(await readFile(path.join(here, 'fixtures/levels/143', TY.toLowerCase(), '109195820.json'), 'utf8'));
    await writeFile(path.join(vaultDir, '109195820.json'), JSON.stringify(report));
    await writeFile(path.join(vaultDir, '109195900.json'), JSON.stringify({ ...report, blockNumber: '109195900', identity: { ...report.identity, implementationKey: `0x${'ab'.repeat(32)}` } }));
    Object.assign(process.env, { SPECFIRST_CHECKS_DIR: path.join(dir, 'checks'), SPECFIRST_WATCH_DIR: path.join(dir, 'watch'), SPECFIRST_BOARD_DATA: path.join(dir, 'board') });
    clearReportCache();
    const check = async (block: string): Promise<FeedCheck> => {
      const reportPath = `certs/checks/143/${TY.toLowerCase()}/${block}.json`;
      const { candidate } = await reportCandidate(reportPath);
      const hex = (v: string) => v as `0x${string}`;
      return { block, ...RESULT, implementationKey: hex(candidate!.report.identity.implementationKey), reportPath, reportHash: hex(candidate!.reportHash), durationMs: 60_000 };
    };
    const [a, b] = [await check('109195820'), await check('109195900')];
    const ev = (seq: number, over: Partial<FeedEvent>): FeedEvent => ({ v: 1, seq, at: '2026-10-07T09:00:00.000Z', kind: 'checked', chainId: 143, subject: TY, ...over });
    feed = [
      ev(1, { check: a }),
      ev(2, { check: b }),
      ev(3, { kind: 'changed', check: b, change: { kind: 'implementation', from: RESULT, to: RESULT } }),
      ev(4, { check: { ...a, reportHash: `0x${'00'.repeat(32)}` } }),
    ];
  });

  afterAll(async () => {
    process.env = saved;
    clearReportCache();
    await rm(dir, { recursive: true, force: true });
  });

  it('a check whose only failures are rounding-sized round trips: "Rounding favors caller", not "Spec mismatch"', async () => {
    const [first] = await feedEventsJson([feed[0]!], 143, feed);
    expect(first!.check).toMatchObject({ status: 'mismatch', reportMatches: true, failureLevel: 'rounding' });
    render(
      <ol>
        <FeedItem e={first!} />
      </ol>,
    );
    expect(screen.getByText('Rounding favors caller')).toHaveAttribute('data-s', 'should');
    expect(screen.queryByText('Spec mismatch')).toBeNull();
  });

  it('a change of implementation with the same result: both sides read from their own reports', async () => {
    // The check before is the first one, not the change's own check, though both have the same result.
    expect(checkBefore(feed[2]!, feed)).toBe(feed[0]!.check);
    expect(checkBefore(feed[1]!, feed)).toBeNull();
    const [changed] = await feedEventsJson([feed[2]!], 143, feed);
    expect(changed!.change).toMatchObject({ kind: 'implementation', from: { failureLevel: 'rounding' }, to: { failureLevel: 'rounding' } });
    render(
      <ol>
        <FeedItem e={changed!} />
      </ol>,
    );
    expect(screen.getAllByText('Rounding favors caller')).toHaveLength(2);
    expect(screen.queryByText('Spec mismatch')).toBeNull();
  });

  it("a report that does not hash to the feed's reportHash is not read for levels: the failed ids alone say mismatch", async () => {
    const [stale] = await feedEventsJson([feed[3]!], 143, feed);
    expect(stale!.check).toMatchObject({ reportMatches: false, failureLevel: null });
    render(
      <ol>
        <FeedItem e={stale!} />
      </ol>,
    );
    expect(screen.getByText('Spec mismatch')).toBeInTheDocument();
    expect(screen.getByText(/does not hash to the feed's reportHash/)).toBeInTheDocument();
  });
});

describe('a share value drop', () => {
  const change = { kind: 'price-drop', fromAssetsPerShare: '1004200', toAssetsPerShare: '1000000', dropBps: 41, fromBlock: '110977300', toBlock: '110977400' } as const;
  const drop: FeedEvent = {
    v: 1,
    seq: 40,
    at: '2026-10-07T09:00:00.000Z',
    kind: 'changed',
    chainId: 143,
    subject: '0xFEeD000000000000000000000000000000000001',
    source: 'price-drop',
    block: '110977400',
    change,
    reason: 'confirmed by a second read at block 110977400 after block 110977350',
  };

  it('in the feed, the vault history and the inbox: how much, between which blocks, both values; no verdict', () => {
    const e = eventJson(drop, ctx);
    expect(e.change).toEqual(change);
    expect(e.sourceText).toBe('share value fell');
    const watch: VaultWatchJson = {
      chainId: 143,
      address: MORPHO,
      watched: true,
      found: null,
      lastCheck: null,
      lastAttestationId: null,
      label: e.label,
      history: [e],
      readAt: '2026-10-07T09:00:01.000Z',
    };
    render(
      <>
        <ol>
          <FeedItem e={e} />
        </ol>
        <VaultHistory watch={watch} />
        <ol>
          <FeedItem e={e} note={`${inboxNote('change', e.change!.kind)}, subscription #3`} />
        </ol>
      </>,
    );
    expect(screen.getAllByText('Share value fell')).toHaveLength(3);
    for (const label of screen.getAllByText('Share value fell')) expect(label).toHaveAttribute('data-change', 'price-drop');
    expect(screen.getAllByText('Share value fell 0.41% between block 110,977,300 and block 110,977,400.')).toHaveLength(3);
    expect(screen.getAllByText(/convertToAssets of one share, in the asset's base units: 1,004,200 at block 110,977,300, 1,000,000 at block 110,977,400/)).toHaveLength(3);
    expect(screen.getByText('Share value fell, subscription #3')).toBeInTheDocument();
    // A fact about two blocks: no pass or fail chip, no failing properties.
    expect(screen.queryByText(/Now failing/)).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('values of 10 ** scale shares say so', () => {
    render(
      <ol>
        <FeedItem e={eventJson({ ...drop, change: { ...change, fromAssetsPerShare: '99900', toAssetsPerShare: '90000', dropBps: 990, scale: 3 } }, ctx)} />
      </ol>,
    );
    expect(screen.getByText(/convertToAssets of 1,000 shares, in the asset's base units: 99,900 at block 110,977,300, 90,000 at block 110,977,400/)).toBeInTheDocument();
  });

  it('review L4: the 24 h figure of changed results names the share value drops apart', () => {
    expect(changedNote(undefined)).toBe('results that moved, last 24 h');
    expect(changedNote(0)).toBe('results that moved, last 24 h');
    expect(changedNote(1)).toBe('results that moved, last 24 h; apart from them 1 share value drop');
    expect(changedNote(3)).toBe('results that moved, last 24 h; apart from them 3 share value drops');
  });

  it('the demo receiver takes the price-drop payload as an alert and says what fell; review L5: a kind it does not know is still an alert', () => {
    const payload = {
      v: 1,
      kind: 'price-drop',
      key: 'price-drop:143:0xfeed000000000000000000000000000000000001:110977300',
      subscriptionId: '3',
      subscriptionIds: ['3'],
      subject: drop.subject,
      chainId: 143,
      change,
      check: null,
      attestation: null,
      reportURL: null,
    };
    expect(alertPayloadSchema.safeParse(payload).success).toBe(true);
    expect(alertPayloadSchema.safeParse({ ...payload, kind: 'price-rise', future: 1 }).success).toBe(true);
    expect(alertSummary({ ...payload, kind: 'price-rise', change: null })).toBe('Subscription #3: price-rise on 0xFEeD...0001, chain 143');
    expect(alertPayloadSchema.safeParse({ ...payload, v: 2 }).success).toBe(false);
    expect(alertSummary(payload)).toBe('Subscription #3: share value fell 0.41% between block 110977300 and block 110977400 on 0xFEeD...0001, chain 143');
    expect(alertSummary({ ...payload, kind: 'change', change: { kind: 'regressed' } })).toBe('Subscription #3: regressed on 0xFEeD...0001, chain 143');
    expect(alertSummary({ ...payload, change: { ...change, dropBps: '<b>' } })).toBe('Subscription #3: price-drop on 0xFEeD...0001, chain 143');
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
