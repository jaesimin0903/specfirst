import type { Address } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dropBpsOf,
  dropPercentText,
  exceedsDrop,
  feedEventSchema,
  priceStep,
  readSharePrice,
  webhookPayload,
  type ActiveSubscription,
  type AlertSink,
  type FeedEvent,
  type PriceTrack,
  type SharePriceRead,
  type WatchEvent,
} from '../src/index.js';
import { addr, attestParams, cleanupHarnesses, ERC4626, harness, kinds, reportOf, T0, type Harness } from './helpers/watchHarness.js';

afterEach(cleanupHarnesses);

const E18 = 10n ** 18n;
const V = addr(0x9a01);
const W = addr(0x9a02);
const X = addr(0x9a03);

describe('priceStep', () => {
  const read = (assetsPerShare: bigint, block: bigint, shareDecimals = 18) => ({ assetsPerShare, block, shareDecimals });
  const track = (assetsPerShare: bigint, block: bigint, o: Partial<PriceTrack> = {}): PriceTrack => ({ decimals: 18, assetsPerShare, block, readBlock: block, ...o });

  it('the first read is the reference', () => {
    expect(priceStep(null, read(E18, 100n), 10)).toEqual({ kind: 'first', next: track(E18, 100n) });
  });

  it('a fall over the threshold waits for a read at a later block, which confirms it with both values and blocks', () => {
    const pending = priceStep(track(E18, 100n), read((E18 * 9958n) / 10_000n, 110n), 10);
    expect(pending).toEqual({ kind: 'pending', next: { ...track(E18, 100n, { readBlock: 110n }), drop: { assetsPerShare: (E18 * 9958n) / 10_000n, block: 110n } } });
    const confirmed = priceStep(pending.next, read((E18 * 9957n) / 10_000n, 120n), 10);
    expect(confirmed).toEqual({
      kind: 'confirmed',
      next: track((E18 * 9957n) / 10_000n, 120n),
      change: { kind: 'price-drop', fromAssetsPerShare: E18.toString(), toAssetsPerShare: ((E18 * 9957n) / 10_000n).toString(), dropBps: 43, fromBlock: '100', toBlock: '120' },
      pendingBlock: 110n,
    });
  });

  it('a fall within the threshold keeps the reference, so small falls add up', () => {
    const one = priceStep(track(10_000n, 100n), read(9_995n, 110n), 10);
    expect(one).toEqual({ kind: 'small-drop', next: track(10_000n, 100n, { readBlock: 110n }) });
    const two = priceStep(one.next, read(9_989n, 120n), 10);
    expect(two.kind).toBe('pending');
    expect(two.next.drop).toEqual({ assetsPerShare: 9_989n, block: 120n });
  });

  it('a rise moves the reference silently; an unchanged value moves only its block', () => {
    expect(priceStep(track(E18, 100n), read(E18 + 5n, 110n), 10)).toEqual({ kind: 'rise', next: track(E18 + 5n, 110n) });
    expect(priceStep(track(E18, 100n), read(E18, 110n), 10)).toEqual({ kind: 'same', next: track(E18, 110n) });
  });

  it('a pending fall that a later read does not bear out is cleared (a one-block glitch), and nothing is confirmed', () => {
    const pending = priceStep(track(E18, 100n), read(E18 / 2n, 110n), 10).next;
    const back = priceStep(pending, read(E18, 120n), 10);
    expect(back).toEqual({ kind: 'same', next: track(E18, 120n), cleared: { assetsPerShare: E18 / 2n, block: 110n } });
    const small = priceStep(pending, read(E18 - 1n, 120n), 10);
    expect(small).toEqual({ kind: 'small-drop', next: track(E18, 100n, { readBlock: 120n }), cleared: { assetsPerShare: E18 / 2n, block: 110n } });
  });

  it('a read at a block not after the last one is stale: a fall is not confirmed at the block it was seen', () => {
    const pending = priceStep(track(E18, 100n), read(E18 / 2n, 110n), 10).next;
    expect(priceStep(pending, read(E18 / 2n, 110n), 10)).toEqual({ kind: 'stale', next: pending });
    expect(priceStep(track(E18, 100n), read(1n, 90n), 10)).toEqual({ kind: 'stale', next: track(E18, 100n) });
  });

  it('other share decimals make the read a new reference and forget a pending fall', () => {
    const pending = priceStep(track(E18, 100n), read(E18 / 2n, 110n), 10).next;
    expect(priceStep(pending, read(1_000_000n, 120n, 6), 10)).toEqual({ kind: 'decimals', next: { decimals: 6, assetsPerShare: 1_000_000n, block: 120n, readBlock: 120n } });
  });

  it('measures exactly: 10 bps is not over a threshold of 10, 10.01 is; the reported drop rounds down', () => {
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
  });
});

