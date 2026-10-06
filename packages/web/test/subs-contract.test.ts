import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, toEventSignature, toFunctionSignature, type AbiEvent, type AbiFunction } from 'viem';
import { checkSubscriptionsAbi, FIRST_SUBSCRIPTION_ID, subsAddress } from '../lib/subs/contract';
import { isActiveAt, refundAt, runDaysOf, startedDaysAt } from '../lib/subs/core';
import { combineRevenue, priceOf } from '../lib/subs/economics';
import { latestSubscriptionIds, normalizeSubscription, readSubsSummary } from '../lib/subs/read';
import { cancelledFromLogs, subscribedFromLogs } from '../lib/subs/wallet';

/*
 * lib/subs/contract.ts re-exports the ABI of core's CheckSubscriptions build. These pin every call and event the
 * web relies on, so a contract change that breaks the web shows up here.
 */

const CONTRACT = '0x0000000000000000000000000000000000005005';
const SUBSCRIBER = getAddress('0x5ee0000000000000000000000000000000000001');
const VAULT = getAddress('0xfeed000000000000000000000000000000000001');
const DAY = 86_400;

describe('CheckSubscriptions ABI', () => {
  const fns = checkSubscriptionsAbi.filter((x) => x.type === 'function').map((f) => toFunctionSignature(f as AbiFunction));
  const events = checkSubscriptionsAbi.filter((x) => x.type === 'event').map((e) => toEventSignature(e as AbiEvent));

  it('has exactly the ADR calls', () => {
    expect(fns.sort()).toEqual(
      [
        'subscribe(uint64,address,bytes32,uint32)',
        'extend(uint256,uint32)',
        'cancel(uint256)',
        'settle(uint256[])',
        'withdraw(address)',
        'setFeePerDay(uint96)',
        'subscriptionOf(uint256)',
        'subscriptionCount()',
        'isActive(uint256)',
        'feePerDay()',
        'owner()',
        'earned()',
        'withdrawn()',
        'escrowed()',
      ].sort(),
    );
    const payable = checkSubscriptionsAbi.filter((x) => x.type === 'function' && x.stateMutability === 'payable').map((x) => (x as AbiFunction).name);
    expect(payable.sort()).toEqual(['extend', 'subscribe']);
    const ctor = checkSubscriptionsAbi.find((x) => x.type === 'constructor') as unknown as { inputs: readonly { type: string }[] };
    expect(ctor.inputs.map((i) => i.type)).toEqual(['address', 'uint96']);
  });

  it('decodes subscriptionOf as the Subscription struct, field by field', () => {
    const f = checkSubscriptionsAbi.find((x) => x.type === 'function' && x.name === 'subscriptionOf') as AbiFunction;
    const out = f.outputs[0] as { type: string; components: { name: string; type: string }[] };
    expect(out.type).toBe('tuple');
    expect(out.components.map((c) => `${c.type} ${c.name}`)).toEqual([
      'address subscriber',
      'uint64 subjectChainId',
      'address subject',
      'bytes32 standardId',
      'uint96 feePerDay',
      'uint64 startsAt',
      'uint64 endsAt',
      'uint96 paid',
      'uint96 settled',
      'bool cancelled',
    ]);
  });

  it('has the six ADR events with these exact signatures and indexed fields', () => {
    expect(events.sort()).toEqual(
      [
        'Subscribed(uint256,address,uint64,address,bytes32,uint32,uint96,uint64)',
        'Extended(uint256,uint32,uint96,uint64)',
        'Cancelled(uint256,uint96)',
        'Settled(uint256,uint96)',
        'FeesWithdrawn(address,uint96)',
        'FeePerDaySet(uint96)',
      ].sort(),
    );
    const subscribed = checkSubscriptionsAbi.find((x) => x.type === 'event' && x.name === 'Subscribed') as AbiEvent;
    expect(subscribed.inputs.filter((i) => i.indexed).map((i) => i.name)).toEqual(['id', 'subscriber', 'subject']);
    expect(FIRST_SUBSCRIPTION_ID).toBe(0n);
  });

  it('names the contract errors the pages may see on a simulated write', () => {
    const errors = checkSubscriptionsAbi.filter((x) => x.type === 'error').map((x) => (x as { name: string }).name);
    expect(errors).toEqual(expect.arrayContaining(['NotSubscriber', 'WrongValue', 'BadDays', 'UnknownSubscription', 'AlreadyCancelled', 'TransferFailed']));
  });

  it('the address comes from NEXT_PUBLIC_SPECFIRST_SUBS_10143; unset or junk means not deployed', () => {
    expect(subsAddress({})).toBeNull();
    expect(subsAddress({ NEXT_PUBLIC_SPECFIRST_SUBS_10143: 'soon' })).toBeNull();
    expect(subsAddress({ NEXT_PUBLIC_SPECFIRST_SUBS_10143: ` ${VAULT.toLowerCase()} ` })).toBe(VAULT);
  });
});

