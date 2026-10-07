import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  dropBpsOf,
  dropPercentText,
  exceedsDrop,
  feedEventSchema,
  priceMiss,
  priceScaleFor,
  priceStep,
  readSharePrice,
  webhookPayload,
  type PriceRules,
  type PriceTrack,
} from '../src/index.js';
import { addr } from './helpers/watchHarness.js';

const E18 = 10n ** 18n;
const V = addr(0x9a01);
const MIN = 60_000;
/** The watcher's defaults: 10 bps, confirmed 2 min and 10 blocks later, forgotten after an hour or 5 misses. */
const RULES: PriceRules = { thresholdBps: 10, confirmMs: 2 * MIN, confirmBlocks: 10, dropTtlMs: 60 * MIN, dropMaxMisses: 5 };

const read = (assetsPerShare: bigint, block: bigint, at = Number(block) * MIN, o: { decimals?: number; scale?: number } = {}) => ({
  assetsPerShare,
  block,
  at,
  shareDecimals: o.decimals ?? 18,
  scale: o.scale ?? 0,
});
const track = (assetsPerShare: bigint, block: bigint, o: Partial<PriceTrack> = {}): PriceTrack => ({
  decimals: 18,
  scale: 0,
  assetsPerShare,
  block,
  readAssetsPerShare: assetsPerShare,
  readBlock: block,
  ...o,
});
/** Applies reads in order; the step kinds and the last track. */
const run = (reads: Array<ReturnType<typeof read>>, rules = RULES) => {
  let t: PriceTrack | null = null;
  const kinds: string[] = [];
  let last: ReturnType<typeof priceStep> | null = null;
  for (const r of reads) {
    last = priceStep(t, r, rules);
    kinds.push(last.kind);
    t = last.next;
  }
  return { kinds, track: t!, last: last! };
};