describe('readSharePrice', () => {
  type Call = { functionName: string; args?: readonly bigint[]; blockNumber: bigint };
  const client = (answer: (c: Call) => unknown) => {
    const calls: Call[] = [];
    return {
      calls,
      readContract: (async (c: Call) => {
        calls.push(c);
        const a = answer(c);
        if (a instanceof Error) throw a;
        return a;
      }) as never,
    };
  };
  const revert = () => Object.assign(new Error('The contract function "convertToAssets" reverted.'), { name: 'ContractFunctionRevertedError' });
  /** viem files a JSON-RPC -32603 under a revert whatever the node said (rpc1's "Error getting block by number"). */
  const nodeError = () =>
    Object.assign(new Error('The contract function "convertToAssets" reverted.'), {
      name: 'ContractFunctionExecutionError',
      cause: Object.assign(new Error('Error getting block by number'), { name: 'ContractFunctionRevertedError', cause: { code: -32603, message: 'Error getting block by number' } }),
    });
  const transport = () => Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 502 });

  it('reads decimals(), then totalSupply() and convertToAssets of one whole share, all at the block', async () => {
    const c = client((x) => (x.functionName === 'decimals' ? 6 : x.functionName === 'totalSupply' ? 5n : 1_004_200n));
    expect(await readSharePrice(c, V, 1234n)).toEqual({ ok: true, assetsPerShare: 1_004_200n, shareDecimals: 6 });
    expect(c.calls.find((x) => x.functionName === 'convertToAssets')).toMatchObject({ args: [1_000_000n], blockNumber: 1234n });
    expect(c.calls.every((x) => x.blockNumber === 1234n)).toBe(true);
  });

  it('a revert or no share at all gives no value; nothing to record', async () => {
    const reverted = await readSharePrice(client((x) => (x.functionName === 'convertToAssets' ? revert() : x.functionName === 'decimals' ? 18 : 1n)), V, 1n);
    expect(reverted).toMatchObject({ ok: false, reason: expect.stringMatching(/^convertToAssets\(\) at block 1: revert/) });
    const empty = await readSharePrice(client((x) => (x.functionName === 'decimals' ? 18 : x.functionName === 'totalSupply' ? 0n : E18)), V, 1n);
    expect(empty).toEqual({ ok: false, reason: 'totalSupply() is 0 at block 1: no share to value' });
    const huge = await readSharePrice(client(() => 200), V, 1n);
    expect(huge).toMatchObject({ ok: false, reason: expect.stringMatching(/decimals\(\) is 200/) });
  });

  it('an RPC failure is thrown, never a value: a transport failure, and a node error viem files as a revert', async () => {
    await expect(readSharePrice(client((x) => (x.functionName === 'decimals' ? 18 : x.functionName === 'totalSupply' ? 1n : transport())), V, 1n)).rejects.toThrow(/HTTP request failed/);
    await expect(readSharePrice(client((x) => (x.functionName === 'decimals' ? 18 : x.functionName === 'totalSupply' ? 1n : nodeError())), V, 1n)).rejects.toThrow(/reverted/);
  });
});