describe('receipts', () => {
  const subscribedEvent = checkSubscriptionsAbi.find((x) => x.type === 'event' && x.name === 'Subscribed') as AbiEvent;
  const cancelledEvent = checkSubscriptionsAbi.find((x) => x.type === 'event' && x.name === 'Cancelled') as AbiEvent;

  it('reads the id and end from Subscribed, and the refund from Cancelled, of this contract only', () => {
    const topics = encodeEventTopics({
      abi: [subscribedEvent],
      eventName: 'Subscribed',
      args: { id: 5n, subscriber: SUBSCRIBER, subject: VAULT },
    }) as `0x${string}`[];
    const data = encodeAbiParameters(
      [{ type: 'uint64' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'uint96' }, { type: 'uint64' }],
      [143n, `0x${'45'.repeat(32)}`, 7, 7n * 10n ** 16n, 1_791_000_000n],
    );
    const log = { address: CONTRACT as `0x${string}`, topics: topics as [`0x${string}`, ...`0x${string}`[]], data };
    expect(subscribedFromLogs([log], CONTRACT)).toEqual({ id: 5n, endsAt: 1_791_000_000n, paid: 7n * 10n ** 16n, days: 7 });
    expect(subscribedFromLogs([{ ...log, address: VAULT as `0x${string}` }], CONTRACT)).toBeNull();
    const ctopics = encodeEventTopics({ abi: [cancelledEvent], eventName: 'Cancelled', args: { id: 5n } }) as [`0x${string}`, ...`0x${string}`[]];
    const cdata = encodeAbiParameters([{ type: 'uint96' }], [6n * 10n ** 16n]);
    expect(cancelledFromLogs([{ address: CONTRACT as `0x${string}`, topics: ctopics, data: cdata }], CONTRACT)).toEqual({ id: 5n, refund: 6n * 10n ** 16n });
  });
});

describe('reads', () => {
  it('normalizes the struct from named fields or a tuple', () => {
    const named = {
      subscriber: SUBSCRIBER,
      subjectChainId: 143n,
      subject: VAULT,
      standardId: `0x${'45'.repeat(32)}`,
      feePerDay: 10n,
      startsAt: 100n,
      endsAt: 100n + 7n * 86_400n,
      paid: 70n,
      settled: 10n,
      cancelled: false,
    };
    const a = normalizeSubscription(1n, named);
    const b = normalizeSubscription(1n, Object.values(named));
    expect(a).toEqual(b);
    expect(a).toMatchObject({ id: 1n, subjectChainId: 143n, feePerDay: 10n, paid: 70n, settled: 10n, cancelled: false });
    expect(isActiveAt(a, 100n)).toBe(true);
    expect(isActiveAt(a, 100n + 7n * 86_400n)).toBe(false);
    expect(isActiveAt({ ...a, cancelled: true }, 100n)).toBe(false);
    expect(latestSubscriptionIds(3n, 10)).toEqual([2n, 1n, 0n]);
    expect(latestSubscriptionIds(3000n, 2)).toEqual([2999n, 2998n]);
  });

  it('a summary with some failed reads says which; all failed is an error', async () => {
    const reader = {
      readContract: async ({ functionName }: { functionName: string }) => (functionName === 'owner' ? Promise.reject(new Error('rate limited')) : 7n),
    };
    const s = await readSubsSummary(reader, CONTRACT as `0x${string}`);
    expect(s).toMatchObject({ feePerDayWei: 7n, count: 7n, owner: null });
    expect(s.errors).toEqual(['owner: rate limited']);
    await expect(readSubsSummary({ readContract: async () => Promise.reject(new Error('down')) }, CONTRACT as `0x${string}`)).rejects.toThrow(/not reachable/);
  });
});

describe('money', () => {
  const sub = { feePerDay: 10n, startsAt: 1000n, endsAt: 1000n + 7n * BigInt(DAY), paid: 70n, settled: 0n, cancelled: false };
  const at = (n: number) => BigInt(n);

  it('a started day counts; cancel refunds the days not started (core rules, as CheckSubscriptions.sol)', () => {
    expect(runDaysOf(sub)).toBe(7n);
    expect(startedDaysAt(sub, at(999))).toBe(0n);
    expect(startedDaysAt(sub, at(1000))).toBe(1n);
    expect(startedDaysAt(sub, at(1000 + DAY))).toBe(2n);
    expect(startedDaysAt(sub, at(1000 + 30 * DAY))).toBe(7n);
    expect(refundAt(sub, at(1000))).toBe(60n);
    expect(refundAt(sub, at(1000 + DAY - 1))).toBe(60n);
    expect(refundAt(sub, at(1000 + 6 * DAY))).toBe(0n);
    expect(refundAt(sub, at(1000 + 7 * DAY))).toBe(0n);
    expect(refundAt({ ...sub, cancelled: true }, at(1000))).toBe(0n);
    // Extended after it expired: a new 3-day run; the 70 paid for the first run is used.
    const rerun = { ...sub, startsAt: 900_000n, endsAt: 900_000n + 3n * BigInt(DAY), paid: 100n };
    expect(refundAt(rerun, at(900_000))).toBe(20n);
    expect(priceOf(10n, 7)).toBe(70n);
  });

  it('combines both contracts against both processes, and says what it could not count', () => {
    const r = combineRevenue({
      desk: { earnedWei: 200n, withdrawnWei: 50n, escrowedWei: 10n },
      subs: { earnedWei: 30n, withdrawnWei: 0n, escrowedWei: 40n },
      deskGasWei: 60n,
      watcherGasWei: null,
    });
    expect(r).toMatchObject({ earnedWei: 230n, escrowedWei: 50n, withdrawnWei: 50n, gasWei: 60n, netWei: 170n, missing: ['watcher gas'] });
    const none = combineRevenue({ desk: null, subs: null, deskGasWei: null, watcherGasWei: null });
    expect(none).toMatchObject({ earnedWei: null, gasWei: null, netWei: null });
    expect(none.missing).toEqual(['desk fees', 'subscription fees', 'desk worker gas', 'watcher gas']);
  });
});