describe('priceStep', () => {
  it('the first read is the reference', () => {
    expect(priceStep(null, read(E18, 100n), RULES)).toEqual({ kind: 'first', next: track(E18, 100n) });
  });

  it('a fall over the threshold is confirmed by a read at least 10 blocks and 2 minutes after it was first seen', () => {
    const low = (E18 * 9958n) / 10_000n;
    const pending = priceStep(track(E18, 100n), read(low, 110n, 0), RULES);
    expect(pending).toEqual({ kind: 'pending', next: track(E18, 100n, { readAssetsPerShare: low, readBlock: 110n, drop: { assetsPerShare: low, block: 110n, at: 0, misses: 0 } }) });
    // Review L1: a later block alone is not enough, during a catch-up that is one block and no time.
    expect(priceStep(pending.next, read(low, 111n, 0), RULES).kind).toBe('waiting');
    expect(priceStep(pending.next, read(low, 130n, MIN), RULES).kind).toBe('waiting');
    expect(priceStep(pending.next, read(low, 115n, 3 * MIN), RULES).kind).toBe('waiting');
    const confirmed = priceStep(pending.next, read((E18 * 9957n) / 10_000n, 120n, 2 * MIN), RULES);
    expect(confirmed).toEqual({
      kind: 'confirmed',
      next: track((E18 * 9957n) / 10_000n, 120n),
      change: { kind: 'price-drop', fromAssetsPerShare: E18.toString(), toAssetsPerShare: ((E18 * 9957n) / 10_000n).toString(), dropBps: 43, fromBlock: '100', toBlock: '120' },
      pendingBlock: 110n,
    });
  });

  it('review A2: a confirming read one block later is not accepted', () => {
    const p = priceStep(track(E18, 100n), read(E18 / 2n, 101n, 0), RULES);
    expect(priceStep(p.next, read(E18 / 2n, 102n, 0), RULES).kind).toBe('waiting');
  });

  it('review M1 and A: a one-read upward spike does not become the reference, so the return to normal is no drop', () => {
    const spike = run([read(E18, 100n), read((E18 * 101n) / 100n, 101n), read(E18, 102n), read(E18, 103n)]);
    expect(spike.kinds).toEqual(['first', 'rise', 'same', 'same']);
    expect(spike.track).toMatchObject({ assetsPerShare: E18, block: 103n });
  });

  it('a rise seen at two blocks becomes the reference: the lower of the two, at its own block', () => {
    expect(run([read(E18, 100n), read(E18 + 50n, 101n), read(E18 + 50n, 102n)]).track).toMatchObject({ assetsPerShare: E18 + 50n, block: 102n });
    expect(run([read(E18, 100n), read(E18 + 50n, 101n), read(E18 + 90n, 102n)]).track).toMatchObject({ assetsPerShare: E18 + 50n, block: 101n });
    // Accrual: the reference follows one read behind.
    expect(run([read(E18, 100n), read(E18 + 1n, 101n), read(E18 + 2n, 102n), read(E18 + 3n, 103n)]).track).toMatchObject({ assetsPerShare: E18 + 2n, block: 102n });
    // After a fall within the threshold, a rise never lowers the reference.
    expect(run([read(10_000n, 100n), read(9_995n, 101n), read(9_999n, 102n)]).track).toMatchObject({ assetsPerShare: 10_000n, block: 100n });
  });

  it('a fall within the threshold keeps the reference, so small falls add up', () => {
    const r = run([read(10_000n, 100n), read(9_995n, 110n), read(9_989n, 120n)]);
    expect(r.kinds).toEqual(['first', 'small-drop', 'pending']);
    expect(r.track.drop).toMatchObject({ assetsPerShare: 9_989n, block: 120n });
  });

  it('a pending fall that a later read does not bear out is cleared; one older than its lifetime is cleared as expired', () => {
    const pending = priceStep(track(E18, 100n), read(E18 / 2n, 110n, 0), RULES).next;
    expect(priceStep(pending, read(E18, 120n, MIN), RULES)).toEqual({
      kind: 'same',
      next: track(E18, 120n),
      cleared: { assetsPerShare: E18 / 2n, block: 110n, expired: false },
    });
    // Still low, but an hour and more after the first sighting: a fresh pending fall, not a confirmation.
    const late = priceStep(pending, read(E18 / 2n, 500n, 61 * MIN), RULES);
    expect(late).toMatchObject({ kind: 'pending', cleared: { block: 110n, expired: true }, next: { drop: { block: 500n, at: 61 * MIN } } });
  });

  it('a read at a block not after the last one is stale; other decimals or another scale reset the reference', () => {
    const pending = priceStep(track(E18, 100n), read(E18 / 2n, 110n, 0), RULES).next;
    expect(priceStep(pending, read(E18 / 2n, 110n, 5 * MIN), RULES)).toEqual({ kind: 'stale', next: pending });
    expect(priceStep(pending, read(1_000_000n, 130n, 5 * MIN, { decimals: 6 }), RULES)).toEqual({ kind: 'reset', next: { ...track(1_000_000n, 130n), decimals: 6 } });
    expect(priceStep(pending, read(50_000n, 130n, 5 * MIN, { scale: 2 }), RULES).kind).toBe('reset');
  });

  it('review M3a: reads without a value count as misses; the fall is forgotten after five, or after its lifetime', () => {
    let t = priceStep(track(E18, 100n), read(E18 / 2n, 110n, 0), RULES).next;
    for (let i = 1; i <= 4; i++) {
      const m = priceMiss(t, i * MIN, RULES);
      expect(m.forgotten).toBe(false);
      expect(m.next.drop!.misses).toBe(i);
      t = m.next;
    }
    const fifth = priceMiss(t, 5 * MIN, RULES);
    expect(fifth.forgotten).toBe(true);
    expect(fifth.next.drop).toBeUndefined();
    expect(fifth.next.assetsPerShare).toBe(E18);
    const old = priceStep(track(E18, 100n), read(E18 / 2n, 110n, 0), RULES).next;
    expect(priceMiss(old, 61 * MIN, RULES).forgotten).toBe(true);
    expect(priceMiss(track(E18, 100n), 0, RULES)).toEqual({ next: track(E18, 100n), forgotten: false });
  });

  it('the change carries the scale when the values are for 10 ** scale shares', () => {
    const scaled = run([read(50_000n, 100n, 0, { scale: 2 }), read(40_000n, 110n, 0, { scale: 2 }), read(40_000n, 120n, 2 * MIN, { scale: 2 })]);
    expect(scaled.last).toMatchObject({ kind: 'confirmed', change: { dropBps: 2_000, scale: 2 } });
  });

  it('measures exactly; the reported drop rounds down; the scale reaches 10,000 base units', () => {
    expect(exceedsDrop(10_000n, 9_990n, 10)).toBe(false);
    expect(exceedsDrop(100_000n, 99_899n, 10)).toBe(true);
    expect(exceedsDrop(10_000n, 10_001n, 10)).toBe(false);
    expect(exceedsDrop(0n, 0n, 0)).toBe(false);
    expect(dropBpsOf(100_000n, 99_899n)).toBe(10);
    expect(dropBpsOf(E18, 0n)).toBe(10_000);
    expect(dropBpsOf(0n, 0n)).toBe(0);
    expect(dropBpsOf(5n, 7n)).toBe(0);
    expect(dropPercentText(42)).toBe('0.42%');
    expect(dropPercentText(10_000)).toBe('100.00%');
    expect([10_000n, 9_999n, 999n, 100n, 1n, 0n].map(priceScaleFor)).toEqual([0, 1, 2, 2, 4, null]);
  });
});

