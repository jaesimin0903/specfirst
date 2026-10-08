import { ERC4626_CHECK_PROPERTIES, ERC4626_PROPERTY_LEVELS } from '@specfirst/core';

/*
 * How binding each failure is, read the way the board reads it (packages/web/lib/board/levels.ts, which the web keeps
 * free of imports and so cannot export). The level table and the EIP-4626 sentences come from @specfirst/core; the
 * round trip rule below is the board's, and test/levels.test.ts runs both on the same inputs so they cannot drift.
 */

export type PropertyLevel = 'must' | 'should';
/**
 * must: a MUST sentence failed. allowance: a zero-allowance SHOULD. rounding: a round trip whose every logged pair of
 * values is within max(2 base units, 1 bp of the amount). round-trip: a round trip off by more than that, or by an
 * amount the report does not give.
 */
export type FailureTopic = 'must' | 'allowance' | 'rounding' | 'round-trip';
/** What a vault's failures amount to; 'none' when nothing failed. */
export type VaultLevel = 'must' | 'rounding' | 'should' | 'none';

/** Property ids in report order, the bit order of the registry's passedBitmap and failedBitmap. */
export const PROPERTY_IDS: readonly string[] = ERC4626_CHECK_PROPERTIES.map((p) => p.id);

/** An id outside the table counts as a MUST, so nothing unknown is ever softened. */
export function propertyLevel(id: string): PropertyLevel {
  return ERC4626_PROPERTY_LEVELS[id]?.level ?? 'must';
}

/** Where in EIP-4626 the property comes from, quoting the sentence; null for an id outside the table. */
export function eipSentence(id: string): string | null {
  const eip = ERC4626_PROPERTY_LEVELS[id]?.eip;
  return eip ? `EIP-4626, ${eip}` : null;
}

function isRoundTrip(id: string): boolean {
  return id.startsWith('RT-') && propertyLevel(id) === 'should';
}

const ROUND_TRIP_ERROR = /^Error: a [<>]=~ b not satisfied/;
const LOG_VALUE = /^\s*(Value a|Value b):\s*(\d+)\s*$/;

export interface ValuePair {
  a: bigint;
  b: bigint;
  /** |a - b|, computed here: a "Delta" line in the logs is not read, the vault could have written it. */
  delta: bigint;
}

/** Every "Value a" / "Value b" pair in a failed round trip's logs, in order; empty without an assertion error. */
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

/** At most max(2 base units, 1 bp of the larger amount). */
export function isRoundingSized(d: ValuePair): boolean {
  const amount = d.a > d.b ? d.a : d.b;
  const bp = amount / 10_000n;
  return d.delta <= (bp > 2n ? bp : 2n);
}

export interface FailureClass {
  level: PropertyLevel;
  topic: FailureTopic;
  /** For a round trip whose logs carry values: the largest difference in base units, and the amount of that pair. */
  delta?: string;
  amount?: string;
}

/**
 * The class of one failed property. withdraw and redeem failures are MUSTs whatever their reason says, and a round
 * trip is rounding only when every pair of values in its logs is within the bound, so text or logs a vault controls
 * can only make a failure stricter.
 */
export function classifyFailure(f: { id: string; counterexample?: { logs?: ReadonlyArray<string> } }): FailureClass {
  if (propertyLevel(f.id) === 'must') return { level: 'must', topic: 'must' };
  if (!isRoundTrip(f.id)) return { level: 'should', topic: 'allowance' };
  const pairs = valuePairs(f.counterexample?.logs);
  let best: ValuePair | null = null;
  for (const p of pairs) if (!best || p.delta > best.delta) best = p;
  if (!best) return { level: 'should', topic: 'round-trip' };
  const amount = (best.a > best.b ? best.a : best.b).toString();
  return { level: 'should', topic: pairs.every(isRoundingSized) ? 'rounding' : 'round-trip', delta: best.delta.toString(), amount };
}

/** must if a MUST failed; rounding if only round trips failed, each by a rounding-sized difference; else should. */
export function vaultLevelOf(classes: ReadonlyArray<FailureClass>): VaultLevel {
  if (classes.length === 0) return 'none';
  if (classes.some((c) => c.level === 'must')) return 'must';
  return classes.every((c) => c.topic === 'rounding') ? 'rounding' : 'should';
}

/** The ids whose bits are set in a registry bitmap; an index past the table becomes "bit <i>" and counts as a MUST. */
export function idsOfBitmap(bitmap: bigint): string[] {
  const ids: string[] = [];
  for (let i = 0; bitmap >> BigInt(i) !== 0n; i++) {
    if (((bitmap >> BigInt(i)) & 1n) === 1n) ids.push(PROPERTY_IDS[i] ?? `bit ${i}`);
  }
  return ids;
}
