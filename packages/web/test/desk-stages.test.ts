import { describe, expect, it } from 'vitest';
import { computeProgress, listLabel, type ProgressInput } from '../lib/desk/stages';
import type { WorkerRequestStatus } from '../lib/desk/contract';

const T0 = 1_790_000_000;
const worker = (stage: WorkerRequestStatus['stage'], extra: Partial<WorkerRequestStatus> = {}): WorkerRequestStatus => ({
  stage,
  updatedAt: new Date((T0 + 60) * 1000).toISOString(),
  txs: {},
  ...extra,
});
const base: ProgressInput = { status: 'Pending', requestedAt: BigInt(T0), timeoutSec: 3600n, worker: null, nowSec: T0 + 120 };
const states = (p: ReturnType<typeof computeProgress>) => Object.fromEntries(p.steps.map((s) => [s.key, s.state]));

describe('computeProgress: pending requests', () => {
  it('without worker status only Paid is known, Queued is shown as current', () => {
    const p = computeProgress(base);
    expect(states(p)).toEqual({ paid: 'done', queued: 'active', prechecking: 'waiting', running: 'waiting', attesting: 'waiting', outcome: 'waiting' });
    expect(p.source).toBe('chain');
    expect(p.note).toMatch(/No worker status/);
    expect(p.steps[0]!.at).toBe(new Date(T0 * 1000).toISOString());
    expect(p.terminal).toBe(false);
    expect(p.secondsToExpiry).toBe(3600 - 120);
  });

  it('each worker stage moves the current step', () => {
    expect(computeProgress({ ...base, worker: worker('prechecking') }).activeKey).toBe('prechecking');
    const running = computeProgress({ ...base, worker: worker('running') });
    expect(states(running)).toMatchObject({ queued: 'done', prechecking: 'done', running: 'active', attesting: 'waiting' });
    expect(running.steps.find((s) => s.key === 'running')!.label).toBe('Running 30 properties');
    expect(computeProgress({ ...base, worker: worker('attesting') }).activeKey).toBe('attesting');
    const fulfilling = computeProgress({ ...base, worker: worker('fulfilling') });
    expect(states(fulfilling)).toMatchObject({ attesting: 'done', outcome: 'active' });
    expect(fulfilling.steps.at(-1)!.label).toBe('Fulfilling');
  });

  it('a worker that says fulfilled while the chain says Pending is waiting for its transaction, not done', () => {
    const p = computeProgress({ ...base, worker: worker('fulfilled') });
    expect(p.outcome).toBeNull();
    expect(p.terminal).toBe(false);
    expect(p.steps.at(-1)).toMatchObject({ state: 'active', label: 'Fulfilling' });
    expect(p.note).toMatch(/chain has not recorded/);
    expect(computeProgress({ ...base, worker: worker('rejected') }).steps.at(-1)!.label).toBe('Rejecting');
  });

  it('past the timeout it is expired and refundable, wherever the worker got to', () => {
    const p = computeProgress({ ...base, worker: worker('running'), nowSec: T0 + 3600 });
    expect(p.expired).toBe(true);
    expect(p.refundable).toBe(true);
    expect(p.outcome).toBe('expired');
    expect(p.activeKey).toBeNull();
    expect(p.steps.at(-1)).toMatchObject({ label: 'Expired', state: 'failed' });
    expect(p.steps.find((s) => s.key === 'running')).toMatchObject({ state: 'skipped', detail: 'Stopped here before the timeout.' });
    expect(p.secondsToExpiry).toBe(0);
    // One second earlier it is not.
    expect(computeProgress({ ...base, nowSec: T0 + 3599 }).refundable).toBe(false);
  });

  it('an unreadable timeout never opens the refund', () => {
    const p = computeProgress({ ...base, timeoutSec: null, nowSec: T0 + 10 ** 7 });
    expect(p.refundable).toBe(false);
    expect(p.expiresAt).toBeNull();
  });
});

describe('computeProgress: ended requests', () => {
  it('Fulfilled marks every step done and the chain wins over a stale worker', () => {
    const p = computeProgress({ ...base, status: 'Fulfilled', worker: worker('attesting') });
    expect(Object.values(states(p)).every((s) => s === 'done')).toBe(true);
    expect(p).toMatchObject({ outcome: 'fulfilled', terminal: true, refundable: false, activeKey: null });
  });

  it('Rejected says why, from the reject code, and that the fee came back', () => {
    const code = `0x${Buffer.from('not-erc4626').toString('hex').padEnd(64, '0')}`;
    const p = computeProgress({ ...base, status: 'Rejected', rejectReason: code, worker: worker('rejected', { error: 'asset() reverted' }) });
    expect(p.outcome).toBe('rejected');
    expect(p.rejectCode).toBe('not-erc4626');
    expect(p.steps.at(-1)!.detail).toMatch(/not an ERC-4626 vault.*full fee was returned/);
    expect(states(p)).toMatchObject({ paid: 'done', queued: 'done', running: 'skipped', outcome: 'failed' });
    expect(p.note).toBe('Worker: asset() reverted');
  });

  it('Refunded ends the request without a result', () => {
    const p = computeProgress({ ...base, status: 'Refunded' });
    expect(p).toMatchObject({ outcome: 'refunded', terminal: true, refundable: false });
    expect(p.steps.at(-1)!.label).toBe('Refunded');
  });
});

describe('listLabel', () => {
  it('one word per request for lists', () => {
    expect(listLabel('Pending', null, false)).toEqual({ label: 'Queued', tone: 'active' });
    expect(listLabel('Pending', 'running', false)).toEqual({ label: 'Running', tone: 'active' });
    expect(listLabel('Pending', 'fulfilled', false)).toEqual({ label: 'Fulfilling', tone: 'active' });
    expect(listLabel('Pending', 'running', true)).toEqual({ label: 'Expired', tone: 'ended' });
    expect(listLabel('Fulfilled', 'attesting', false)).toEqual({ label: 'Fulfilled', tone: 'done' });
    expect(listLabel('Rejected', null, false).label).toBe('Rejected');
    expect(listLabel('Refunded', null, false).label).toBe('Refunded');
  });
});