describe('readSharePrice with a stand-in client', () => {
  type Call = { functionName: string; args?: readonly bigint[]; blockNumber: bigint };
  const revert = () => Object.assign(new Error('The contract function "convertToAssets" reverted.'), { name: 'ContractFunctionRevertedError' });
  const transport = () => Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 502 });
  /** A vault: decimals, supply, and convertToAssets by the number of shares asked for. */
  const client = (v: { decimals?: number | Error; supply?: bigint | Error; assets: (shares: bigint) => bigint | Error }) => {
    const calls: Call[] = [];
    const answer = (c: Call): unknown => (c.functionName === 'decimals' ? (v.decimals ?? 18) : c.functionName === 'totalSupply' ? (v.supply ?? 5n) : v.assets(c.args![0]!));
    return {
      calls,
      readContract: (async (c: Call) => {
        calls.push(c);
        const a = answer(c);
        if (a instanceof Error) throw a;
        return a;
      }) as never,
      multicalls: [] as Call[][],
      answer,
    };
  };

  it('a new track: decimals() first, then totalSupply() and convertToAssets of one whole share, all at the block', async () => {
    const c = client({ decimals: 6, assets: () => 1_004_200n });
    expect(await readSharePrice(c, V, 1234n)).toEqual({ ok: true, assetsPerShare: 1_004_200n, shareDecimals: 6, scale: 0 });
    expect(c.calls.map((x) => x.functionName)).toEqual(['decimals', 'totalSupply', 'convertToAssets']);
    expect(c.calls[2]).toMatchObject({ args: [1_000_000n], blockNumber: 1234n });
    expect(c.calls.every((x) => x.blockNumber === 1234n)).toBe(true);
  });

  it('review M3c: a known track sends one batch with its decimals and scale, and decimals() is still checked', async () => {
    const c = client({ decimals: 18, assets: (s) => s / 1_000n });
    expect(await readSharePrice(c, V, 9n, { known: { decimals: 18, scale: 2 } })).toEqual({ ok: true, assetsPerShare: 10n ** 17n, shareDecimals: 18, scale: 2 });
    expect(c.calls.map((x) => [x.functionName, x.args?.[0]])).toEqual([
      ['decimals', undefined],
      ['totalSupply', undefined],
      ['convertToAssets', 10n ** 20n],
    ]);
    // decimals() moved: read again as a new track, the new decimals and scale come back (priceStep resets on them).
    const moved = client({ decimals: 6, assets: () => 1_000_000n });
    expect(await readSharePrice(moved, V, 9n, { known: { decimals: 18, scale: 0 } })).toEqual({ ok: true, assetsPerShare: 1_000_000n, shareDecimals: 6, scale: 0 });
  });

  it('review L3: a share worth fewer than 10,000 base units is valued for 10 ** scale shares; when that fails, low resolution', async () => {
    const small = client({ decimals: 18, assets: (s) => (s * 999n) / E18 });
    expect(await readSharePrice(small, V, 1n)).toEqual({ ok: true, assetsPerShare: 99_900n, shareDecimals: 18, scale: 2 });
    expect(small.calls.at(-1)).toMatchObject({ functionName: 'convertToAssets', args: [10n ** 20n] });
    const capped = client({ decimals: 18, assets: (s) => (s === E18 ? 999n : revert()) });
    expect(await readSharePrice(capped, V, 1n)).toMatchObject({ ok: false, lowResolution: true, reason: expect.stringMatching(/^one share is worth 999 base units at block 1, under 10000, and convertToAssets of 10 \*\* 2 shares failed/) });
    const drained = client({ decimals: 18, assets: () => 0n });
    expect(await readSharePrice(drained, V, 1n)).toMatchObject({ ok: false, lowResolution: true, reason: expect.stringMatching(/no scale up to 10 \*\* 6 shares/) });
    // A known track keeps its scale whatever the value: a fall below 10,000 units is still compared.
    expect(await readSharePrice(small, V, 1n, { known: { decimals: 18, scale: 0 } })).toEqual({ ok: true, assetsPerShare: 999n, shareDecimals: 18, scale: 0 });
  });

  it('a revert or no share at all gives no value; an RPC failure is thrown', async () => {
    expect(await readSharePrice(client({ assets: () => revert() }), V, 1n)).toMatchObject({ ok: false, reason: expect.stringMatching(/^convertToAssets\(\) at block 1: revert/) });
    expect(await readSharePrice(client({ supply: 0n, assets: () => E18 }), V, 1n)).toEqual({ ok: false, reason: 'totalSupply() is 0 at block 1: no share to value' });
    expect(await readSharePrice(client({ decimals: 200, assets: () => E18 }), V, 1n)).toMatchObject({ ok: false, reason: expect.stringMatching(/decimals\(\) is 200/) });
    await expect(readSharePrice(client({ assets: () => transport() }), V, 1n)).rejects.toThrow(/HTTP request failed/);
  });

  it('with Multicall3, a batch is one multicall; a call that failed inside it is the contract answering, a failed multicall is thrown', async () => {
    const c = client({ assets: () => 2n * E18 });
    const mc = Object.assign(c, {
      multicall: (async (m: { contracts: Array<{ functionName: string; args?: readonly bigint[] }>; blockNumber: bigint; multicallAddress: Address }) => {
        c.multicalls.push(m.contracts.map((x) => ({ functionName: x.functionName, ...(x.args ? { args: x.args } : {}), blockNumber: m.blockNumber })));
        return m.contracts.map((x) => {
          const a = c.answer({ functionName: x.functionName, ...(x.args ? { args: x.args } : {}), blockNumber: m.blockNumber });
          return a instanceof Error ? { status: 'failure', error: a } : { status: 'success', result: a };
        });
      }) as never,
    });
    const at = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
    expect(await readSharePrice(mc, V, 7n, { known: { decimals: 18, scale: 0 }, multicall: at })).toEqual({ ok: true, assetsPerShare: 2n * E18, shareDecimals: 18, scale: 0 });
    expect(c.multicalls).toHaveLength(1);
    expect(c.calls).toHaveLength(0);
    const failing = Object.assign(client({ assets: () => revert() }), { multicall: async () => [{ status: 'success', result: 18 }, { status: 'success', result: 5n }, { status: 'failure', error: revert() }] });
    expect(await readSharePrice(failing as never, V, 7n, { known: { decimals: 18, scale: 0 }, multicall: at })).toMatchObject({ ok: false, reason: expect.stringMatching(/^convertToAssets\(\)/) });
    const down = Object.assign(client({ assets: () => E18 }), { multicall: async () => Promise.reject(transport()) });
    await expect(readSharePrice(down as never, V, 7n, { known: { decimals: 18, scale: 0 }, multicall: at })).rejects.toThrow(/HTTP request failed/);
  });
});

