import { afterEach, describe, expect, it } from 'vitest';
import type { FeedEvent } from '../src/index.js';
import { E18, known, later, MIN, priceEvents, SEC, step, subOf, withPrices } from './helpers/priceHarness.js';
import { addr, cleanupHarnesses, harness } from './helpers/watchHarness.js';

afterEach(cleanupHarnesses);

const V = addr(0x9a01);
const W = addr(0x9a02);
const S = [0x9b01, 0x9b02, 0x9b03, 0x9b04, 0x9b05].map(addr);
const drops = (feed: FeedEvent[]) => feed.filter((e) => e.kind === 'changed' && e.change?.kind === 'price-drop');

describe('the read round stays live', { timeout: 60_000 }, () => {
  it('review B and M3a: a pending drop whose vault stops giving a value is forgotten after five misses, then the subscribed vault is read', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, V, true);
    known(h, W, false);
    prices.set(V.toLowerCase(), E18);
    prices.set(W.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w1 = h.watcher({ maxPriceReadsPerMinute: 1 });
    await w1.pass();
    prices.set(V.toLowerCase(), E18 / 2n);
    await step(h, w1, 5 * MIN + 1, 10n);
    expect(h.store.state.prices[V.toLowerCase()]?.drop).toBeDefined();
    prices.set(V.toLowerCase(), 'empty');
    const w = h.watcher({ maxPriceReadsPerMinute: 1, subscribedMinutes: 100_000 }, { subscriptions: { active: async () => [subOf(1n, W)] } });
    const before = reads.length;
    for (let i = 0; i < 7; i++) await step(h, w, 61 * SEC, 10n);
    const after = reads.slice(before).map((r) => (r.subject === V ? 'V' : 'W'));
    expect(after.join('')).toBe('VVVVVWW');
    expect(h.store.state.prices[V.toLowerCase()]!.drop).toBeUndefined();
    expect(priceEvents(h).find((e) => e.step === 'forgotten')!.reason).toBe('the fall seen at block 2000 was not confirmed: the vault gave no value 5 times in a row');
    expect(await h.feed()).toEqual([]);
  });

  it('a pending drop nobody could read for an hour is forgotten by age', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher();
    await w.pass();
    prices.set(V.toLowerCase(), E18 / 2n);
    await step(h, w, 5 * MIN, 10n);
    expect(h.store.state.prices[V.toLowerCase()]!.drop).toBeDefined();
    // The head does not move, so nothing is read; an hour later the drop is gone, the reference kept.
    await step(h, w, 61 * MIN, 0n);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ assetsPerShare: E18.toString() });
    expect(h.store.state.prices[V.toLowerCase()]!.drop).toBeUndefined();
    expect(priceEvents(h).at(-1)).toMatchObject({ step: 'forgotten', reason: 'the fall seen at block 2000 was not confirmed within 60 min' });
  });

  it('review M3b: a quarter of the reads per minute is kept for attested vaults; subscribed ones cannot take it', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    for (const s of S) {
      known(h, s, false);
      prices.set(s.toLowerCase(), E18);
    }
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ maxPriceReadsPerMinute: 4, subscribedMinutes: 100_000 }, { subscriptions: { active: async () => S.map((s, i) => subOf(BigInt(i + 1), s)) } });
    await w.pass();
    expect(reads.map((r) => r.subject)).toEqual([S[0], S[1], S[2], V]);
  });

  it('review B2: a subscribed vault read every 30 s over 10 minutes leaves room for the attested one', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, V, true);
    known(h, W, false);
    prices.set(V.toLowerCase(), E18);
    prices.set(W.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ maxPriceReadsPerMinute: 4, subscribedMinutes: 100_000 }, { subscriptions: { active: async () => [subOf(1n, W)] } });
    for (let i = 0; i < 20; i++) await step(h, w, 30 * SEC, 74n);
    const v = reads.filter((r) => r.subject === V).length;
    expect(reads.length - v).toBeLessThanOrEqual(21);
    expect(v).toBeGreaterThanOrEqual(2);
  });

  it('review M3c: a round stops at the first RPC failure, and after priceRoundMs', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    for (const s of S.slice(0, 3)) {
      known(h, s, true);
      prices.set(s.toLowerCase(), E18);
    }
    prices.set(S[0]!.toLowerCase(), 'rpc');
    h.store.state.cursor = '1991';
    const w = h.watcher();
    await w.pass();
    expect(reads.map((r) => r.subject)).toEqual([S[0]]);
    expect(h.events.filter((e) => e.type === 'watch-error' && e.step === 'price').map((e) => (e as { error: string }).error)).toEqual([
      `${S[0]}: share value not read at block 1990, not a verdict: transport failure: HTTP request failed.`,
    ]);
    expect(h.store.state.prices).toEqual({});

    // Each read takes 6 s of the clock: two fit in a round of 10 s, the third waits for the next pass.
    prices.set(S[0]!.toLowerCase(), E18);
    const read = h.effects.sharePrice!;
    h.effects.sharePrice = async (subject, block, k) => {
      later(h, 6 * SEC);
      return read(subject, block, k);
    };
    await step(h, w, 5 * MIN, 10n);
    expect(reads.slice(1).map((r) => r.subject)).toEqual([S[1], S[2]]);
    await step(h, w, 0, 10n);
    expect(reads.slice(3).map((r) => r.subject)).toEqual([S[0]]);
  });

  it('review C and M5: a failed first subscription read after a restart keeps the reference, so a drop across the restart is found', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, W, false);
    prices.set(W.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const sub = subOf(1n, W);
    const w1 = h.watcher({ subscribedMinutes: 100_000 }, { subscriptions: { active: async () => [sub] } });
    await w1.pass();
    await w1.save();
    await h.reload();
    let first = true;
    const flaky = {
      active: async () => {
        if (first) {
          first = false;
          throw new Error('testnet rpc down');
        }
        return [sub];
      },
    };
    const w2 = h.watcher({ subscribedMinutes: 100_000 }, { subscriptions: flaky });
    // The loss happened while the watcher was down.
    prices.set(W.toLowerCase(), E18 / 2n);
    await step(h, w2, 0, 10n);
    expect(h.store.state.prices[W.toLowerCase()]).toMatchObject({ assetsPerShare: E18.toString(), block: '1990' });
    expect(h.store.state.prices[W.toLowerCase()]!.unfollowedAt).toBeUndefined();
    for (let i = 0; i < 6 && drops(await h.feed()).length === 0; i++) await step(h, w2, 31 * SEC, 10n);
    expect(drops(await h.feed()).map((e) => e.change)).toEqual([expect.objectContaining({ fromBlock: '1990', dropBps: 5_000 })]);
  });

  it('review M5: a subject followed no more keeps its track for 24 hours, then it is forgotten', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, W, false);
    prices.set(W.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    let subs = [subOf(1n, W)];
    const w = h.watcher({ subscribedMinutes: 100_000 }, { subscriptions: { active: async () => subs } });
    await w.pass();
    subs = [];
    await step(h, w, MIN, 10n);
    const since = h.store.state.prices[W.toLowerCase()]!.unfollowedAt;
    expect(since).toBe(h.clock.now.toISOString());
    expect(reads).toHaveLength(1);
    await step(h, w, 23 * 60 * MIN, 10n);
    expect(h.store.state.prices[W.toLowerCase()]).toMatchObject({ unfollowedAt: since });
    // Followed again within the day: the old reference is still there.
    subs = [subOf(2n, W)];
    await step(h, w, MIN, 10n);
    expect(h.store.state.prices[W.toLowerCase()]!.unfollowedAt).toBeUndefined();
    subs = [];
    await step(h, w, MIN, 10n);
    await step(h, w, 24 * 60 * MIN, 10n);
    expect(h.store.state.prices).toEqual({});
  });

  it('review L3: a share value too small to measure is marked and not read again for 6 hours; a scaled track reads at its scale', async () => {
    const h = await harness();
    const { prices, scales, reads } = withPrices(h);
    known(h, V, true);
    known(h, W, true);
    prices.set(V.toLowerCase(), 'low');
    prices.set(W.toLowerCase(), 99_900n);
    scales.set(W.toLowerCase(), 2);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1 });
    await w.pass();
    expect(h.store.state.priceLowResolution).toEqual({ [V.toLowerCase()]: h.clock.now.toISOString() });
    expect(h.store.state.prices[W.toLowerCase()]).toMatchObject({ scale: 2, assetsPerShare: '99900' });
    await step(h, w, 61 * SEC, 10n);
    expect(reads.filter((r) => r.subject === V)).toHaveLength(1);
    expect(reads.filter((r) => r.subject === W).at(-1)!.known).toEqual({ decimals: 18, scale: 2 });
    await step(h, w, 6 * 60 * MIN, 10n);
    expect(reads.filter((r) => r.subject === V)).toHaveLength(2);
  });

  it('nobody subscribed and nobody attested: not followed unless --price-all, then within the reads per minute, longest unread first', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    for (const s of S.slice(0, 3)) {
      known(h, s, false);
      prices.set(s.toLowerCase(), E18);
    }
    h.store.state.cursor = '1991';
    await h.watcher().pass();
    expect(reads).toEqual([]);
    const w = h.watcher({ priceAll: true, maxPriceReadsPerMinute: 2 });
    await w.pass();
    expect(reads.map((r) => r.subject)).toEqual([S[0], S[1]]);
    await step(h, w, 30 * SEC, 10n);
    expect(reads).toHaveLength(2);
    await step(h, w, 31 * SEC, 0n);
    expect(reads.map((r) => r.subject)).toEqual([S[0], S[1], S[2]]);
  });
});