/** The harness with a share value per subject: a bigint, 'rpc' (a transport failure) or 'empty' (totalSupply 0). */
function withPrices(h: Harness) {
  const prices = new Map<string, bigint | 'rpc' | 'empty'>();
  const reads: Array<{ subject: Address; block: bigint }> = [];
  h.effects.sharePrice = async (subject, block): Promise<SharePriceRead> => {
    reads.push({ subject, block });
    const p = prices.get(subject.toLowerCase());
    if (p === undefined) return { ok: false, reason: 'no such vault' };
    if (p === 'rpc') throw Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 503 });
    if (p === 'empty') return { ok: false, reason: `totalSupply() is 0 at block ${block}: no share to value` };
    return { ok: true, assetsPerShare: p, shareDecimals: 18 };
  };
  return { prices, reads };
}

/** A vault the watcher checked at block 100 (outcome as reportOf), with a Valid attestation of that outcome when `attested`. */
function known(h: Harness, subject: Address, attested: boolean): void {
  h.store.vaults.vaults[subject.toLowerCase()] = {
    firstSeen: { source: 'backfill', block: '100', at: '2026-10-01T00:00:00.000Z' },
    deployBlock: null,
    lastCheck: { block: '100', at: T0.toISOString(), reportPath: 'certs/checks/x.json', summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [], implementationKey: reportOf(subject, 1n).identity.implementationKey as `0x${string}` },
    lastAttestationId: attested ? String(h.registry.list.length) : null,
    firstDepositBlock: null,
  };
  if (attested) h.registry.attest(attestParams(subject, 100n));
}

const later = (h: Harness, ms: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + ms);
};
const priceEvents = (h: Harness) => h.events.filter((e): e is Extract<WatchEvent, { type: 'watch-price' }> => e.type === 'watch-price');

