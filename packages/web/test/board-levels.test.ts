// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ERC4626_CHECK_PROPERTIES, ERC4626_PROPERTY_LEVELS } from '@specfirst/core';
import { classifyFailure, failureLevelOf, idsOfBitmap, isRoundingSized, PROPERTY_IDS, propertyLevel, roundTripDifference, SHOULD_PROPERTIES } from '../lib/board/levels';
import { describeFailure, percentOf, verdictSentence, vaultLabel, WITHDRAW_REDEEM_NOTE } from '../lib/board/reasons';
import { checkBadgeOf } from '../lib/desk/checkBadge';
import type { AttestationRecord } from '../lib/board/types';

/* EIP-4626 levels on the board: the copy of core's table, each failure's class, the verdict, the label and the badge. */

const SUMMARY = (fail: number) => ({ pass: 30 - fail, fail, inconclusive: 0, notApplicable: 0 });
const rt = (id: string, a: number, b: number, delta: number) => ({
  id,
  reason: 'Error: a <=~ b not satisfied [uint]',
  counterexample: { logs: ['Error: a <=~ b not satisfied [uint]', `   Value a: ${a}`, `   Value b: ${b}`, ' Max Delta: 0', `     Delta: ${delta}`] },
});
const TY_YIELD = [rt('RT-redeem-deposit', 1000001, 1000000, 1), rt('RT-redeem-mint', 999999, 1000000, 1), rt('RT-withdraw-deposit', 1000001, 1000000, 1)];

describe('the level table', () => {
  it("is core's: the same SHOULD properties and the same bit order", () => {
    const coreShould = Object.entries(ERC4626_PROPERTY_LEVELS)
      .filter(([, v]) => v.level === 'should')
      .map(([id]) => id)
      .sort();
    expect(Object.keys(SHOULD_PROPERTIES).sort()).toEqual(coreShould);
    expect(PROPERTY_IDS).toEqual(ERC4626_CHECK_PROPERTIES.map((p) => p.id));
    for (const id of PROPERTY_IDS) expect(propertyLevel(id), id).toBe(ERC4626_PROPERTY_LEVELS[id]!.level);
    for (const [id, topic] of Object.entries(SHOULD_PROPERTIES)) expect(topic, id).toBe(id.startsWith('RT-') ? 'rounding' : 'allowance');
  });

  it('an unknown id counts as a MUST, so nothing is softened by mistake', () => {
    expect(propertyLevel('test_new_thing')).toBe('must');
    expect(failureLevelOf([...TY_YIELD, { id: 'test_new_thing' }])).toBe('must');
  });
});

