import type { Hex } from 'viem';
import { STANDARD_PROPERTIES } from '../attest/params.js';
import { ATTESTATION_STATUS, type Attestation } from '../attest/registry.js';
import type { StandardCheckReport, StandardName } from '../standards/report.js';
import type { CheckChange, CheckChangeKind, WatchSummary } from './schema.js';

/** What a check says about a subject, in the terms the attest rule compares (docs/adr/0006, "Pipeline"). */
export interface CheckOutcome {
  summary: WatchSummary;
  /** Ids of the failed properties, sorted. */
  failed: string[];
  /** Lowercase; null only for a previous check recorded without one. */
  implementationKey: Hex | null;
}

export function outcomeOfReport(report: StandardCheckReport): CheckOutcome {
  return {
    summary: { ...report.summary },
    failed: report.results.filter((r) => r.status === 'fail').map((r) => r.id).sort(),
    implementationKey: report.identity.implementationKey.toLowerCase() as Hex,
  };
}

/**
 * The outcome an attestation records: its four counts, the ids of the bits of failedBitmap (bit i is
 * property i of the standard's table, which attest enforces) and its implementation key.
 */
export function outcomeOfAttestation(
  a: Pick<Attestation, 'passCount' | 'failCount' | 'inconclusiveCount' | 'notApplicableCount' | 'failedBitmap' | 'implementationKey'>,
  standard: StandardName = 'erc4626',
): CheckOutcome {
  const table = STANDARD_PROPERTIES[standard];
  const failed: string[] = [];
  for (let i = 0; i < 256; i++) {
    if ((a.failedBitmap >> BigInt(i)) & 1n) failed.push(table[i]?.id ?? `bit${i}`);
  }
  return {
    summary: { pass: a.passCount, fail: a.failCount, inconclusive: a.inconclusiveCount, notApplicable: a.notApplicableCount },
    failed: failed.sort(),
    implementationKey: a.implementationKey.toLowerCase() as Hex,
  };
}