describe('the price-drop change in the feed and the webhook payload', () => {
  const subject = '0xFEeD000000000000000000000000000000000001' as Address;
  const change = { kind: 'price-drop', fromAssetsPerShare: '1000000000000000000', toAssetsPerShare: '995800000000000000', dropBps: 42, fromBlock: '1990', toBlock: '2010' };
  const event = { v: 1, seq: 9, at: '2026-10-07T00:00:00.000Z', kind: 'changed', chainId: 143, subject, source: 'price-drop', block: '2010', change } as const;

  it('feed.ndjson accepts the price-drop shape (with an optional scale) and nothing that mixes it with a check change', () => {
    expect(feedEventSchema.parse(event).change).toEqual(change);
    expect(feedEventSchema.parse({ ...event, change: { ...change, scale: 2 } }).change).toMatchObject({ scale: 2 });
    const bad: Array<[string, unknown]> = [
      ['from and to on a price-drop', { ...change, from: null, to: { summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [] } }],
      ['no dropBps', { ...change, dropBps: undefined }],
      ['dropBps as a string', { ...change, dropBps: '42' }],
      ['dropBps over 100%', { ...change, dropBps: 10_001 }],
      ['a value with decimals', { ...change, toAssetsPerShare: '0.99' }],
      ['a negative value', { ...change, toAssetsPerShare: '-1' }],
      ['a block as a number', { ...change, toBlock: 2010 }],
      ['a scale of 0 (it is left out)', { ...change, scale: 0 }],
      ['a scale over 6', { ...change, scale: 7 }],
      ['a check kind with the price-drop fields', { ...change, kind: 'changed' }],
    ];
    for (const [why, c] of bad) expect(feedEventSchema.safeParse({ ...event, change: c }).success, why).toBe(false);
  });

  it('review L2: the webhook payload is kind price-drop with the numbers in change and an idempotency key from the reference block', () => {
    expect(webhookPayload(feedEventSchema.parse(event), [4n, 2n], 'https://example.org/checks')).toEqual({
      v: 1,
      kind: 'price-drop',
      key: `price-drop:143:${subject.toLowerCase()}:1990`,
      subscriptionId: '2',
      subscriptionIds: ['2', '4'],
      subject,
      chainId: 143,
      change,
      check: null,
      attestation: null,
      reportURL: null,
    });
    // The same drop confirmed again later (after a restart) measures from the same reference: the same key.
    const again = feedEventSchema.parse({ ...event, seq: 12, block: '2050', change: { ...change, toBlock: '2050' } });
    expect(webhookPayload(again, [2n]).key).toBe(webhookPayload(feedEventSchema.parse(event), [2n]).key);
  });
});
