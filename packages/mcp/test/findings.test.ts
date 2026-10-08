import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/api.js';
import { recentFindings } from '../src/findings.js';
import { fixture, NOW } from './helpers.js';
import { deadUrl, startMockApi, type Running } from './mocks.js';

type Feed = { events: Array<Record<string, unknown> & { seq: number }> } & Record<string, unknown>;

let api: Running;
beforeAll(async () => {
  api = await startMockApi();
});
afterAll(() => api.close());

describe('recent_findings', () => {
  it('lists changes newest first, leaves out first checks that found nothing, and the current mismatches', async () => {
    const f = await recentFindings({ api: createApi({ base: api.url, timeoutMs: 3000 }), now: () => NOW }, 143, 10);
    expect(f.changes.map((c) => [c.seq, c.kind])).toEqual([
      [1031, 'regressed'],
      [1030, 'price-drop'],
      [1029, 'changed'],
    ]);
    const [reg, drop, changed] = f.changes;
    expect(reg!.text).toBe(
      '"Synthetic regressed vault" 0x2222..2222: regressed from partly checked (26 pass, 4 inconclusive, 0 not applicable) to mismatch (MUST: previewDeposit, previewMint, previewWithdraw, previewRedeem) at block 111484100. Attested as #28.',
    );
    // The transaction link is rebuilt from the hash, not taken from the feed.
    expect(reg!.attestation).toEqual({ id: '28', txUrl: `https://testnet.monadscan.com/tx/0x${'ab'.repeat(32)}` });
    expect(reg!.vault.page).toBe(`${api.url}/v/143/0x2222222222222222222222222222222222222222`);
    expect(reg!.reportUrl).toBe(`${api.url}/api/v1/reports/143/0x2222222222222222222222222222222222222222/111484100-0123456789abcdef.json`);
    expect(drop!.priceDrop).toEqual({ fromAssetsPerShare: '1004200', toAssetsPerShare: '999984', dropBps: 41, fromBlock: '111483000', toBlock: '111483400' });
    expect(drop!.text).toContain('share value fell 0.41% between block 111483000 and block 111483400');
    expect(changed!.text).toContain('"Steakhouse High Yield USD1" (Morpho Vault V2)');
    expect(changed!.text).toContain('result changed from partly checked (0 pass, 28 inconclusive, 2 not applicable) to partly checked (26 pass, 0 inconclusive, 4 not applicable)');

    expect(f.currentMismatches.map((m) => [m.vault.address, m.level, m.failed, m.pending])).toEqual([
      ['0x2222222222222222222222222222222222222222', 'must', ['previewDeposit', 'previewMint', 'previewWithdraw', 'previewRedeem'], false],
      ['0xf26dC2F1FE883b11Dd56700db594DfC32Eee95Bf', 'must', ['sf-maxDeposit-honored', 'sf-maxMint-honored'], false],
    ]);
    expect(f.watcher).toMatchObject({ running: true, stale: false });
    expect(f.scanned).toMatchObject({ events: 5, latestSeq: 1031, oldestSeq: 981, reachedStart: true });
    expect(f.problems).toEqual([]);
  });

  it('keeps to the limit for both lists', async () => {
    const f = await recentFindings({ api: createApi({ base: api.url, timeoutMs: 3000 }) }, 143, 1);
    expect(f.changes).toHaveLength(1);
    expect(f.currentMismatches).toHaveLength(1);
  });

  it('pages back through the feed up to 1,000 events', async () => {
    const base = fixture('api/feed-page.json') as Feed;
    const template = base.events.find((e) => e.seq === 981)!;
    const events = Array.from({ length: 1500 }, (_, i) => ({ ...template, seq: 2000 - i }));
    const big = await startMockApi({ feed: { ...base, events, latestSeq: 2000 } });
    try {
      const f = await recentFindings({ api: createApi({ base: big.url, timeoutMs: 3000 }) }, 143, 5);
      expect(f.scanned).toMatchObject({ events: 1000, latestSeq: 2000, oldestSeq: 1001, reachedStart: false });
      expect(big.requests.filter((r) => r.startsWith('GET /api/v1/watch/feed'))).toHaveLength(10);
      // One subject, seen a thousand times: listed once, from its newest check.
      expect(f.currentMismatches).toHaveLength(1);
    } finally {
      await big.close();
    }
  });

  it('says so when the feed or the API cannot be read', async () => {
    const off = await startMockApi({ feed: { chainId: 10143, available: false, problem: 'not running', events: [], latestSeq: null, hasOlder: false } });
    try {
      const f = await recentFindings({ api: createApi({ base: off.url, timeoutMs: 3000 }) }, 10143, 5);
      expect(f.problems).toEqual(['The watcher feed for chain 10143 is not available: not running.']);
      expect(f.changes).toEqual([]);
    } finally {
      await off.close();
    }
    const down = await recentFindings({ api: createApi({ base: await deadUrl(), timeoutMs: 3000 }) }, 143, 5);
    expect(down.watcher).toBeNull();
    expect(down.problems).toHaveLength(2);
    expect(down.problems.join(' ')).toContain('did not answer');
  });
});