describe('the class of one failure', () => {
  it('withdraw and redeem are MUSTs whatever their reason says: a vault can make its own revert read "access control"', () => {
    expect(classifyFailure({ id: 'withdraw', reason: 'access control' })).toEqual({ level: 'must', topic: 'must' });
    expect(classifyFailure({ id: 'redeem', reason: 'allowance: 5000 !~= 0 (max delta: 0, real delta: 5000)' })).toEqual({ level: 'must', topic: 'must' });
    expect(classifyFailure({ id: 'withdraw', reason: 'share: 7000 !~= 6000 (max delta: 0, real delta: 1000)' })).toEqual({ level: 'must', topic: 'must' });
    expect(classifyFailure({ id: 'redeem', reason: 'asset: 1 !~= 2 (max delta: 0, real delta: 1)' })).toEqual({ level: 'must', topic: 'must' });
    expect(classifyFailure({ id: 'withdraw' })).toEqual({ level: 'must', topic: 'must' });
    // The label only counts for withdraw and redeem.
    expect(classifyFailure({ id: 'deposit', reason: 'access control' })).toEqual({ level: 'must', topic: 'must' });
    expect(classifyFailure({ id: 'withdraw-zero-allowance', reason: 'assertion failed' })).toEqual({ level: 'should', topic: 'allowance' });
    expect(describeFailure('access control', { id: 'withdraw', reason: 'access control' }).rule).toBe(WITHDRAW_REDEEM_NOTE);
    expect(WITHDRAW_REDEEM_NOTE).toMatch(/withdraw-zero-allowance and redeem-zero-allowance, which are SHOULDs/);
  });

  it("a pair the vault writes with console.log can only make a round trip stricter: every pair must be small", () => {
    const real = ['Error: a <=~ b not satisfied [uint]', '   Value a: 5000000', '   Value b: 1000000', ' Max Delta: 0', '     Delta: 4000000'];
    const injected = ['Value a: 1000001', 'Value b: 1000000', '     Delta: 1'];
    for (const logs of [[...injected, ...real], [...real, ...injected]]) {
      expect(classifyFailure({ id: 'RT-deposit-redeem', reason: real[0], counterexample: { logs } })).toEqual({ level: 'should', topic: 'round-trip', delta: '4000000', amount: '5000000' });
    }
    // A large injected pair next to a 1-unit assertion: not rounding either.
    const small = ['Error: a <=~ b not satisfied [uint]', '   Value a: 1000001', '   Value b: 1000000', ' Max Delta: 0', '     Delta: 1'];
    expect(classifyFailure({ id: 'RT-deposit-redeem', counterexample: { logs: ['Value a: 9', 'Value b: 900', ...small] } }).topic).toBe('round-trip');
    // A "Delta" line is not believed: the difference comes from the pair.
    expect(classifyFailure({ id: 'RT-deposit-redeem', counterexample: { logs: ['Error: a <=~ b not satisfied [uint]', '   Value a: 5000000', '   Value b: 1000000', '     Delta: 1'] } })).toMatchObject({ topic: 'round-trip', delta: '4000000' });
  });

  it('a round trip is rounding up to max(2 base units, 1 bp of the amount), more is a round trip off by more, no size is unknown', () => {
    expect(classifyFailure(rt('RT-redeem-mint', 999999, 1000000, 1))).toEqual({ level: 'should', topic: 'rounding', delta: '1', amount: '1000000' });
    expect(classifyFailure(rt('RT-redeem-mint', 98, 100, 2)).topic).toBe('rounding');
    expect(classifyFailure(rt('RT-redeem-mint', 97, 100, 3)).topic).toBe('round-trip');
    expect(classifyFailure(rt('RT-deposit-redeem', 1_000_100, 1_000_000, 100)).topic).toBe('rounding'); // exactly 1 bp
    expect(classifyFailure(rt('RT-deposit-redeem', 1_000_101, 1_000_000, 101)).topic).toBe('round-trip'); // 1 bp of 1,000,101 is 100.01
    expect(classifyFailure(rt('RT-deposit-redeem', 1_050_000, 1_000_000, 50_000))).toEqual({ level: 'should', topic: 'round-trip', delta: '50000', amount: '1050000' });
    expect(classifyFailure({ id: 'RT-mint-redeem', reason: 'Error: a <=~ b not satisfied [uint]', counterexample: { logs: ['Error: a <=~ b not satisfied [uint]'] } })).toEqual({ level: 'should', topic: 'round-trip' });
    expect(roundTripDifference(undefined)).toBeNull();
    expect(isRoundingSized({ a: 3n, b: 0n, delta: 3n })).toBe(false);
  });

  it('a class computed at build is taken as it is', () => {
    expect(classifyFailure({ id: 'RT-redeem-mint', topic: 'rounding', delta: '1', amount: '1000000' })).toEqual({ level: 'should', topic: 'rounding', delta: '1', amount: '1000000' });
    expect(failureLevelOf([{ id: 'withdraw', topic: 'allowance' }])).toBe('should');
  });

  it('classifies a vault: any MUST, only rounding, only SHOULDs, nothing', () => {
    expect(failureLevelOf(TY_YIELD)).toBe('rounding');
    expect(failureLevelOf([{ id: 'previewDeposit' }, ...TY_YIELD])).toBe('must');
    expect(failureLevelOf([rt('RT-deposit-redeem', 1_050_000, 1_000_000, 50_000)])).toBe('should');
    expect(failureLevelOf([{ id: 'RT-redeem-mint' }])).toBe('should'); // no size: not shown as rounding
    expect(failureLevelOf([{ id: 'withdraw', reason: 'access control' }])).toBe('must');
    expect(failureLevelOf([{ id: 'withdraw-zero-allowance' }])).toBe('should');
    expect(failureLevelOf([])).toBeNull();
  });

  it('reads the ids of a failedBitmap in report order', () => {
    const bits = TY_YIELD.reduce((m, f) => m | (1n << BigInt(PROPERTY_IDS.indexOf(f.id))), 0n);
    expect(idsOfBitmap(bits)).toEqual(TY_YIELD.map((f) => f.id));
    expect(idsOfBitmap(0n)).toEqual([]);
    expect(idsOfBitmap(1n << 40n)).toBeNull();
  });
});

