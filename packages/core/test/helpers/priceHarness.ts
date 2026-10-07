import type { Address } from 'viem';
import type { ActiveSubscription, SharePriceRead, WatchEvent } from '../../src/index.js';
import { addr, attestParams, ERC4626, reportOf, T0, type Harness } from './watchHarness.js';

// Share value stand-ins for the watcher tests (watch.price.*.test.ts): a share value per subject in memory, and
// the known vaults and subscriptions the tests start from.

export const E18 = 10n ** 18n;
export const SEC = 1_000;
export const MIN = 60_000;

/** A share value per subject: a bigint, 'rpc' (a transport failure), 'empty' (totalSupply 0) or 'low' (low resolution). */
export function withPrices(h: Harness) {
  const prices = new Map<string, bigint | 'rpc' | 'empty' | 'low'>();
  const scales = new Map<string, number>();
  const reads: Array<{ subject: Address; block: bigint; known?: { decimals: number; scale: number } }> = [];
  h.effects.sharePrice = async (subject, block, known): Promise<SharePriceRead> => {
    reads.push({ subject, block, ...(known ? { known } : {}) });
    const p = prices.get(subject.toLowerCase());
    if (p === undefined) return { ok: false, reason: 'no such vault' };
    if (p === 'rpc') throw Object.assign(new Error('HTTP request failed.'), { name: 'HttpRequestError', status: 503 });
    if (p === 'empty') return { ok: false, reason: `totalSupply() is 0 at block ${block}: no share to value` };
    if (p === 'low') return { ok: false, lowResolution: true, reason: 'one share is worth 3 base units' };
    return { ok: true, assetsPerShare: p, shareDecimals: 18, scale: scales.get(subject.toLowerCase()) ?? 0 };
  };
  return { prices, scales, reads };
}

/** A vault the watcher checked at block 100 (outcome as reportOf), with a Valid attestation of that outcome when `attested`. */
export function known(h: Harness, subject: Address, attested: boolean): void {
  h.store.vaults.vaults[subject.toLowerCase()] = {
    firstSeen: { source: 'backfill', block: '100', at: '2026-10-01T00:00:00.000Z' },
    deployBlock: null,
    lastCheck: {
      block: '100',
      at: T0.toISOString(),
      reportPath: 'certs/checks/x.json',
      summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 },
      failed: [],
      implementationKey: reportOf(subject, 1n).identity.implementationKey as `0x${string}`,
    },
    lastAttestationId: attested ? String(h.registry.list.length) : null,
    firstDepositBlock: null,
  };
  if (attested) h.registry.attest(attestParams(subject, 100n));
}

export const subOf = (id: bigint, subject: Address): ActiveSubscription => ({ id, subscriber: addr(0x5b), subjectChainId: 143n, subject, standardId: ERC4626, startsAt: 0n, endsAt: 10n ** 12n });

export const later = (h: Harness, ms: number): void => {
  h.clock.now = new Date(h.clock.now.getTime() + ms);
};

export const priceEvents = (h: Harness) => h.events.filter((e): e is Extract<WatchEvent, { type: 'watch-price' }> => e.type === 'watch-price');

/** Moves the clock and the head, then runs one pass. */
export async function step(h: Harness, w: { pass(): Promise<unknown> }, ms: number, blocks: bigint): Promise<void> {
  later(h, ms);
  h.chain.head += blocks;
  await w.pass();
}