function sameSummary(a: WatchSummary, b: WatchSummary): boolean {
  return a.pass === b.pass && a.fail === b.fail && a.inconclusive === b.inconclusive && a.notApplicable === b.notApplicable;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The parts in which two outcomes differ: "counts", "failed", "implementation key". Empty when they agree. */
export function outcomeDiff(a: CheckOutcome, b: CheckOutcome): string[] {
  const out: string[] = [];
  if (!sameSummary(a.summary, b.summary)) out.push('counts');
  if (!sameIds(a.failed, b.failed)) out.push('failed');
  if ((a.implementationKey ?? '').toLowerCase() !== (b.implementationKey ?? '').toLowerCase()) out.push('implementation key');
  return out;
}

export type AttestDecision =
  | { attest: true; supersedes: bigint | null; reason: string }
  /** newer: the latest Valid attestation is of a later block than the check, which it supersedes. */
  | { attest: false; reason: string; newer?: { id: bigint; block: bigint } };

/**
 * The attest rule (docs/adr/0006, "Pipeline"): attest when the subject has no Valid attestation for the
 * standard (none at all, or the latest is Revoked), or when the outcome differs from the latest Valid one in
 * the four counts, the set of failed property ids or the implementation key, whoever issued it. An unchanged
 * outcome is not attested. A latest Valid attestation of a later block than the check supersedes the check
 * (`newer`): the registry refuses an older block (OlderThanLatest) while the latest is Valid.
 */
export function attestDecision(outcome: CheckOutcome, latest: { id: bigint; attestation: Attestation } | null, checkBlock: bigint): AttestDecision {
  if (!latest) return { attest: true, supersedes: null, reason: 'no attestation of the subject yet' };
  const status = ATTESTATION_STATUS[latest.attestation.status] ?? String(latest.attestation.status);
  if (status !== 'Valid') return { attest: true, supersedes: null, reason: `the latest attestation ${latest.id} is ${status}` };
  if (latest.attestation.blockNumber > checkBlock) {
    return {
      attest: false,
      reason: `attestation ${latest.id} is for a later block (${latest.attestation.blockNumber}) than this check (${checkBlock})`,
      newer: { id: latest.id, block: latest.attestation.blockNumber },
    };
  }
  const diff = outcomeDiff(outcome, outcomeOfAttestation(latest.attestation));
  if (diff.length === 0) return { attest: false, reason: `unchanged since attestation ${latest.id}` };
  return { attest: true, supersedes: latest.id, reason: `${diff.join(', ')} differ from attestation ${latest.id}` };
}

/**
 * How `next` differs from the subject's previous check, or null when it does not (docs/adr/0006 change
 * kinds, defined in CHECK_CHANGE_KINDS): new without a previous check; regressed when a property fails that did
 * not; recovered when none newly fails and one stopped failing; changed for other count changes;
 * implementation when only the implementation key moved.
 */
export function changeOf(prev: CheckOutcome | null, next: CheckOutcome): CheckChange | null {
  const to = { summary: { ...next.summary }, failed: [...next.failed] };
  if (!prev) return { kind: 'new', from: null, to };
  const from = { summary: { ...prev.summary }, failed: [...prev.failed] };
  const before = new Set(prev.failed);
  const after = new Set(next.failed);
  if (next.failed.some((id) => !before.has(id))) return { kind: 'regressed', from, to };
  if (prev.failed.some((id) => !after.has(id))) return { kind: 'recovered', from, to };
  if (!sameSummary(prev.summary, next.summary)) return { kind: 'changed', from, to };
  if ((prev.implementationKey ?? '').toLowerCase() !== (next.implementationKey ?? '').toLowerCase()) return { kind: 'implementation', from, to };
  return null;
}

/** Whether two outcomes agree in counts, failed ids and implementation key. */
export function sameOutcome(a: CheckOutcome, b: CheckOutcome): boolean {
  return outcomeDiff(a, b).length === 0;
}

/**
 * Whether a second check agrees with a pending change on what changed: the set of failed property ids for
 * regressed, recovered and a failing first check, the four counts for a plain `changed`. Other counts may move
 * between two checks (an input rejected once, a limit reached) without making a stable failure unconfirmable.
 * Without a recorded kind (a state written before it was) the whole outcome must agree.
 */
export function confirmsChange(kind: CheckChangeKind | undefined, pending: CheckOutcome, next: CheckOutcome): boolean {
  if (kind === undefined) return sameOutcome(pending, next);
  if (kind === 'changed') return sameSummary(pending.summary, next.summary);
  const a = new Set(pending.failed);
  return a.size === new Set(next.failed).size && next.failed.every((id) => a.has(id));
}

/**
 * Change kinds a second check at a later block must confirm before they are attested or alerted: a fuzz run
 * can miss a counterexample once, and a single RPC hiccup can make a property flip. A first check that fails
 * a property is confirmed the same way. implementation (only the key moved) needs none.
 */
export function needsConfirmation(change: CheckChange | null, outcome: CheckOutcome): boolean {
  if (!change) return false;
  if (change.kind === 'regressed' || change.kind === 'recovered' || change.kind === 'changed') return true;
  return change.kind === 'new' && outcome.summary.fail > 0;
}

/**
 * Why a check may be attested (docs/adr/0006, "Attestation policy"). subscribed: a subject with an active
 * subscription, at its first check after the subscription started or at a confirmed change. factory: a vault a
 * factory announced, at its first check and at its first-deposit re-check. fail: a confirmed check with a
 * failed property. attested-change: a confirmed change of a subject that already has a Valid attestation.
 */
export const ATTEST_CLASSES = ['subscribed', 'factory', 'fail', 'attested-change'] as const;
export type AttestClass = (typeof ATTEST_CLASSES)[number];

export interface AttestPolicyInput {
  /** The subject has an active subscription. */
  subscribed: boolean;
  /** This is the first check since one of its subscriptions started. */
  firstSinceSubscription: boolean;
  /** The check confirms a change against the subject's previous check (or is its confirmed first check). */
  confirmedChange: boolean;
  /** A factory source announced the vault. */
  factoryVault: boolean;
  /** The vault had no check before this one. */
  firstCheck: boolean;
  /** The check is the first-deposit re-check. */
  firstDeposit: boolean;
  /** Some property failed (confirmed: an unconfirmed fail never reaches the policy). */
  hasFail: boolean;
  /** The registry holds a Valid attestation of the subject, from any issuer. */
  hasValidAttestation: boolean;
}

/**
 * The class that allows attesting this check, or null with the reason none does. Subscribed comes first, so a
 * subscriber's attestation is counted against the subscribed budget rather than the unsolicited one.
 */
export function attestClassOf(i: AttestPolicyInput): { cls: AttestClass; why: string } | { cls: null; why: string } {
  if (i.subscribed && i.firstSinceSubscription) return { cls: 'subscribed', why: 'first check since a subscription started' };
  if (i.subscribed && i.confirmedChange) return { cls: 'subscribed', why: 'confirmed change of a subscribed subject' };
  if (i.factoryVault && i.firstCheck) return { cls: 'factory', why: 'first check of a vault a factory announced' };
  if (i.factoryVault && i.firstDeposit) return { cls: 'factory', why: 'first-deposit re-check of a vault a factory announced' };
  if (i.hasFail) return { cls: 'fail', why: 'a property fails, confirmed by a second check' };
  if (i.confirmedChange && i.hasValidAttestation) return { cls: 'attested-change', why: 'confirmed change of a subject with a Valid attestation' };
  if (i.firstDeposit) return { cls: null, why: 'the first-deposit re-check of a vault no factory announced is not attested' };
  if (i.firstCheck) return { cls: null, why: 'an unsolicited candidate that passes is not attested' };
  if (i.confirmedChange) return { cls: null, why: 'a change of a subject without a Valid attestation and without a failed property is not attested' };
  return { cls: null, why: 'an unchanged re-check is not attested' };
}
