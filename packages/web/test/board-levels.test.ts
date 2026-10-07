// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ERC4626_CHECK_PROPERTIES, ERC4626_PROPERTY_LEVELS } from '@specfirst/core';
import { failureLevelOf, idsOfBitmap, PROPERTY_IDS, propertyLevel, SHOULD_PROPERTIES } from '../lib/board/levels';
import { describeFailure, verdictSentence, vaultLabel } from '../lib/board/reasons';
import { checkBadgeOf } from '../lib/desk/checkBadge';
import type { AttestationRecord } from '../lib/board/types';

/* EIP-4626 levels on the board: the copy of core's table, the verdict sentence, the chip label and the badge. */

const SUMMARY = (fail: number) => ({ pass: 30 - fail, fail, inconclusive: 0, notApplicable: 0 });
const TY_YIELD = ['RT-redeem-deposit', 'RT-redeem-mint', 'RT-withdraw-deposit'];

describe('the level table', () => {
  it("is core's: the same SHOULD properties and the same bit order", () => {
    const coreShould = Object.entries(ERC4626_PROPERTY_LEVELS)
      .filter(([, v]) => v.level === 'should')
      .map(([id]) => id)
      .sort();
    expect(Object.keys(SHOULD_PROPERTIES).sort()).toEqual(coreShould);
    expect(PROPERTY_IDS).toEqual(ERC4626_CHECK_PROPERTIES.map((p) => p.id));
    for (const id of PROPERTY_IDS) expect(propertyLevel(id), id).toBe(ERC4626_PROPERTY_LEVELS[id]!.level);
    // Round trips are rounding; the two SHOULDs that are not are the allowance checks.
    for (const [id, topic] of Object.entries(SHOULD_PROPERTIES)) expect(topic, id).toBe(id.startsWith('RT-') ? 'rounding' : 'allowance');
  });

  it('an unknown id counts as a MUST, so nothing is softened by mistake', () => {
    expect(propertyLevel('test_new_thing')).toBe('must');
    expect(failureLevelOf(['RT-redeem-mint', 'test_new_thing'])).toBe('must');
  });

  it('classifies failures: any MUST, only round trips, only SHOULDs, nothing', () => {
    expect(failureLevelOf(TY_YIELD)).toBe('rounding');
    expect(failureLevelOf(['previewDeposit', 'RT-deposit-redeem'])).toBe('must');
    expect(failureLevelOf(['sf-maxWithdraw-honored'])).toBe('must');
    expect(failureLevelOf(['withdraw-zero-allowance', 'RT-redeem-mint'])).toBe('should');
    expect(failureLevelOf([])).toBeNull();
  });

  it('reads the ids of a failedBitmap in report order', () => {
    const bits = TY_YIELD.reduce((m, id) => m | (1n << BigInt(PROPERTY_IDS.indexOf(id))), 0n);
    expect(idsOfBitmap(bits)).toEqual(TY_YIELD);
    expect(idsOfBitmap(0n)).toEqual([]);
    expect(idsOfBitmap(1n << 40n)).toBeNull();
  });
});

describe('verdict and labels', () => {
  it('a MUST failure keeps the spec mismatch sentence', () => {
    expect(verdictSentence('mismatch', SUMMARY(2), '109195820', ['sf-maxWithdraw-honored', 'sf-maxRedeem-honored'])).toBe(
      "2 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.",
    );
    expect(verdictSentence('mismatch', SUMMARY(2), '109195820', ['previewDeposit', 'RT-deposit-redeem'])).toMatch(/contradicts an EIP-4626 MUST sentence/);
    // Without the ids nothing is known about the levels: the MUST sentence, as before.
    expect(verdictSentence('mismatch', SUMMARY(3), '1')).toMatch(/contradicts an EIP-4626 MUST sentence/);
    expect(vaultLabel('mismatch', 'must')).toBe('Spec mismatch');
  });

  it('only round trips: rounding favors the caller, no MUST sentence failed', () => {
    expect(verdictSentence('mismatch', SUMMARY(3), '110000000', TY_YIELD)).toBe(
      "Rounding favors the caller: 3 round-trip properties fail EIP-4626's SHOULD guidance (Security Considerations) at block 110,000,000; no MUST sentence failed.",
    );
    expect(vaultLabel('mismatch', 'rounding')).toBe('Rounding favors caller');
    expect(vaultLabel('complete', null)).toBe('All passed');
    expect(describeFailure('assertion failed: 1000001 > 1000000', 'RT-redeem-deposit').rule).toMatch(/rounding should favor the Vault over its users\. That is a SHOULD, not a MUST/);
  });

  it('an allowance SHOULD names what went through and keeps the spec mismatch chip', () => {
    expect(verdictSentence('mismatch', SUMMARY(2), '5', ['withdraw-zero-allowance', 'RT-redeem-mint'])).toBe(
      '2 of 30 properties failed at block 5, all of them EIP-4626 SHOULD sentences: 1 withdraw or redeem on behalf of an owner went through without allowance, which the vault SHOULD check, and 1 round trip favors the caller against the SHOULD rounding guidance. No MUST sentence failed.',
    );
    expect(vaultLabel('mismatch', 'should')).toBe('Spec mismatch');
    expect(describeFailure(undefined, 'redeem-zero-allowance').rule).toMatch(/SHOULD check that the caller may spend the owner's shares/);
    expect(describeFailure(undefined, 'previewDeposit').rule).toBeNull();
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

  it('only round trips in the failedBitmap: its own text and state', () => {
    expect(checkBadgeOf({ kind: 'attested', record: record(3, bits(TY_YIELD)) })).toEqual({ state: 'rounding', text: 'rounding favors caller, 3 of 30 fail', attestationId: '7' });
  });

  it('a MUST in the bitmap, or no bitmap at all, is a mismatch as before', () => {
    expect(checkBadgeOf({ kind: 'attested', record: record(2, bits(['previewDeposit', 'RT-deposit-redeem'])) })).toMatchObject({ state: 'mismatch', text: 'mismatch, 2 of 30 fail' });
    expect(checkBadgeOf({ kind: 'attested', record: record(3) })).toMatchObject({ state: 'mismatch' });
    // A bitmap that does not match the fail count is not trusted to soften anything.
    expect(checkBadgeOf({ kind: 'attested', record: record(4, bits(TY_YIELD)) })).toMatchObject({ state: 'mismatch' });
  });
});
