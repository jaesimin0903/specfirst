import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { DeployRecord } from '../deploy/deploy.js';
import type { RehearsalRecord } from '../rehearse/rehearse.js';
import { canonicalJson, projectIdHash } from '../spec/hash.js';
import type { Spec } from '../spec/schema.js';
import type { VerifyRecord } from '../verify/verify.js';

export const REPORT_JSON = 'report.json';
/** CLI exit code for issue and revoke failures (plan 3.10). */
export const CERT_FAILED_EXIT_CODE = 14;

/** The slice of the CLI's run.json the report copies. Extra fields are ignored. */
export interface RunSummaryLike {
  runId: string;
  spec: { path: string; name: string; specHash: Hex; invariantSetHash: Hex; propertyHash: Hex };
  baseCommit: string;
  finalCommit: string;
  status: string;
  stopReason: string;
  iterations: number;
  result: { pass: number; fail: number; error: number; failing: string[] } | null;
  params: Record<string, unknown>;
  agent: { kind: string; model: string | null; cliVersion: string | null; calls: number; patches?: string[] };
  cost: { runUsd: number; totalUsd: number; runCapUsd?: number; totalCapUsd?: number };
  envWarnings: unknown[];
  allowPartial: boolean;
  versions: { specfirst: string; forge: string | null };
  history: unknown[];
  startedAt: string;
  finishedAt: string;
}

export type AuxFindingStatus = 'confirmed' | 'needs-review' | 'candidate' | 'duplicate' | 'false-positive' | 'wont-fix' | 'fixed';

/** Auxiliary (Ultrafuzz) campaign summary, plan 3.5. Never used for judging. */
export interface ReportAuxiliary {
  backend: string;
  profile?: string;
  wallclockSec: number;
  costUsd: number;
  findings: Array<{ status: AuxFindingStatus; count: number; mapped: boolean }>;
  reproducedCount: number;
  note: string;
}

export type ReportInvariantStatus = 'pass' | 'fail' | 'error';

export interface ReportInvariant {
  id: string;
  kind: 'invariant' | 'access' | 'postcondition';
  text: string;
  /**
   * Combined verdict: pass only when the forge judge passed it and post-deploy verification confirmed
   * it; fail when either rejected it; error when it could not be judged (e.g. INV-3 on the probe path).
   */
  status: ReportInvariantStatus;
  /** Fix loop judge result. */
  fuzz: ReportInvariantStatus | null;
  /** Post-deploy verification: true, false, or null when not judged. */
  verify: boolean | null;
}

export interface ReportEnvWarning {
  kind: string;
  file: string;
  line: number;
  text: string;
  iteration?: number;
}

/**
 * report.json, schema version `specfirst: 1`. Field names are shared with packages/web/lib/report.ts,
 * which renders and re-hashes it. reportHash = keccak256(toHex(canonicalJson(report))).
 */
export interface Report {
  specfirst: 1;
  projectId: string;
  projectIdHash: Hex;
  name: string;
  target: Address;
  chainId: number;
  codeHash: Hex;
  specHash: Hex;
  invariantSetHash: Hex;
  propertyHash: Hex;
  cliVersion: string;
  foundryVersion: string | null;
  model: string | null;
  claudeCliVersion: string | null;
  agent: { kind: string; calls: number };
  fuzz: { backend: 'forge'; runs: number; depth: number; timeoutSec?: number; seed?: string; maxIterations?: number };
  iterations: number;
  costUsd: number;
  costTotalUsd: number;
  history: unknown[];
  invariants: ReportInvariant[];
  unverified: string[];
  passedCount: number;
  totalCount: number;
  passedBitmap: Hex;
  run: { runId: string; baseCommit: string; finalCommit: string; status: string; stopReason: string; startedAt: string; finishedAt: string };
  deploy: { txHash: Hex; blockNumber: string; gasUsed: string; gasLimit: string; deployer: Address };
  rehearsal: {
    /** Counts actually sent; the spec asks for rehearsal.normalTx and rehearsal.expectRevertTx. */
    normalTx: number;
    expectRevertTx: number;
    summary: RehearsalRecord['summary'];
    actors: RehearsalRecord['actors'];
    expectRevert: Array<{ hash: Hex; kind: string | null; verdict: string; selector: string }>;
  } | null;
  verifyMethod: 'fork' | 'probe' | null;
  verifyNotes: string[];
  verify: {
    forkBlock: string | null;
    probeBlock: string | null;
    depositors: number;
    passed: number;
    violated: number;
    unjudged: number;
  } | null;
  /**
   * Present only when an auxiliary campaign ran (plan 3.5: shown separately, never judged). Omitted
   * otherwise, which the certificate page renders as no auxiliary box.
   */
  auxiliary?: ReportAuxiliary;
  envWarnings: ReportEnvWarning[];
}

/** Bit i set when spec.invariants[i] passed (forge verdicts only, plan 3.4). Hex string of the uint256. */
export function passedBitmap(passed: readonly boolean[]): bigint {
  if (passed.length > 256) throw new Error('at most 256 invariants fit the bitmap');
  return passed.reduce((acc, ok, i) => (ok ? acc | (1n << BigInt(i)) : acc), 0n);
}

