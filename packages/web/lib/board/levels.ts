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
 * allowance: a SHOULD about allowance, the zero-allowance properties. withdraw and redeem failures are MUSTs whatever
 * their reason says, even when an allowance assertion failed: the reason text can come from the vault itself (a view
 * that reverts with "access control"), and a label the vault can steer must never soften the verdict. A vault that
 * only skips the allowance check is told apart by the zero-allowance properties.
 * rounding: a round trip whose every logged pair of values is within max(2 base units, 1 bp of the amount):
 * rounding in the caller's favor.
 * round-trip: a round trip off by more than that in any pair, or by an amount the report does not give; a SHOULD,
 * but not shown as rounding, since a large difference is a broken conversion rather than rounding.
 */
export type FailureTopic = 'must' | 'allowance' | 'rounding' | 'round-trip';

export interface FailureClass {
  level: PropertyLevel;
  topic: FailureTopic;
  /** For a round trip whose logs carry values: the largest difference in base units, and the amount of that pair. */
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

const ROUND_TRIP_ERROR = /^Error: a [<>]=~ b not satisfied/;
const LOG_VALUE = /^\s*(Value a|Value b):\s*(\d+)\s*$/;

export interface ValuePair {
  a: bigint;
  b: bigint;
  /** |a - b|, computed here: a "Delta" line in the logs is not read, the vault could have written it. */
  delta: bigint;
}

/**
 * Every "Value a" / "Value b" pair in a failed round trip's logs, in order: upstream's assertApproxLeAbs and
 * assertApproxGeAbs write one, and a vault's own console.log lines may add others. Empty when the logs carry no
 * assertion error or no complete pair.
 */
export function valuePairs(logs: ReadonlyArray<string> | undefined): ValuePair[] {
  if (!logs || !logs.some((l) => ROUND_TRIP_ERROR.test(l))) return [];
  const pairs: ValuePair[] = [];
  let a: bigint | null = null;
  for (const l of logs) {
    const m = LOG_VALUE.exec(l);
    if (!m) continue;
    const v = BigInt(m[2]!);
    if (m[1] === 'Value a') a = v;
    else if (a !== null) {
      pairs.push({ a, b: v, delta: a > v ? a - v : v - a });
      a = null;
    }
  }
  return pairs;
}

/** The pair with the largest difference, which is what a round trip is judged and described by; null when none. */
export function roundTripDifference(logs: ReadonlyArray<string> | undefined): ValuePair | null {
  let best: ValuePair | null = null;
  for (const p of valuePairs(logs)) if (!best || p.delta > best.delta) best = p;
  return best;
}

/** At most max(2 base units, 1 bp of the larger amount). */
export function isRoundingSized(d: { a: bigint; b: bigint; delta: bigint }): boolean {
  const amount = d.a > d.b ? d.a : d.b;
  const bp = amount / 10_000n;
  return d.delta <= (bp > 2n ? bp : 2n);
}

/**
 * The class of one failed property, from its id and, for a round trip, forge's logs. A round trip is rounding only
 * when every pair of values in its logs is within the bound, so pairs a vault injects can only make it stricter.
 */
export function classifyFailure(f: FailureLike): FailureClass {
  if (f.topic) return { level: f.topic === 'must' ? 'must' : 'should', topic: f.topic, ...(f.delta ? { delta: f.delta } : {}), ...(f.amount ? { amount: f.amount } : {}) };
  const should = SHOULD_PROPERTIES[f.id];
  if (should === 'allowance') return { level: 'should', topic: 'allowance' };
  if (should === 'rounding') {
    const pairs = valuePairs(f.counterexample?.logs);
    const d = roundTripDifference(f.counterexample?.logs);
    if (!d) return { level: 'should', topic: 'round-trip' };
    const amount = (d.a > d.b ? d.a : d.b).toString();
    return { level: 'should', topic: pairs.every(isRoundingSized) ? 'rounding' : 'round-trip', delta: d.delta.toString(), amount };
  }
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
