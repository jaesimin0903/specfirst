import type { Hex } from 'viem';
import { STANDARD_PROPERTIES } from '../attest/params.js';
import { ATTESTATION_STATUS, type Attestation } from '../attest/registry.js';
import type { StandardCheckReport, StandardName } from '../standards/report.js';
import type { FeedChange, WatchSummary } from './schema.js';

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
 * kinds, defined in CHANGE_KINDS): new without a previous check; regressed when a property fails that did
 * not; recovered when none newly fails and one stopped failing; changed for other count changes;
 * implementation when only the implementation key moved.
 */
export function changeOf(prev: CheckOutcome | null, next: CheckOutcome): FeedChange | null {
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