describe('the watcher follows the share value', { timeout: 60_000 }, () => {
  it('an attested vault: a fall over the threshold waits for a later block, then one changed event and a re-check that attests nothing', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher();
    await w.pass();
    expect(reads).toEqual([{ subject: V, block: 1990n }]);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ decimals: 18, assetsPerShare: E18.toString(), block: '1990', readBlock: '1990' });
    expect(await h.feed()).toEqual([]);

    // Not subscribed: read again only after --price-minutes.
    prices.set(V.toLowerCase(), (E18 * 9958n) / 10_000n);
    h.chain.head = 2010n;
    await w.pass();
    expect(reads).toHaveLength(1);
    later(h, 5 * 60_000);
    await w.pass();
    expect(reads).toHaveLength(2);
    expect(priceEvents(h)).toEqual([
      { type: 'watch-price', subject: V, step: 'pending', block: '2000', assetsPerShare: '995800000000000000', referenceAssetsPerShare: E18.toString(), dropBps: 42 },
    ]);
    expect(await h.feed()).toEqual([]);

    // The second read comes at the next pass with a later block, whatever the cadence.
    h.chain.head = 2020n;
    await w.pass();
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['changed:price-drop', 'queued:price-drop', 'checked:price-drop']);
    expect(feed[0]).toMatchObject({
      subject: V,
      block: '2010',
      change: { kind: 'price-drop', fromAssetsPerShare: E18.toString(), toAssetsPerShare: '995800000000000000', dropBps: 42, fromBlock: '1990', toBlock: '2010' },
      reason: 'confirmed by a second read at block 2010 after block 2000',
    });
    expect(feed[0]!.check).toBeUndefined();
    expect(feed[0]!.attestation).toBeUndefined();
    expect(feed[1]).toMatchObject({ block: '2010', reason: 'share value fell 0.42% between block 1990 and block 2010' });
    expect(feed[2]!.reason).toBe('not attested [unchanged]: unchanged since attestation 0');
    expect(h.registry.list).toHaveLength(1);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ assetsPerShare: '995800000000000000', block: '2010' });
    expect(h.store.state.prices[V.toLowerCase()]!.drop).toBeUndefined();
    expect(w.status().counts.changed24h).toBe(1);
  });

  it('a subscribed vault is read at every pass with a new block; its subscribers get the drop, which is not their first check', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    const delivered: Array<{ event: FeedEvent; subs: string[] }> = [];
    const sink: AlertSink = {
      deliver: async (event, subs) => {
        delivered.push({ event, subs: subs.map((s) => s.id.toString()) });
        return subs.map((s) => ({ ...event, v: 1, seq: 0, kind: 'alerted', alert: { subscriptionId: s.id.toString(), subscriber: s.subscriber, channel: 'webhook', ok: true, status: 204 } }));
      },
    };
    const sub: ActiveSubscription = { id: 3n, subscriber: addr(0x5b), subjectChainId: 143n, subject: W, standardId: ERC4626, startsAt: 0n, endsAt: 10n ** 12n };
    known(h, W, true);
    prices.set(W.toLowerCase(), 2n * E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ subscribedMinutes: 600 }, { subscriptions: { active: async () => [sub] }, alerts: sink });
    await w.pass();
    h.chain.head = 2001n;
    await w.pass();
    // Same head: nothing new to read.
    await w.pass();
    expect(reads.map((r) => r.block)).toEqual([1990n, 1991n]);
    expect(h.store.state.prices[W.toLowerCase()]!.block).toBe('1991');

    prices.set(W.toLowerCase(), E18);
    h.chain.head = 2002n;
    await w.pass();
    h.chain.head = 2003n;
    await w.pass();
    const feed = await h.feed();
    // The drop, its delivery, the re-check; that re-check is the subscription's first check and is delivered as one.
    expect(kinds(feed)).toEqual(['changed:price-drop', 'alerted:price-drop', 'queued:price-drop', 'checked:price-drop', 'alerted:price-drop']);
    expect(delivered.map((d) => [d.event.kind, d.subs])).toEqual([
      ['changed', ['3']],
      ['checked', ['3']],
    ]);
    expect(delivered[0]!.event).toMatchObject({ seq: feed[0]!.seq, change: { kind: 'price-drop', dropBps: 5_000, fromBlock: '1991', toBlock: '1993' } });
    expect(feed[1]).toMatchObject({ seq: feed[0]!.seq + 1, alert: { subscriptionId: '3', ok: true } });
    expect(feed[3]!.reason).toBe('not attested [unchanged]: unchanged since attestation 0');
    expect(h.registry.list).toHaveLength(1);
  });

  it('an RPC failure is never a drop and a vault without a value records nothing; a pending fall waits for a real read', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1 });
    await w.pass();
    const reference = { ...h.store.state.prices[V.toLowerCase()]! };

    const step = async (p: bigint | 'rpc' | 'empty', head: bigint) => {
      prices.set(V.toLowerCase(), p);
      h.chain.head = head;
      later(h, 60_000);
      await w.pass();
    };
    await step('rpc', 2010n);
    expect(h.events.filter((e) => e.type === 'watch-error' && e.step === 'price').map((e) => (e as { error: string }).error)).toEqual([
      `${V}: share value not read at block 2000, not a verdict: transport failure: HTTP request failed.`,
    ]);
    await step('empty', 2020n);
    expect(priceEvents(h).map((e) => [e.step, e.reason])).toEqual([['skipped', 'totalSupply() is 0 at block 2010: no share to value']]);
    expect(h.store.state.prices[V.toLowerCase()]).toEqual(reference);

    await step(E18 / 2n, 2030n);
    expect(h.store.state.prices[V.toLowerCase()]!.drop).toMatchObject({ block: '2020' });
    await step('rpc', 2040n);
    await step('empty', 2050n);
    expect(h.store.state.prices[V.toLowerCase()]!.drop).toMatchObject({ block: '2020' });
    expect(await h.feed()).toEqual([]);
    await step(E18 / 2n, 2060n);
    expect(kinds(await h.feed()).slice(0, 2)).toEqual(['changed:price-drop', 'queued:price-drop']);
    expect((await h.feed())[0]!.change).toMatchObject({ fromBlock: '1990', toBlock: '2050', dropBps: 5_000 });
    expect(reads.length).toBe(7);
  });

  it('a one-block glitch is cleared without a feed line; a rise moves the reference silently', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1 });
    await w.pass();
    for (const [p, head] of [
      [E18 / 10n, 2010n],
      [E18, 2020n],
      [E18 + 7n, 2030n],
    ] as const) {
      prices.set(V.toLowerCase(), p);
      h.chain.head = head;
      later(h, 60_000);
      await w.pass();
    }
    expect(priceEvents(h).map((e) => e.step)).toEqual(['pending', 'cleared']);
    expect(await h.feed()).toEqual([]);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ assetsPerShare: (E18 + 7n).toString(), block: '2020' });
  });

  it('nobody subscribed and nobody attested: not followed unless --price-all, then within the reads per minute, longest unread first', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    for (const s of [V, W, X]) {
      known(h, s, false);
      prices.set(s.toLowerCase(), E18);
    }
    h.store.state.cursor = '1991';
    await h.watcher().pass();
    expect(reads).toEqual([]);

    const w = h.watcher({ priceAll: true, maxPriceReadsPerMinute: 2 });
    await w.pass();
    expect(reads.map((r) => r.subject)).toEqual([V, W]);
    h.chain.head = 2010n;
    later(h, 30_000);
    await w.pass();
    expect(reads).toHaveLength(2);
    later(h, 31_000);
    await w.pass();
    expect(reads.map((r) => r.subject)).toEqual([V, W, X]);

    // Followed no more: the tracks are forgotten, so a later subscription starts from a fresh reference.
    await h.watcher().pass();
    expect(h.store.state.prices).toEqual({});
  });

  it('without the effect, or with --price-minutes 0, nothing is read', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    await h.watcher({ priceMinutes: 0 }).pass();
    expect(reads).toEqual([]);
    delete h.effects.sharePrice;
    await h.watcher().pass();
    expect(h.store.state.prices).toEqual({});
  });
});

