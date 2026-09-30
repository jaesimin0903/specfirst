import { describe, expect, it } from 'vitest';
import { computeEconomics, countRequests, emptyCounts } from '../lib/desk/economics';
import { formatDuration, formatMon, formatMonAmount, toIso } from '../lib/desk/format';

const E = 10n ** 18n;
const FEE = E / 10n; // 0.1 MON

describe('formatMon', () => {
  it('ether units, trailing zeros dropped, never "0" for a small non-zero amount', () => {
    expect(formatMonAmount(FEE)).toBe('0.1');
    expect(formatMonAmount(1234n * E + E / 2n)).toBe('1,234.5');
    expect(formatMonAmount(23_100_000_000_000_000n)).toBe('0.0231');
    expect(formatMonAmount(12n)).toBe('<0.0001');
    expect(formatMonAmount(0n)).toBe('0');
    expect(formatMonAmount(-FEE)).toBe('-0.1');
    expect(formatMon(null)).toBe('unknown');
    expect(formatMon(FEE)).toBe('0.1 MON');
  });

  it('durations and timestamps', () => {
    expect(formatDuration(42)).toBe('42 s');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3900)).toBe('1 h 5 min');
    expect(formatDuration(86400 * 2)).toBe('2 days');
    expect(toIso(1790000000)).toBe(new Date(1_790_000_000_000).toISOString());
    expect(toIso('1790000000')).toBe(toIso(1790000000));
    expect(toIso('2026-10-01T00:00:00Z')).toBe('2026-10-01T00:00:00.000Z');
    expect(toIso('nope')).toBeNull();
  });
});

describe('countRequests', () => {
  it('tallies by status and adds up what was paid and returned', () => {
    const now = 10_000;
    const c = countRequests(
      [
        { status: 'Fulfilled', feeWei: FEE, requestedAt: 1n },
        { status: 'Fulfilled', feeWei: FEE, requestedAt: 2n },
        { status: 'Rejected', feeWei: FEE, requestedAt: 3n },
        { status: 'Refunded', feeWei: FEE, requestedAt: 4n },
        { status: 'Pending', feeWei: FEE, requestedAt: BigInt(now - 10) },
        { status: 'Pending', feeWei: FEE, requestedAt: 5n },
      ],
      { total: 6, nowSec: now, timeoutSec: 3600 },
    );
    expect(c).toEqual({ total: 6, pending: 2, fulfilled: 2, rejected: 1, refunded: 1, expired: 1, paidWei: 6n * FEE, returnedWei: 2n * FEE, truncated: false });
    expect(countRequests([], { total: 400, nowSec: now, timeoutSec: null }).truncated).toBe(true);
  });
});

describe('computeEconomics', () => {
  const counts = { ...emptyCounts(), total: 12, fulfilled: 10, pending: 1, rejected: 1, paidWei: 12n * FEE, returnedWei: FEE };

  it('net is earned minus worker gas; margin and unit profit follow', () => {
    const e = computeEconomics({
      feeWei: FEE,
      earnedWei: 10n * FEE,
      withdrawnWei: 4n * FEE,
      escrowedWei: FEE,
      counts,
      gasCostWei: 11n * 10n ** 16n, // 0.11 MON over 11 finished requests
      workerFulfilled: 10,
      workerRejected: 1,
    });
    expect(e.netWei).toBe(10n * FEE - 11n * 10n ** 16n);
    expect(e.marginPct).toBe(89);
    expect(e.gasPerCheckWei).toBe(10n ** 16n);
    expect(e.unitProfitWei).toBe(FEE - 10n ** 16n);
    expect(e.withdrawableWei).toBe(6n * FEE);
    expect(e.summary).toBe(
      'Of 12 paid checks, 10 were fulfilled, earning 1 MON against 0.11 MON of worker gas: 0.89 MON net, a 89% margin. 0.1 MON waits in escrow for 1 check in progress. 1 request ended without a result and got the fee back.',
    );
  });

  it('without the worker gas there is no net, and the sentence says so', () => {
    const e = computeEconomics({ feeWei: FEE, earnedWei: 10n * FEE, withdrawnWei: 0n, escrowedWei: 0n, counts: { ...counts, pending: 0 }, gasCostWei: null, workerFulfilled: null, workerRejected: null });
    expect(e.netWei).toBeNull();
    expect(e.marginPct).toBeNull();
    expect(e.summary).toMatch(/earning 1 MON\. Worker gas is not reported yet, so there is no net figure\./);
  });

  it('before the first request it states the price and the escrow rule', () => {
    const e = computeEconomics({ feeWei: FEE, earnedWei: 0n, withdrawnWei: 0n, escrowedWei: 0n, counts: emptyCounts(), gasCostWei: 0n, workerFulfilled: 0, workerRejected: 0 });
    expect(e.summary).toBe('No check has been paid for yet. Each one costs 0.1 MON, held in escrow and earned only when its attestation lands onchain.');
    expect(computeEconomics({ feeWei: null, earnedWei: null, withdrawnWei: null, escrowedWei: null, counts: null, gasCostWei: null, workerFulfilled: null, workerRejected: null }).summary).toMatch(
      /could not be read/,
    );
  });

  it('a loss reads as a negative net', () => {
    const e = computeEconomics({ feeWei: FEE, earnedWei: FEE, withdrawnWei: 0n, escrowedWei: 0n, counts: { ...counts, total: 1, fulfilled: 1, pending: 0, rejected: 0 }, gasCostWei: 2n * FEE, workerFulfilled: 1, workerRejected: 0 });
    expect(e.netWei).toBe(-FEE);
    expect(e.marginPct).toBe(-100);
    expect(e.summary).toMatch(/-0.1 MON net/);
  });
});
