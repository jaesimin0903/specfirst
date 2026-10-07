/*
 * How binding the EIP-4626 sentence each property checks is: a MUST, or a SHOULD. Pure and dependency free, like
 * reasons.ts, which is also why the table is copied from @specfirst/core's ERC4626_PROPERTY_LEVELS rather than
 * imported (core's root pulls Node-only code into the Next bundle); test/board-levels.test.ts compares them.
 */

export type PropertyLevel = 'must' | 'should';
/** What a SHOULD property is about: the round trips (rounding guidance) or the allowance checks. */
export type ShouldTopic = 'rounding' | 'allowance';

/**
 * Every property whose EIP-4626 sentence is a SHOULD. The eight round trips come from the rounding guidance of
 * Security Considerations ("should round down", "should round up"); the two zero-allowance properties from
 * withdraw and redeem, which "SHOULD check msg.sender can spend owner funds". Every other property is a MUST.
 */
export const SHOULD_PROPERTIES: Readonly<Record<string, ShouldTopic>> = {
  'withdraw-zero-allowance': 'allowance',
  'redeem-zero-allowance': 'allowance',
  'RT-deposit-redeem': 'rounding',
  'RT-deposit-withdraw': 'rounding',
  'RT-redeem-deposit': 'rounding',
  'RT-redeem-mint': 'rounding',
  'RT-mint-withdraw': 'rounding',
  'RT-mint-redeem': 'rounding',
  'RT-withdraw-mint': 'rounding',
  'RT-withdraw-deposit': 'rounding',
};

/**
 * Property ids in report order, which is the bit order of the registry's passedBitmap and failedBitmap (core
 * ERC4626_CHECK_PROPERTIES; reports before and after the 2026-10-07 wording share it).
 */
export const PROPERTY_IDS: readonly string[] = [
  'asset',
  'totalAssets',
  'convertToShares',
  'convertToAssets',
  'maxDeposit',
  'previewDeposit',
  'deposit',
  'maxMint',
  'previewMint',
  'mint',
  'maxWithdraw',
  'previewWithdraw',
  'withdraw',
  'withdraw-zero-allowance',
  'maxRedeem',
  'previewRedeem',
  'redeem',
  'redeem-zero-allowance',
  'RT-deposit-redeem',
  'RT-deposit-withdraw',
  'RT-redeem-deposit',
  'RT-redeem-mint',
  'RT-mint-withdraw',
  'RT-mint-redeem',
  'RT-withdraw-mint',
  'RT-withdraw-deposit',
  'sf-maxDeposit-honored',
  'sf-maxMint-honored',
  'sf-maxWithdraw-honored',
  'sf-maxRedeem-honored',
];

/** The level of a property; an id outside the table counts as a MUST, so nothing unknown is ever softened. */
export function propertyLevel(id: string): PropertyLevel {
  return id in SHOULD_PROPERTIES ? 'should' : 'must';
}

export const LEVEL_LABEL: Readonly<Record<PropertyLevel, string>> = { must: 'EIP-4626 MUST', should: 'EIP-4626 SHOULD' };

/**
 * What a vault's failures amount to. must: a MUST property failed (a spec mismatch). rounding: only round trips
 * failed, so rounding favors the caller against EIP-4626's SHOULD guidance and no MUST sentence failed. should:
 * only SHOULD properties failed, and not only round trips (an allowance check). null: nothing failed.
 */
export type FailureLevel = 'must' | 'rounding' | 'should';

export function failureLevelOf(failedIds: ReadonlyArray<string>): FailureLevel | null {
  if (failedIds.length === 0) return null;
  if (failedIds.some((id) => propertyLevel(id) === 'must')) return 'must';
  return failedIds.every((id) => SHOULD_PROPERTIES[id] === 'rounding') ? 'rounding' : 'should';
}

/** The ids whose bits are set in a registry failedBitmap; null when a bit lies outside the table. */
export function idsOfBitmap(bitmap: bigint): string[] | null {
  const ids: string[] = [];
  for (let i = 0; bitmap >> BigInt(i) !== 0n; i++) {
    if (((bitmap >> BigInt(i)) & 1n) === 0n) continue;
    const id = PROPERTY_IDS[i];
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}
