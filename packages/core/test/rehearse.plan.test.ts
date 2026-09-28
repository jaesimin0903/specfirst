import { describe, expect, it } from 'vitest';
import { judgeRevertReceipt, passedBitmap, planRehearsal, reportHash, chunkRanges, gasLimitFor, TX_GAS_CAP, withMargin } from '../src/index.js';

describe('planRehearsal', () => {
  const steps = planRehearsal({ users: 3, normal: 25, revert: 5, attacker: true });

  it('has 25 normal and 5 revert-expected steps covering all five kinds', () => {
    expect(steps.filter((s) => !s.expectRevert)).toHaveLength(25);
    const kinds = steps.filter((s) => s.expectRevert).map((s) => (s.expectRevert ? s.kind : ''));
    expect(kinds.sort()).toEqual(['deposit-while-paused', 'overdraw-withdraw', 'reentry', 'unauthorized-pause', 'unauthorized-set-reward-rate']);
  });

  it('puts deposit-while-paused between a pause and its unpause', () => {
    const i = steps.findIndex((s) => s.expectRevert && s.kind === 'deposit-while-paused');
    const prev = steps[i - 1]!;
    const next = steps[i + 1]!;
    expect(!prev.expectRevert && prev.action.kind).toBe('pause');
    expect(!next.expectRevert && next.action.kind).toBe('unpause');
  });

  it('attempts reentry only after the attacker contract has deposited', () => {
    const i = steps.findIndex((s) => s.expectRevert && s.kind === 'reentry');
    expect(steps.slice(0, i).some((s) => !s.expectRevert && s.action.kind === 'attacker-deposit')).toBe(true);
  });

  it('never leaves the vault paused', () => {
    let paused = false;
    for (const s of steps) if (!s.expectRevert && (s.action.kind === 'pause' || s.action.kind === 'unpause')) paused = s.action.kind === 'pause';
    expect(paused).toBe(false);
  });

  it('drops attacker steps when the spec has no attacker', () => {
    const plain = planRehearsal({ users: 2, normal: 10, revert: 4, attacker: false });
    expect(plain.some((s) => (s.expectRevert ? s.kind === 'reentry' : s.action.kind.startsWith('attacker')))).toBe(false);
    expect(plain.filter((s) => s.expectRevert)).toHaveLength(4);
  });
});

describe('revert verdict', () => {
  it('status 0 below the limit is a revert; at the limit it is out of gas; success is unexpected', () => {
    expect(judgeRevertReceipt({ status: 'reverted', gasUsed: 23_000n }, 80_000n)).toBe('reverted');
    expect(judgeRevertReceipt({ status: 'reverted', gasUsed: 22_000n }, 22_000n)).toBe('out-of-gas');
    expect(judgeRevertReceipt({ status: 'success', gasUsed: 30_000n }, 80_000n)).toBe('unexpected-success');
  });
});

describe('gas policy', () => {
  it('uses estimate x 1.2 rounded up and refuses limits at or above 16,777,216', () => {
    expect(withMargin(100_000n)).toBe(120_000n);
    expect(withMargin(100_001n)).toBe(120_002n);
    expect(gasLimitFor(1_000_000n)).toBe(1_200_000n);
    expect(() => gasLimitFor(TX_GAS_CAP)).toThrow(/cap/);
    expect(() => gasLimitFor(13_981_014n)).toThrow(/cap/);
  });
});

describe('chunkRanges', () => {
  it('covers the range with no gap or overlap at chunk boundaries', () => {
    expect(chunkRanges(10n, 17n, 3n)).toEqual([[10n, 12n], [13n, 15n], [16n, 17n]]);
    expect(chunkRanges(5n, 5n, 100n)).toEqual([[5n, 5n]]);
    expect(chunkRanges(6n, 5n, 3n)).toEqual([]);
  });
});

describe('report hashing', () => {
  it('passedBitmap sets bit i for invariant i', () => {
    expect(passedBitmap([true, true, false, true])).toBe(0b1011n);
    expect(passedBitmap(Array(7).fill(true))).toBe(127n);
  });

  it('reportHash ignores key order and changes with content', () => {
    const a = reportHash({ b: 1, a: { d: [1, 2], c: 'x' } });
    const b = reportHash({ a: { c: 'x', d: [1, 2] }, b: 1 });
    expect(a).toBe(b);
    expect(reportHash({ a: { c: 'y', d: [1, 2] }, b: 1 })).not.toBe(a);
  });
});
