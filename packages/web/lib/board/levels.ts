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
 * What one failure is about, which can be more than its property id says.
 * must: a MUST sentence failed.
 * allowance: a SHOULD about allowance: the zero-allowance properties, and the "allowance" and "access control"
 * assertions inside upstream prop_withdraw and prop_redeem, which test_withdraw and test_redeem reach with a fuzzed
 * allowance (a vault that skips the check fails them).
 * rounding: a round trip off by at most max(2 base units, 1 bp of the amount): rounding in the caller's favor.
 * round-trip: a round trip off by more than that, or by an amount the report does not give; a SHOULD, but not
 * shown as rounding, since a large difference is a broken conversion rather than rounding.
 */
export type FailureTopic = 'must' | 'allowance' | 'rounding' | 'round-trip';

export interface FailureClass {
  level: PropertyLevel;
  topic: FailureTopic;
  /** For a round trip whose difference the report carries: base units in the caller's favor, and the amount compared. */
  delta?: string;
  amount?: string;
}

/** What a failure carries: its id, and when known the reason and forge's logs, or a class computed before. */
export interface FailureLike {
  id: string;
  reason?: string;
  counterexample?: { logs: ReadonlyArray<string> };
  topic?: FailureTopic;
  delta?: string;
  amount?: string;
}

/** forge-std's message for prop_withdraw and prop_redeem's allowance checks: "allowance: 5 !~= 3 (...)", "access control". */
const ALLOWANCE_ASSERTION = /^(?:allowance: |access control(?:$|;))/;
const ROUND_TRIP_ERROR = /^Error: a [<>]=~ b not satisfied/;
const LOG_VALUE = /^\s*(Value a|Value b|Delta):\s*(\d+)\s*$/;

/**
 * The difference of a failed round trip from upstream's assertApproxLeAbs / assertApproxGeAbs log lines ("Value a",
 * "Value b", "Delta"); null when the logs do not carry them.
 */
export function roundTripDifference(logs: ReadonlyArray<string> | undefined): { a: bigint; b: bigint; delta: bigint } | null {
  if (!logs || !logs.some((l) => ROUND_TRIP_ERROR.test(l))) return null;
  const v: Record<string, bigint> = {};
  for (const l of logs) {
    const m = LOG_VALUE.exec(l);
    if (m && v[m[1]!] === undefined) v[m[1]!] = BigInt(m[2]!);
  }
  if (v['Value a'] === undefined || v['Value b'] === undefined) return null;
  const a = v['Value a'];
  const b = v['Value b'];
  return { a, b, delta: v.Delta ?? (a > b ? a - b : b - a) };
}

/** At most max(2 base units, 1 bp of the larger amount). */
export function isRoundingSized(d: { a: bigint; b: bigint; delta: bigint }): boolean {
  const amount = d.a > d.b ? d.a : d.b;
  const bp = amount / 10_000n;
  return d.delta <= (bp > 2n ? bp : 2n);
}

/** The class of one failed property, from its id, its reason and forge's logs. */
export function classifyFailure(f: FailureLike): FailureClass {
  if (f.topic) return { level: f.topic === 'must' ? 'must' : 'should', topic: f.topic, ...(f.delta ? { delta: f.delta } : {}), ...(f.amount ? { amount: f.amount } : {}) };
  const should = SHOULD_PROPERTIES[f.id];
  if (should === 'allowance') return { level: 'should', topic: 'allowance' };
  if (should === 'rounding') {
    const d = roundTripDifference(f.counterexample?.logs);
    if (!d) return { level: 'should', topic: 'round-trip' };
    const amount = (d.a > d.b ? d.a : d.b).toString();
    return { level: 'should', topic: isRoundingSized(d) ? 'rounding' : 'round-trip', delta: d.delta.toString(), amount };
  }
  if ((f.id === 'withdraw' || f.id === 'redeem') && ALLOWANCE_ASSERTION.test(f.reason ?? '')) return { level: 'should', topic: 'allowance' };
  return { level: 'must', topic: 'must' };
}

/**
 * What a vault's failures amount to. must: a MUST sentence failed (a spec mismatch). rounding: only round trips
 * failed, each by a rounding-sized difference, so rounding favors the caller against EIP-4626's SHOULD guidance and
 * no MUST sentence failed. should: only SHOULD sentences failed, and not all of them rounding (an allowance check, a
 * round trip off by more, or by an amount not known). null: nothing failed.
 */
export type FailureLevel = 'must' | 'rounding' | 'should';

export function failureLevelOf(failures: ReadonlyArray<FailureLike | FailureClass>): FailureLevel | null {
  if (failures.length === 0) return null;
  const classes = failures.map((f) => ('id' in f ? classifyFailure(f) : f));
  if (classes.some((c) => c.level === 'must')) return 'must';
  return classes.every((c) => c.topic === 'rounding') ? 'rounding' : 'should';
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