export interface BuildReportInput {
  spec: Spec;
  run: RunSummaryLike;
  /** Final judge result per invariant id from the fix loop. */
  fuzzStatus: Record<string, ReportInvariantStatus>;
  deploy: DeployRecord;
  rehearsal: RehearsalRecord | null;
  verify: VerifyRecord | null;
  auxiliary?: ReportAuxiliary;
}

function combined(fuzz: ReportInvariantStatus | null, verify: boolean | null): ReportInvariantStatus {
  if (fuzz === 'fail' || verify === false) return 'fail';
  if (fuzz === 'pass' && verify === true) return 'pass';
  return 'error';
}

/** report.json (plan 3.10, last paragraph). An invariant counts as passed only when its combined status is pass. */
export function buildReport(input: BuildReportInput): Report {
  const { spec, run, deploy, rehearsal, verify } = input;
  const invariants: ReportInvariant[] = spec.invariants.map((inv) => {
    const fuzz = input.fuzzStatus[inv.id] ?? null;
    const v = verify ? (verify.invariants.find((x) => x.id === inv.id)?.ok ?? null) : null;
    return { id: inv.id, kind: inv.kind, text: inv.text, status: combined(fuzz, v), fuzz, verify: v };
  });
  const bitmap = passedBitmap(invariants.map((i) => i.status === 'pass'));
  const p = run.params as { runs: number; depth: number; timeoutSec?: number; seed?: string; maxIterations?: number };
  const reverts = rehearsal?.txs.filter((t) => t.expectRevert) ?? [];
  return {
    specfirst: 1,
    projectId: spec.projectId,
    projectIdHash: projectIdHash(spec.projectId),
    name: spec.name,
    target: deploy.address,
    chainId: deploy.chainId,
    codeHash: deploy.codeHash,
    specHash: run.spec.specHash,
    invariantSetHash: run.spec.invariantSetHash,
    propertyHash: run.spec.propertyHash,
    cliVersion: run.versions.specfirst,
    foundryVersion: run.versions.forge,
    model: run.agent.model,
    claudeCliVersion: run.agent.cliVersion,
    agent: { kind: run.agent.kind, calls: run.agent.calls },
    fuzz: {
      backend: 'forge',
      runs: p.runs,
      depth: p.depth,
      ...(p.timeoutSec !== undefined ? { timeoutSec: p.timeoutSec } : {}),
      ...(p.seed !== undefined ? { seed: String(p.seed) } : {}),
      ...(p.maxIterations !== undefined ? { maxIterations: p.maxIterations } : {}),
    },
    iterations: run.iterations,
    costUsd: run.cost.runUsd,
    costTotalUsd: run.cost.totalUsd,
    history: run.history,
    invariants,
    unverified: [...spec.unverified],
    passedCount: invariants.filter((i) => i.status === 'pass').length,
    totalCount: invariants.length,
    passedBitmap: `0x${bitmap.toString(16)}`,
    run: {
      runId: run.runId,
      baseCommit: run.baseCommit,
      finalCommit: run.finalCommit,
      status: run.status,
      stopReason: run.stopReason,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    deploy: { txHash: deploy.txHash, blockNumber: deploy.blockNumber, gasUsed: deploy.gasUsed, gasLimit: deploy.gasLimit, deployer: deploy.deployer },
    rehearsal: rehearsal
      ? {
          normalTx: rehearsal.txs.length - reverts.length,
          expectRevertTx: reverts.length,
          summary: rehearsal.summary,
          actors: rehearsal.actors,
          expectRevert: reverts.map((t) => ({
            hash: t.hash,
            kind: t.revertKind ?? null,
            verdict: t.verdict,
            selector:
              typeof t.selector === 'object'
                ? t.selector.match
                  ? `${t.selector.expectedError} ${t.selector.actual}`
                  : `mismatch ${t.selector.actual ?? ''}`
                : (t.selector ?? 'selector 미확인'),
          })),
        }
      : null,
    verifyMethod: verify?.path ?? null,
    verifyNotes: verify?.note ? [verify.note] : [],
    verify: verify
      ? {
          forkBlock: verify.fork?.block ?? null,
          probeBlock: verify.probe?.block ?? null,
          depositors: verify.depositors.count,
          passed: verify.passed,
          violated: verify.violated,
          unjudged: verify.unjudged,
        }
      : null,
    ...(input.auxiliary ? { auxiliary: input.auxiliary } : {}),
    envWarnings: (run.envWarnings as ReportEnvWarning[]).map(({ kind, file, line, text, iteration }) => ({
      kind,
      file,
      line,
      text,
      ...(iteration !== undefined ? { iteration } : {}),
    })),
  };
}

/** keccak256 over the canonical JSON (sorted keys, no whitespace) of the report. */
export function reportHash(report: unknown): Hex {
  return keccak256(toHex(canonicalJson(report)));
}
