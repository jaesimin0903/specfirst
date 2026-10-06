import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExplorerRow } from '../lib/board/view';
import { filterRows, ALL } from '../lib/board/view';
import { inboxEntries } from '../lib/watch/inbox';
import { mergeOverlay, mergedProtocols } from '../lib/watch/overlay';
import { parseFeedText, parseWatchStatus } from '../lib/watch/read';
import { countFound, eventJson, foundOf, indexFeed, labelFor, pageOf, sourceText, statusJson, type LabelContext } from '../lib/watch/view';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, 'fixtures/watch/143');
const { events } = parseFeedText(readFileSync(path.join(DIR, 'feed.ndjson'), 'utf8'));
const { status } = parseWatchStatus(JSON.parse(readFileSync(path.join(DIR, 'status.json'), 'utf8')));
const vaults = JSON.parse(readFileSync(path.join(DIR, 'vaults.json'), 'utf8')).vaults;
const MORPHO = '0xfeed000000000000000000000000000000000001';
const UPGRADED = '0xfeed000000000000000000000000000000000003';

const ctx: LabelContext = {
  meta: { '143': { [UPGRADED]: { name: 'Listed vault', protocol: 'Curvance', assetSymbol: 'USDC' } } },
  boardIds: new Set([`143/${UPGRADED}`]),
  factories: indexFeed(events).factories,
};

function row(id: string, key: string, over: Partial<ExplorerRow> = {}): ExplorerRow {
  return {
    id: `143/${id}`,
    address: id,
    name: null,
    protocol: null,
    assetSymbol: null,
    status: 'complete',
    summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 },
    cells: 'p'.repeat(30),
    implementationKey: key,
    implementationKeyKind: { of: 'self', hash: 'h' },
    implementationAddress: null,
    groupSize: 1,
    failed: [],
    attestation: { kind: 'none' },
    ...over,
  };
}

describe('labels and sources', () => {
  it('names a listed vault from the metadata and a factory find by the board protocol label', () => {
    expect(labelFor(143, UPGRADED, ctx)).toEqual({ name: 'Listed vault', protocol: 'Curvance', assetSymbol: 'USDC', onList: true, onBoard: true });
    expect(labelFor(143, MORPHO, ctx)).toEqual({ name: null, protocol: 'Morpho Vault V2', assetSymbol: null, onList: false, onBoard: false });
    expect(sourceText('factory', { name: 'Morpho VaultV2Factory' })).toBe('from Morpho VaultV2Factory');
    expect(sourceText('first-deposit')).toBe('first deposit after its last check');
    expect(sourceText(null)).toBeNull();
  });

  it('a checked event carries its result, its status word and how the vault was found', () => {
    const first = events.find((e) => e.kind === 'checked' && e.subject.toLowerCase() === MORPHO)!;
    const found = foundOf(vaults[MORPHO], indexFeed(events).firstDetected.get(MORPHO));
    const j = eventJson(first, ctx, { cells: 'p'.repeat(26) + 'nnnn', reportUrl: '/api/v1/reports/x', reportMatches: true }, found);
    expect(j.check).toMatchObject({ status: 'partial', cells: 'p'.repeat(26) + 'nnnn', reportMatches: true, summary: { pass: 26, notApplicable: 4 } });
    expect(j.found).toMatchObject({ source: 'factory', deployBlock: '110930586', factory: { name: 'Morpho VaultV2Factory' } });
    expect(j.vaultPath).toBe(`/v/143/${MORPHO}`);
    const detected = eventJson(events[0]!, ctx, undefined, found);
    expect(detected.found).toBeNull();
    expect(detected.txUrl).toMatch(/^https:\/\/monadscan\.com\/tx\/0x/);
    const attested = eventJson(
      events.find((e) => e.kind === 'attested')!,
      ctx,
    );
    expect(attested.attestation!.txUrl).toMatch(/^https:\/\/testnet\.monadscan\.com\/tx\/0x/);
  });
});

describe('status', () => {
  it('behind the head in blocks and seconds, what runs now, and staleness', () => {
    const at = new Date(Date.parse(status!.updatedAt) + 10_000);
    const s = statusJson({
      chainId: 143,
      chains: [143],
      dir: '.specfirst/watch',
      status,
      problem: null,
      gasCostWei: null,
      ctx,
      found: countFound(143, vaults, ctx.meta, ctx.boardIds),
      feed: { available: true, problem: null, events: 33, latestSeq: 33, skipped: 2 },
      vaultsFile: { available: true, problem: null, skipped: 0 },
      now: at,
    });
    expect(s).toMatchObject({ running: true, behindBlocks: 30, behindSeconds: 12, stale: false, queueLength: 2, updatedAgoSec: 10 });
    expect(s.now).toMatchObject({ stage: 'checking', source: 'factory', forSec: 66 });
    expect(s.found).toEqual({ watched: 6, notOnList: 5, notOnBoard: 5, listSize: 1 });
    const later = statusJson({
      chainId: 143,
      chains: [],
      dir: 'd',
      status,
      problem: null,
      gasCostWei: 5n,
      ctx,
      found: s.found,
      feed: s.feed,
      vaultsFile: s.vaultsFile,
      now: new Date(Date.parse(status!.updatedAt) + 600_000),
    });
    expect(later.stale).toBe(true);
    expect(later.gasCostWei).toBe('5');
    const off = statusJson({
      chainId: 143,
      chains: [],
      dir: 'd',
      status: null,
      problem: 'not running',
      gasCostWei: null,
      ctx,
      found: s.found,
      feed: s.feed,
      vaultsFile: s.vaultsFile,
      now: at,
    });
    expect(off).toMatchObject({ running: false, problem: 'not running', behindBlocks: null, now: null, queue: [] });
  });
});

