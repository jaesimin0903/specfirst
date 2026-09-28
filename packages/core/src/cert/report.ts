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

export interface AuxCampaignSummary {
  backend: string | null;
  profile: string | null;
  wallclockSec: number | null;
  costUsd: number | null;
  findingsByStatus: Record<string, number>;
  reproduced: number;
  note: string;
}

export const EMPTY_AUX_CAMPAIGN: AuxCampaignSummary = {
  backend: null,
  profile: null,
  wallclockSec: null,
  costUsd: null,
  findingsByStatus: {},
  reproduced: 0,
  note: '보조 캠페인 미실행',
};

export interface Report {
  schema: 'specfirst/report@1';
  chainId: number;
  target: Address;
  codeHash: Hex;
  project: { projectId: string; projectIdHash: Hex; name: string };
  hashes: { specHash: Hex; invariantSetHash: Hex; propertyHash: Hex };
  invariants: Array<{ id: string; kind: string; text: string; fuzz: 'pass' | 'fail' | 'error' | null; verify: boolean | null; passed: boolean }>;
  unverified: string[];
  passedCount: number;
  totalCount: number;
  passedBitmap: string;
  versions: { specfirst: string; foundry: string | null; claudeCli: string | null };
  agent: { kind: string; model: string | null; calls: number };
  fuzz: { backend: 'forge'; params: Record<string, unknown> };
  run: { runId: string; baseCommit: string; finalCommit: string; status: string; stopReason: string; iterations: number; startedAt: string; finishedAt: string };
  history: unknown[];
  cost: { runUsd: number; totalUsd: number };
  auxCampaign: AuxCampaignSummary;
  envWarnings: unknown[];
  deploy: { txHash: Hex; blockNumber: string; gasUsed: string; gasLimit: string; deployer: Address };
  rehearsal: {
    txCount: number;
    summary: RehearsalRecord['summary'];
    actors: RehearsalRecord['actors'];
    expectRevert: Array<{ hash: Hex; kind: string | undefined; verdict: string; selector: string }>;
  } | null;
  verify: {
    path: VerifyRecord['path'];
    note: string | null;
    forkBlock: string | null;
    probeBlock: string | null;
    depositors: number;
    passed: number;
    violated: number;
    unjudged: number;
  } | null;
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
  fuzzStatus: Record<string, 'pass' | 'fail' | 'error'>;
  deploy: DeployRecord;
  rehearsal: RehearsalRecord | null;
  verify: VerifyRecord | null;
  auxCampaign?: AuxCampaignSummary;
}

/**
 * report.json (plan 3.10, last paragraph). An invariant counts as passed only when the fix loop's
 * forge judge passed it and post-deploy verification did not reject or leave it unjudged.
 */
export function buildReport(input: BuildReportInput): Report {
  const { spec, run, deploy, rehearsal, verify } = input;
  const invariants = spec.invariants.map((inv) => {
    const fuzz = input.fuzzStatus[inv.id] ?? null;
    const v = verify ? (verify.invariants.find((x) => x.id === inv.id)?.ok ?? null) : null;
    return { id: inv.id, kind: inv.kind, text: inv.text, fuzz, verify: v, passed: fuzz === 'pass' && v === true };
  });
  const bitmap = passedBitmap(invariants.map((i) => i.passed));
  return {
    schema: 'specfirst/report@1',
    chainId: deploy.chainId,
    target: deploy.address,
    codeHash: deploy.codeHash,
    project: { projectId: spec.projectId, projectIdHash: projectIdHash(spec.projectId), name: spec.name },
    hashes: { specHash: run.spec.specHash, invariantSetHash: run.spec.invariantSetHash, propertyHash: run.spec.propertyHash },
    invariants,
    unverified: [...spec.unverified],
    passedCount: invariants.filter((i) => i.passed).length,
    totalCount: invariants.length,
    passedBitmap: `0x${bitmap.toString(16)}`,
    versions: { specfirst: run.versions.specfirst, foundry: run.versions.forge, claudeCli: run.agent.cliVersion },
    agent: { kind: run.agent.kind, model: run.agent.model, calls: run.agent.calls },
    fuzz: { backend: 'forge', params: run.params },
    run: {
      runId: run.runId,
      baseCommit: run.baseCommit,
      finalCommit: run.finalCommit,
      status: run.status,
      stopReason: run.stopReason,
      iterations: run.iterations,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    history: run.history,
    cost: { runUsd: run.cost.runUsd, totalUsd: run.cost.totalUsd },
    auxCampaign: input.auxCampaign ?? EMPTY_AUX_CAMPAIGN,
    envWarnings: run.envWarnings,
    deploy: { txHash: deploy.txHash, blockNumber: deploy.blockNumber, gasUsed: deploy.gasUsed, gasLimit: deploy.gasLimit, deployer: deploy.deployer },
    rehearsal: rehearsal
      ? {
          txCount: rehearsal.txs.length,
          summary: rehearsal.summary,
          actors: rehearsal.actors,
          expectRevert: rehearsal.txs
            .filter((t) => t.expectRevert)
            .map((t) => ({
              hash: t.hash,
              kind: t.revertKind,
              verdict: t.verdict,
              selector: typeof t.selector === 'object' ? (t.selector.match ? `${t.selector.expectedError} ${t.selector.actual}` : `mismatch ${t.selector.actual ?? ''}`) : (t.selector ?? 'selector 미확인'),
            })),
        }
      : null,
    verify: verify
      ? {
          path: verify.path,
          note: verify.note ?? null,
          forkBlock: verify.fork?.block ?? null,
          probeBlock: verify.probe?.block ?? null,
          depositors: verify.depositors.count,
          passed: verify.passed,
          violated: verify.violated,
          unjudged: verify.unjudged,
        }
      : null,
  };
}

/** keccak256 over the canonical JSON (sorted keys, no whitespace) of the report. */
export function reportHash(report: unknown): Hex {
  return keccak256(toHex(canonicalJson(report)));
}