describe('the price-drop change in the feed and the webhook payload', () => {
  const subject = '0xFEeD000000000000000000000000000000000001' as Address;
  const change = { kind: 'price-drop', fromAssetsPerShare: '1000000000000000000', toAssetsPerShare: '995800000000000000', dropBps: 42, fromBlock: '1990', toBlock: '2010' };
  const event = { v: 1, seq: 9, at: '2026-10-07T00:00:00.000Z', kind: 'changed', chainId: 143, subject, source: 'price-drop', block: '2010', change } as const;

  it('feed.ndjson accepts the price-drop shape and nothing that mixes it with a check change', () => {
    expect(feedEventSchema.parse(event).change).toEqual(change);
    const bad: Array<[string, unknown]> = [
      ['from and to on a price-drop', { ...change, from: null, to: { summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [] } }],
      ['no dropBps', { ...change, dropBps: undefined }],
      ['dropBps as a string', { ...change, dropBps: '42' }],
      ['dropBps over 100%', { ...change, dropBps: 10_001 }],
      ['a value with decimals', { ...change, toAssetsPerShare: '0.99' }],
      ['a negative value', { ...change, toAssetsPerShare: '-1' }],
      ['a block as a number', { ...change, toBlock: 2010 }],
      ['a check kind with the price-drop fields', { ...change, kind: 'changed' }],
    ];
    for (const [why, c] of bad) expect(feedEventSchema.safeParse({ ...event, change: c }).success, why).toBe(false);
  });

  it('the webhook payload is kind price-drop with the numbers in change, no check, attestation or report', () => {
    expect(webhookPayload(feedEventSchema.parse(event), [4n, 2n], 'https://example.org/checks')).toEqual({
      v: 1,
      kind: 'price-drop',
      subscriptionId: '2',
      subscriptionIds: ['2', '4'],
      subject,
      chainId: 143,
      change,
      check: null,
      attestation: null,
      reportURL: null,
    });
  });
});
