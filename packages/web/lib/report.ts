import { keccak256, toHex, type Hex } from 'viem';
import { canonicalJson } from '@specfirst/core/hash';

/**
 * report.json as written by `specfirst cert issue` (packages/core/src/cert/report.ts buildReport,
 * docs/plan.md 3.10). Mirrors core's Report type field for field; this package cannot import that
 * type without pulling Node-only code into the client bundle, so the two must be edited together.
 * Only `specfirst`, `invariants` and `unverified` are required here so the page still renders a
 * partial or older report defensively; core always writes every field.
 */

export type ReportInvariantKind = 'invariant' | 'access' | 'postcondition';
export type ReportInvariantStatus = 'pass' | 'fail' | 'error';

export interface ReportInvariantResult {
  id: string;
  kind: ReportInvariantKind;
  text: string;
  /** Combined: pass only when the forge judge passed and post-deploy verification confirmed it. */
  status: ReportInvariantStatus;
  /** Fix loop judge result. */
  fuzz?: ReportInvariantStatus | null;
  /** Post-deploy verification; null when not judged on that path (e.g. INV-3 without a fork). */
  verify?: boolean | null;
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

export interface ReportEnvWarning {
  kind: string;
  file: string;
  line: number;
  text: string;
  iteration?: number;
}

export interface Report {
  specfirst: 1;
  projectId?: string;
  projectIdHash?: Hex;
  name?: string;
  target?: string;
  chainId?: number;
  codeHash?: Hex;
  specHash?: Hex;
  invariantSetHash?: Hex;
  propertyHash?: Hex;
  cliVersion?: string;
  foundryVersion?: string | null;
  model?: string | null;
  claudeCliVersion?: string | null;
  agent?: { kind: string; calls: number };
  fuzz?: { backend?: 'forge'; runs: number; depth: number; timeoutSec?: number; seed?: string; maxIterations?: number };
  iterations?: number;
  costUsd?: number;
  costTotalUsd?: number;
  history?: unknown[];
  invariants: ReportInvariantResult[];
  unverified: string[];
  passedCount?: number;
  totalCount?: number;
  passedBitmap?: Hex;
  run?: { runId: string; baseCommit: string; finalCommit: string; status: string; stopReason: string; startedAt: string; finishedAt: string };
  deploy?: { txHash: Hex; blockNumber: string; gasUsed: string; gasLimit: string; deployer: string };
  rehearsal?: {
    normalTx: number;
    expectRevertTx: number;
    summary?: Record<string, number>;
    actors?: Array<{ name: string; role: string; address: string }>;
    expectRevert?: Array<{ hash: Hex; kind: string | null; verdict: string; selector: string }>;
  } | null;
  /** The latest-substitution proxy path was dropped (docs/adr/0001); fork or SpecfirstProbe remain. */
  verifyMethod?: 'fork' | 'probe' | null;
  verifyNotes?: string[];
  verify?: {
    forkBlock: string | null;
    probeBlock: string | null;
    depositors: number;
    passed: number;
    violated: number;
    unjudged: number;
  } | null;
  /** Absent when no auxiliary campaign ran. */
  auxiliary?: ReportAuxiliary;
  envWarnings?: ReportEnvWarning[];
}

/**
 * keccak256(toHex(canonicalJson(report))), the same formula as reportHash in
 * packages/core/src/cert/report.ts. canonicalJson comes from the browser-safe @specfirst/core/hash
 * subpath rather than being reimplemented, so the hash stays byte-for-byte identical to the CLI's.
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

/** The reportURI prefix of attestations recorded before 2026-10-08: a GitHub account that is not ours. */
export const LEGACY_REPORT_PREFIX = 'https://raw.githubusercontent.com/jaesimin/specfirst/';
/** Where the same files are published: the public Specfirst repository. */
export const REPORT_PREFIX = 'https://raw.githubusercontent.com/jaesimin0903/specfirst/';

/**
 * The URL to link, fetch or hash-check for a reportURI. Attestations recorded before 2026-10-08 name
 * raw.githubusercontent.com/jaesimin/specfirst, a path we do not control; the same files are in
 * jaesimin0903/specfirst, and the on-chain reportHash still binds their content. Only that exact prefix
 * is rewritten; every other string comes back unchanged, so the host allowlist and the hash check
 * apply to the result as before. Show the on-chain string next to any link built from this.
 */
export function reportLinkOf(reportURI: string): string {
  return reportURI.startsWith(LEGACY_REPORT_PREFIX) ? REPORT_PREFIX + reportURI.slice(LEGACY_REPORT_PREFIX.length) : reportURI;
}

/**
 * Resolves reportURI (an on-chain, issuer-supplied string) against NEXT_PUBLIC_REPORT_BASE.
 * Returns '' whenever the result would not be safe to use as a fetch target or an href:
 *   - NEXT_PUBLIC_REPORT_BASE is unset, malformed, or not an absolute https:// URL. reportURI is
 *     only ever treated as a path under that one trusted base, never as an independent absolute
 *     URL of its own choosing, on purpose: reportURI is stored on-chain and, while only the
 *     issuer can write it today, this function has no way to know that will stay true, and an
 *     absolute reportURI would otherwise let it silently redirect callers to an arbitrary host.
 *   - The resolved URL's scheme is not http: or https: (blocks javascript:, data:, file:, ...).
 * Uses the URL parser (never string concatenation) so a reportURI like "javascript:alert(1)" or
 * "//evil.example" can't be smuggled through as if it were a harmless relative path.
 * The result goes through reportLinkOf, so a legacy jaesimin/specfirst URL comes back at jaesimin0903/specfirst.
 */
export function resolveReportUrl(reportURI: string): string {
  if (!reportURI) return '';

  let baseUrl: URL;
  try {
    baseUrl = new URL(process.env.NEXT_PUBLIC_REPORT_BASE ?? '');
  } catch {
    return '';
  }
  if (baseUrl.protocol !== 'https:') return '';

  let resolved: URL;
  try {
    resolved = new URL(reportURI, baseUrl);
  } catch {
    return '';
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';

  return reportLinkOf(resolved.toString());
}
