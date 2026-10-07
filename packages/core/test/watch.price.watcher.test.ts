import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { priorityOf, QUEUE_PRIORITY, type AlertSink, type FeedEvent } from '../src/index.js';
import { E18, known, later, MIN, priceEvents, SEC, step, subOf, withPrices } from './helpers/priceHarness.js';
import { addr, cleanupHarnesses, harness, kinds } from './helpers/watchHarness.js';

afterEach(cleanupHarnesses);

const V = addr(0x9a01);
const W = addr(0x9a02);
const drops = (feed: FeedEvent[]) => feed.filter((e) => e.kind === 'changed' && e.change?.kind === 'price-drop');

describe('the watcher follows the share value', { timeout: 60_000 }, () => {
  it('an attested vault: a fall waits 10 blocks and 2 minutes, then one changed event and a re-check at sweep priority that attests nothing', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher();
    await w.pass();
    expect(reads).toEqual([{ subject: V, block: 1990n }]);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ decimals: 18, scale: 0, assetsPerShare: E18.toString(), block: '1990', readBlock: '1990' });

    // Not subscribed: read again only after --price-minutes; the known decimals and scale go with the read.
    prices.set(V.toLowerCase(), (E18 * 9958n) / 10_000n);
    await step(h, w, 0, 10n);
    expect(reads).toHaveLength(1);
    await step(h, w, 5 * MIN, 0n);
    expect(reads.at(-1)).toEqual({ subject: V, block: 2000n, known: { decimals: 18, scale: 0 } });
    expect(priceEvents(h).map((e) => [e.step, e.dropBps])).toEqual([['pending', 42]]);
    // A pending drop is read every 30 s: 20 blocks on but 30 s on is not enough (review L1).
    await step(h, w, 30 * SEC, 20n);
    expect(await h.feed()).toEqual([]);
    await step(h, w, 90 * SEC, 10n);
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['changed:price-drop', 'queued:price-drop', 'checked:price-drop']);
    expect(feed[0]).toMatchObject({
      subject: V,
      block: '2030',
      change: { kind: 'price-drop', fromAssetsPerShare: E18.toString(), toAssetsPerShare: '995800000000000000', dropBps: 42, fromBlock: '1990', toBlock: '2030' },
      reason: 'confirmed by a second read at block 2030 after block 2000',
    });
    expect(feed[1]!.reason).toBe('share value fell 0.42% between block 1990 and block 2030');
    expect(feed[2]!.reason).toBe('not attested [unchanged]: unchanged since attestation 0');
    expect(h.registry.list).toHaveLength(1);
    // Review M2: nobody subscribed, so the re-check goes at the sweep's priority.
    expect(priorityOf('price-drop', false)).toBe(QUEUE_PRIORITY.sweep);
    // Review L4: a drop is not a result that moved.
    expect(w.status().counts).toMatchObject({ changed24h: 0, priceDrops24h: 1 });
  });

  it('a subscribed vault is read every 30 s; its subscribers get the drop, saved before delivery, so a crash while delivering alerts once (review L2, E)', async () => {
    const h = await harness();
    const { prices, reads } = withPrices(h);
    const statePath = path.join(h.dir, '.specfirst/watch/143/state.json');
    let onDisk: string | null = null;
    const delivered: FeedEvent[] = [];
    const sink: AlertSink = {
      deliver: async (event, subs) => {
        delivered.push(event);
        onDisk ??= readFileSync(statePath, 'utf8');
        return subs.map((s) => ({ ...event, v: 1, seq: 0, kind: 'alerted', alert: { subscriptionId: s.id.toString(), subscriber: s.subscriber, channel: 'webhook', ok: true, status: 204 } }));
      },
    };
    known(h, W, true);
    prices.set(W.toLowerCase(), 2n * E18);
    h.store.state.cursor = '1991';
    h.store.state.subscriptions['3'] = { firstCheckAt: '2026-10-06T00:00:00.000Z' };
    const hooks = { subscriptions: { active: async () => [subOf(3n, W)] }, alerts: sink };
    const w = h.watcher({ subscribedMinutes: 600 }, hooks);
    await w.pass();
    await step(h, w, 10 * SEC, 1n);
    await step(h, w, 21 * SEC, 1n);
    // Review M3b: every 30 s at most, not at every pass.
    expect(reads.map((r) => r.block)).toEqual([1990n, 1992n]);

    prices.set(W.toLowerCase(), E18);
    for (let i = 0; i < 8 && drops(await h.feed()).length === 0; i++) await step(h, w, 31 * SEC, 10n);
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['changed:price-drop', 'alerted:price-drop', 'queued:price-drop', 'checked:price-drop']);
    expect(delivered.map((e) => e.kind)).toEqual(['changed']);
    expect(feed[0]!.change).toMatchObject({ dropBps: 5_000, fromBlock: '1992' });
    expect(feed[1]).toMatchObject({ seq: feed[0]!.seq + 1, alert: { subscriptionId: '3', ok: true } });
    // What was on disk while the sink delivered: the confirmation, the moved reference, the event's seq.
    const saved = JSON.parse(onDisk!) as { seq: number; prices: Record<string, { assetsPerShare: string; drop?: unknown }> };
    expect(saved.seq).toBe(feed[0]!.seq);
    expect(saved.prices[W.toLowerCase()]).toMatchObject({ assetsPerShare: E18.toString() });
    expect(saved.prices[W.toLowerCase()]!.drop).toBeUndefined();

    // The process dies inside deliver: after a restart from that state.json, the drop is not confirmed again.
    writeFileSync(statePath, onDisk!);
    await h.reload();
    const w2 = h.watcher({ subscribedMinutes: 600 }, hooks);
    await step(h, w2, 31 * SEC, 10n);
    await step(h, w2, 3 * MIN, 10n);
    expect(drops(await h.feed())).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('review A: a one-read upward spike and the return to normal give no event, and the reference stays', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1 });
    await w.pass();
    for (const p of [(E18 * 101n) / 100n, E18, E18, E18]) {
      prices.set(V.toLowerCase(), p);
      await step(h, w, 61 * SEC, 10n);
    }
    expect(await h.feed()).toEqual([]);
    expect(priceEvents(h)).toEqual([]);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ assetsPerShare: E18.toString(), block: '2030' });
  });

  it('review D and M2: a vault whose value saws up and down gets at most 4 drop events a day and one re-check per 6 hours', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1 });
    await w.pass();
    const hi = (E18 * 101n) / 100n;
    // Up for two reads (so the reference rises), down for three (seen, waiting, confirmed 2 minutes later).
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const p of [hi, hi, E18, E18, E18]) {
        prices.set(V.toLowerCase(), p);
        await step(h, w, 61 * SEC, 15n);
      }
    }
    const feed = await h.feed();
    expect(drops(feed)).toHaveLength(4);
    expect(drops(feed).slice(1).every((e) => /; no re-check: a drop queued one at .*, within 6 hours$/.test(e.reason!))).toBe(true);
    expect(priceEvents(h).filter((e) => e.step === 'capped')).toHaveLength(1);
    expect(priceEvents(h).find((e) => e.step === 'capped')!.reason).toMatch(
      /^4 price-drop events of this vault today, the most there are \(--max-price-drops-per-day\), and this one is not larger than them: logged only, the reference stays at block \d+$/,
    );
    expect(feed.filter((e) => e.kind === 'queued')).toHaveLength(1);
    expect(h.checks).toHaveLength(1);
    expect(h.registry.list).toHaveLength(1);
  });

  it('review M4: a vault in its check timeout cooldown is still read and its subscribers still alerted; only the re-check waits', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    const delivered: string[] = [];
    const sink: AlertSink = {
      deliver: async (event) => {
        delivered.push(event.kind);
        return [];
      },
    };
    known(h, W, true);
    prices.set(W.toLowerCase(), E18);
    h.store.state.cursor = '1991';
    h.store.state.subscriptions['3'] = { firstCheckAt: '2026-10-06T00:00:00.000Z' };
    h.store.state.cooldowns[W.toLowerCase()] = { until: new Date(h.clock.now.getTime() + 600 * MIN).toISOString(), timeouts: 1 };
    const w = h.watcher({ subscribedMinutes: 600 }, { subscriptions: { active: async () => [subOf(3n, W)] }, alerts: sink });
    await w.pass();
    prices.set(W.toLowerCase(), E18 / 2n);
    for (let i = 0; i < 6; i++) await step(h, w, 31 * SEC, 10n);
    expect(kinds(await h.feed())).toEqual(['changed:price-drop']);
    expect(delivered).toEqual(['changed']);
    expect(h.checks).toHaveLength(0);
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
    later(h, MIN);
    await h.watcher().pass();
    expect(h.store.state.prices).toEqual({});
  });
});

