import { keccak256, toHex, type Hex } from 'viem';
import { canonicalJson } from '@specfirst/core';

/**
 * report.json shape. `specfirst cert issue` is not implemented yet (packages/cli/src/commands/
 * cert.ts is a stub as of this writing), so there is no shared schema to import from @specfirst/
 * core or @specfirst/cli. This is this package's own working definition, built from docs/plan.md
 * 3.10 ("report JSON에는 CLI 버전, Foundry 버전, 모델명, ... 보조 캠페인 요약, 환경 분기 경고가
 * 들어간다") and 3.5 (auxiliary campaign fields). Intentionally permissive (most fields optional
 * beyond what the certificate page renders) so it does not break once the real writer exists;
 * the writer should treat this as a draft, not a contract.
 */

export type ReportInvariantKind = 'invariant' | 'access' | 'postcondition';
export type ReportInvariantStatus = 'pass' | 'fail' | 'error';

export interface ReportInvariantResult {
  id: string;
  kind: ReportInvariantKind;
  text: string;
  status: ReportInvariantStatus;
}

export type AuxFindingStatus = 'confirmed' | 'needs-review' | 'candidate' | 'duplicate' | 'false-positive' | 'wont-fix' | 'fixed';

export interface ReportAuxFindingSummary {
  status: AuxFindingStatus;
  count: number;
  /** Whether these findings mapped to a spec invariant (docs/plan.md 3.5's second column). */
  mapped: boolean;
}

export interface ReportAuxiliary {
  backend: string;
  profile?: string;
  wallclockSec: number;
  costUsd: number;
  findings: ReportAuxFindingSummary[];
  reproducedCount: number;
  /** Free-text note, meant to render as-is, e.g. "auxiliary campaign run, 0 reproduced, 3 unreviewed candidates". */
  note: string;
}

export interface Report {
  specfirst: 1;
  projectId: string;
  name: string;
  target: string;
  chainId: number;
  cliVersion?: string;
  foundryVersion?: string;
  model?: string;
  claudeCliVersion?: string;
  fuzz?: { runs: number; depth: number; timeoutSec?: number; seed?: number };
  iterations?: number;
  costUsd?: number;
  invariants: ReportInvariantResult[];
  unverified: string[];
  rehearsal?: { normalTx: number; expectRevertTx: number };
  verifyMethod?: 'fork' | 'latest-proxy' | 'probe';
  verifyNotes?: string[];
  auxiliary?: ReportAuxiliary;
  envWarnings?: string[];
  issuedAt?: string;
}

/**
 * keccak256(toHex(canonicalJson(report))), matching the pattern of every other on-chain hash in
 * @specfirst/core (invariantSetHash, propertyHash): canonicalJson is imported from @specfirst/
 * core rather than reimplemented here, per the task's instruction, so this hash stays byte-for-
 * byte identical to whatever the CLI computes once `cert issue` is implemented there.
 */
export function computeReportHash(report: unknown): Hex {
  return keccak256(toHex(canonicalJson(report)));
}

/** Type guard good enough to render the page defensively; not a full runtime schema validator. */
export function isReport(value: unknown): value is Report {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return r.specfirst === 1 && Array.isArray(r.invariants) && Array.isArray(r.unverified);
}

/** reportURI may be a full URL (e.g. IPFS gateway) or a path relative to NEXT_PUBLIC_REPORT_BASE. */
export function resolveReportUrl(reportURI: string): string {
  if (!reportURI) return '';
  if (/^https?:\/\//.test(reportURI)) return reportURI;
  const base = process.env.NEXT_PUBLIC_REPORT_BASE ?? '';
  return `${base}${reportURI}`;
}