describe('feed pages', () => {
  it('newest first, with before and after cursors by seq', () => {
    const p = pageOf(events, { limit: 5 });
    expect(p.page.map((e) => e.seq)).toEqual([33, 32, 31, 30, 29]);
    expect(p).toMatchObject({ hasOlder: true, gap: false, latestSeq: 33 });
    expect(pageOf(events, { before: 29, limit: 3 }).page.map((e) => e.seq)).toEqual([28, 27, 26]);
    expect(pageOf(events, { after: 31, limit: 10 }).page.map((e) => e.seq)).toEqual([33, 32]);
    expect(pageOf(events, { after: 10, limit: 5 }).gap).toBe(true);
    expect(pageOf(events, { before: 1, limit: 5 })).toMatchObject({ page: [], hasOlder: false });
  });
});

describe('board overlay', () => {
  const board = [row('0xaaa', 'k1', { groupSize: 2 }), row('0xbbb', 'k1', { groupSize: 2 }), row('0xccc', 'k2')];

  it('adds vaults the board lacks once each, and recounts shared implementations', () => {
    const found = { sourceText: 'from Morpho VaultV2Factory', block: '1', at: '2026-10-06T09:00:00.000Z' };
    const overlay = [
      row('0xddd', 'k1', { found }),
      row('0xddd', 'k1', { found }),
      row('0xccc', 'k2', { found }),
      row('0xeee', 'k9', { found, protocol: 'Morpho Vault V2' }),
    ];
    const merged = mergeOverlay(board, overlay);
    expect(merged.map((r) => r.id)).toEqual(['143/0xaaa', '143/0xbbb', '143/0xccc', '143/0xddd', '143/0xeee']);
    expect(merged.map((r) => r.groupSize)).toEqual([3, 3, 1, 3, 1]);
    expect(merged[2]!.found).toBeUndefined();
    expect(merged[3]!.found).toEqual(found);
    expect(mergedProtocols(['Curvance'], overlay)).toEqual(['Curvance', 'Morpho Vault V2']);
    expect(filterRows(merged, { protocol: ALL, status: ALL, query: 'watcher' }).map((r) => r.id)).toEqual(['143/0xddd', '143/0xeee']);
  });

  it('no overlay leaves the board as it was', () => {
    expect(mergeOverlay(board, [])).toEqual(board);
  });
});

describe('inbox', () => {
  const SUB = '0x5ee0000000000000000000000000000000000001';
  const sec = (iso: string) => Date.parse(iso) / 1000;
  const firstAt = sec(events[0]!.at);
  const lastAt = sec(events[events.length - 1]!.at);

  it('active subscriptions get changes since they started, the first check after the start, and their own deliveries', () => {
    const subs = [
      {
        id: '2',
        subjectChainId: 143,
        subject: MORPHO.toUpperCase().replace('0X', '0x'),
        startsAtSec: sec(events[10]!.at),
        endsAtSec: lastAt + 86_400,
        cancelled: false,
      },
      { id: '3', subjectChainId: 143, subject: UPGRADED, startsAtSec: firstAt, endsAtSec: lastAt + 86_400, cancelled: false },
    ];
    const items = inboxEntries(subs, events, lastAt + 60);
    const morpho = items.filter((i) => i.subscriptionId === '2');
    expect(morpho.map((i) => i.kind)).toEqual(['delivery', 'change', 'first-check']);
    expect(morpho.find((i) => i.kind === 'change')!.event.change!.kind).toBe('changed');
    expect(morpho.find((i) => i.kind === 'first-check')!.event.source).toBe('first-deposit');
    const upgraded = items.filter((i) => i.subscriptionId === '3');
    expect(upgraded.map((i) => i.kind)).toEqual(['delivery', 'delivery', 'change', 'first-check']);
    expect(items.map((i) => i.event.seq)).toEqual([...items.map((i) => i.event.seq)].sort((a, b) => b - a));
  });

  it('cancelled and ended subscriptions get nothing; another subscription id is not a delivery of mine', () => {
    const base = { id: '9', subjectChainId: 143, subject: UPGRADED, startsAtSec: firstAt, endsAtSec: lastAt + 100, cancelled: false };
    expect(inboxEntries([{ ...base, cancelled: true }], events, lastAt)).toEqual([]);
    expect(inboxEntries([{ ...base, endsAtSec: lastAt - 1 }], events, lastAt)).toEqual([]);
    expect(inboxEntries([base], events, lastAt).filter((i) => i.kind === 'delivery')).toEqual([]);
    expect(inboxEntries([{ ...base, subjectChainId: 10143 }], events, lastAt)).toEqual([]);
  });
});