describe('the daily cap of drop events never swallows a loss', { timeout: 60_000 }, () => {
  /** Runs reads of `p` until a drop is confirmed or capped (pending, waiting, then 2 minutes and 10 blocks later). */
  const fallTo = async (h: Awaited<ReturnType<typeof harness>>, w: { pass(): Promise<unknown> }, prices: Map<string, unknown>, p: bigint) => {
    prices.set(V.toLowerCase(), p);
    for (let i = 0; i < 3; i++) await step(h, w, 61 * SEC, 15n);
  };

  it('review N1: after the day\'s 4 small drops, a 50% loss is still announced (at least 10x the threshold)', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    let value = 100_000_000n;
    prices.set(V.toLowerCase(), value);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1 });
    await w.pass();
    for (let i = 0; i < 4; i++) {
      value -= value / 500n; // 20 bps
      await fallTo(h, w, prices, value);
    }
    const small = drops(await h.feed()).map((e) => (e.change as { dropBps: number }).dropBps);
    expect(small).toHaveLength(4);
    expect(small.every((bps) => bps >= 19 && bps <= 20)).toBe(true);
    await fallTo(h, w, prices, value / 2n);
    expect(drops(await h.feed()).map((e) => (e.change as { dropBps: number }).dropBps)).toEqual([...small, 5_000]);
    expect(priceEvents(h).filter((e) => e.step === 'capped')).toEqual([]);
  });

  it('a capped drop keeps the reference, so a staged drain is announced as it adds up, from the last announced block', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), 1_000_000n);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1, maxPriceDropsPerDay: 1 });
    await w.pass();
    // Steps of 0.5%, under ten times the threshold (1%).
    await fallTo(h, w, prices, 995_000n);
    const [first] = drops(await h.feed());
    expect(first!.change).toMatchObject({ fromAssetsPerShare: '1000000', toAssetsPerShare: '995000', dropBps: 50 });
    await fallTo(h, w, prices, 990_025n);
    expect(drops(await h.feed())).toHaveLength(1);
    expect(priceEvents(h).filter((e) => e.step === 'capped').at(-1)!.reason).toMatch(/not larger than them: logged only, the reference stays at block /);
    expect(h.store.state.prices[V.toLowerCase()]).toMatchObject({ assetsPerShare: '995000', block: (first!.change as { toBlock: string }).toBlock });
    // The next step makes the fall from the held reference larger than the day's largest: announced, measured from there.
    await fallTo(h, w, prices, 985_075n);
    const all = drops(await h.feed());
    expect(all).toHaveLength(2);
    expect(all[1]!.change).toMatchObject({ fromAssetsPerShare: '995000', fromBlock: (first!.change as { toBlock: string }).toBlock, toAssetsPerShare: '985075', dropBps: 99 });
  });

  it('a loss held by the cap is announced the next UTC day', async () => {
    const h = await harness();
    const { prices } = withPrices(h);
    known(h, V, true);
    prices.set(V.toLowerCase(), 1_000_000n);
    h.store.state.cursor = '1991';
    const w = h.watcher({ priceMinutes: 1, maxPriceDropsPerDay: 1 });
    await w.pass();
    await fallTo(h, w, prices, 995_000n);
    await fallTo(h, w, prices, 992_000n);
    expect(drops(await h.feed())).toHaveLength(1);
    expect(priceEvents(h).filter((e) => e.step === 'capped')).toHaveLength(1);
    later(h, 12 * 60 * MIN);
    await fallTo(h, w, prices, 992_000n);
    expect(drops(await h.feed()).map((e) => e.change)).toEqual([
      expect.objectContaining({ dropBps: 50 }),
      expect.objectContaining({ fromAssetsPerShare: '995000', toAssetsPerShare: '992000', dropBps: 30 }),
    ]);
  });
});

describe('state written before the review fixes', () => {
  it('a state.json of b30a051 loads: the last read defaults to the reference, the scale to 0, the misses to 0', async () => {
    const h = await harness();
    const dir = path.join(h.dir, '.specfirst/watch/143');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dir, { recursive: true });
    const old = {
      ...JSON.parse(JSON.stringify(h.store.state)),
      prices: {
        [V.toLowerCase()]: { decimals: 18, assetsPerShare: '1000', block: '10', readBlock: '12', readAt: '2026-10-07T00:00:00.000Z', drop: { assetsPerShare: '900', block: '12', at: '2026-10-07T00:00:00.000Z' } },
      },
    };
    delete old.priceLowResolution;
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(old));
    const store = await h.reload();
    expect(store.state.prices[V.toLowerCase()]).toEqual({
      decimals: 18,
      scale: 0,
      assetsPerShare: '1000',
      block: '10',
      readAssetsPerShare: '1000',
      readBlock: '12',
      readAt: '2026-10-07T00:00:00.000Z',
      drop: { assetsPerShare: '900', block: '12', at: '2026-10-07T00:00:00.000Z', misses: 0 },
    });
    expect(store.state.priceLowResolution).toEqual({});
  });
});