describe('verdict and labels', () => {
  it('a MUST failure keeps the spec mismatch sentence', () => {
    expect(verdictSentence('mismatch', SUMMARY(2), '109195820', [{ id: 'sf-maxWithdraw-honored' }, { id: 'sf-maxRedeem-honored' }])).toBe(
      "2 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.",
    );
    expect(verdictSentence('mismatch', SUMMARY(1), '1', [{ id: 'withdraw', reason: 'share: 7000 !~= 6000 (max delta: 0, real delta: 1000)' }])).toMatch(/contradicts an EIP-4626 MUST sentence/);
    expect(verdictSentence('mismatch', SUMMARY(3), '1')).toMatch(/contradicts an EIP-4626 MUST sentence/);
    expect(vaultLabel('mismatch', 'must')).toBe('Spec mismatch');
  });

  it('round trips off by a rounding difference: rounding favors the caller, with the size', () => {
    expect(verdictSentence('mismatch', SUMMARY(3), '110000000', TY_YIELD)).toBe(
      "Rounding favors the caller: 3 round-trip properties fail EIP-4626's SHOULD guidance (Security Considerations) at block 110,000,000, by at most 1 base unit, <0.01% of the amount; no MUST sentence failed.",
    );
    // The share of the amount is that of the largest difference; a class without the amount gives the size alone.
    expect(verdictSentence('mismatch', SUMMARY(2), '7', [TY_YIELD[0]!, rt('RT-deposit-redeem', 1e15, 1e15 - 13_080_554, 13_080_554)])).toBe(
      "Rounding favors the caller: 2 round-trip properties fail EIP-4626's SHOULD guidance (Security Considerations) at block 7, by at most 13,080,554 base units, <0.01% of the amount; no MUST sentence failed.",
    );
    expect(verdictSentence('mismatch', SUMMARY(1), '7', [rt('RT-redeem-mint', 98, 100, 2)])).toMatch(/, by at most 2 base units, 2% of the amount; no MUST sentence failed\.$/);
    expect(verdictSentence('mismatch', SUMMARY(1), '7', [{ id: 'RT-redeem-mint', topic: 'rounding', delta: '1' }])).toMatch(/at block 7, by at most 1 base unit; no MUST sentence failed\.$/);
    expect(vaultLabel('mismatch', 'rounding')).toBe('Rounding favors caller');
    expect(describeFailure(TY_YIELD[0]!.reason, TY_YIELD[0]).finding).toBe("Forge found a counterexample: the round trip ended 1 base unit in the caller's favor (1,000,001 against 1,000,000).");
    expect(describeFailure(TY_YIELD[0]!.reason, TY_YIELD[0]).rule).toMatch(/rounding should favor the Vault over its users\. That is a SHOULD, not a MUST/);
  });

  it('a round trip off by more keeps the mismatch chip and says by how much', () => {
    const big = rt('RT-deposit-redeem', 1_050_000, 1_000_000, 50_000);
    expect(verdictSentence('mismatch', SUMMARY(1), '7', [big])).toBe(
      '1 of 30 properties failed at block 7, all of them EIP-4626 SHOULD sentences: a round trip favors the caller by 50,000 base units, 4.76% of the amount, more than rounding. No MUST sentence failed.',
    );
    expect(vaultLabel('mismatch', 'should')).toBe('Spec mismatch');
    expect(describeFailure(big.reason, big).rule).toBe("EIP-4626's rounding guidance is a SHOULD, but a difference of 50,000 base units, 4.76% of the amount, is more than rounding.");
    expect(verdictSentence('mismatch', SUMMARY(1), '7', [{ id: 'RT-mint-redeem' }])).toMatch(/a round trip favors the caller by an amount the report does not give\. No MUST sentence failed\./);
    expect(percentOf('1', '1000000')).toBe('<0.01%');
    expect(percentOf('5', '100')).toBe('5%');
  });

  it('an allowance SHOULD (the zero-allowance properties) says what went through', () => {
    expect(verdictSentence('mismatch', SUMMARY(2), '5', [{ id: 'withdraw-zero-allowance' }, TY_YIELD[0]!])).toBe(
      "2 of 30 properties failed at block 5, all of them EIP-4626 SHOULD sentences: 1 withdraw or redeem for an owner went through without the owner's allowance, which the vault SHOULD check; a round trip favors the caller by a rounding difference. No MUST sentence failed.",
    );
    expect(verdictSentence('mismatch', SUMMARY(1), '5', [{ id: 'withdraw', reason: 'access control' }])).toMatch(/contradicts an EIP-4626 MUST sentence/);
    expect(describeFailure('assertion failed', { id: 'redeem-zero-allowance' }).rule).toMatch(/SHOULD check that the caller may spend the owner's shares/);
    expect(describeFailure(undefined, { id: 'previewDeposit' }).rule).toBeNull();
  });
});

describe('check badge', () => {
  const record = (fail: number, failedBitmap?: string): AttestationRecord => ({
    id: '7',
    status: 'Valid',
    compliant: false,
    blockNumber: '1',
    reportHash: `0x${'ab'.repeat(32)}`,
    suiteHash: `0x${'cd'.repeat(32)}`,
    implementationKey: `0x${'ef'.repeat(32)}`,
    subjectCodeHash: `0x${'12'.repeat(32)}`,
    counts: SUMMARY(fail),
    issuedAt: '2026-10-07T00:00:00.000Z',
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    reportURI: 'x',
    txHash: null,
    ...(failedBitmap ? { failedBitmap } : {}),
  });
  const bits = (ids: string[]) => `0x${ids.reduce((m, id) => m | (1n << BigInt(PROPERTY_IDS.indexOf(id))), 0n).toString(16)}`;

  it('the state stays mismatch for any failure; level says SHOULD only when every failed bit is a SHOULD property', () => {
    expect(checkBadgeOf({ kind: 'attested', record: record(3, bits(TY_YIELD.map((f) => f.id))) })).toEqual({
      state: 'mismatch',
      text: 'mismatch, 3 of 30 fail, SHOULD only',
      attestationId: '7',
      level: 'should',
    });
    expect(checkBadgeOf({ kind: 'attested', record: record(2, bits(['previewDeposit', 'RT-deposit-redeem'])) })).toEqual({ state: 'mismatch', text: 'mismatch, 2 of 30 fail', attestationId: '7', level: 'must' });
    // No bitmap, or one that does not match the count: a MUST, as before.
    expect(checkBadgeOf({ kind: 'attested', record: record(3) })).toMatchObject({ state: 'mismatch', level: 'must' });
    expect(checkBadgeOf({ kind: 'attested', record: record(4, bits(TY_YIELD.map((f) => f.id))) })).toMatchObject({ state: 'mismatch', level: 'must' });
    // withdraw's bit cannot say which assertion failed: a MUST.
    expect(checkBadgeOf({ kind: 'attested', record: record(1, bits(['withdraw'])) })).toMatchObject({ level: 'must' });
  });
});
