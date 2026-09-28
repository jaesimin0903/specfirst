import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import type { AgentResult, ImplAgent, IterationRecord } from '../agent/types.js';
import { BUDGET_EXCEEDED_EXIT_CODE, type BudgetTracker } from '../budget/budget.js';
import type { Counterexample, FuzzBackend, FuzzParams, FuzzResult } from '../fuzz/types.js';
import { LOCK_MISMATCH_EXIT_CODE } from '../lock/lock.js';
import { sha256Hex } from '../spec/hash.js';
import type { Spec } from '../spec/schema.js';
import { checkEditable, checkLockedTouched, detectEnvBranches, type EnvBranchWarning } from './guard.js';
import { collectChanges, commitAll, createWorktree, removeWorktree, type Worktree } from './worktree.js';

export const LOOP_EXHAUSTED_EXIT_CODE = 10;
export const DEFAULT_MAX_ITERATIONS = 5;
/** Per agent call (plan 3.3). */
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
export const RUNS_DIR = '.specfirst/runs';

export type LoopStatus = 'passed' | 'exhausted' | 'rejected' | 'budget' | 'stalled';
export type LoopExitCode = 0 | 10 | 11 | 15;
export type StopReason =
  | 'all-pass'
  | 'max-iterations'
  | 'same-counterexample'
  | 'empty-diff'
  | 'agent-timeout'
  | 'locked-file-touched'
  | 'budget-run'
  | 'budget-total';

export interface LoopEnvWarning extends EnvBranchWarning {
  iteration: number;
}

export type LoopEvent =
  | { type: 'loop-start'; runId: string; maxIterations: number }
  | { type: 'iteration-start'; runId: string; iteration: number; phase: 'implement' | 'fix'; worktree: string }
  | { type: 'fuzz-result'; runId: string; iteration: number; reused: boolean; pass: number; fail: number; error: number }
  | { type: 'agent-start'; runId: string; iteration: number; phase: 'implement' | 'fix' }
  | { type: 'agent-result'; runId: string; iteration: number; costUsd: number; changedPaths: string[] }
  | { type: 'rejected'; runId: string; iteration: number; reason: string; paths: string[] }
  | { type: 'env-warning'; runId: string; iteration: number; warning: EnvBranchWarning }
  | { type: 'accepted'; runId: string; iteration: number; commit: string }
  | { type: 'loop-end'; runId: string; status: LoopStatus; exitCode: LoopExitCode; stopReason: StopReason };

export interface FixLoopInput {
  spec: Spec;
  projectDir: string;
  runId: string;
  agent: ImplAgent;
  backend: FuzzBackend;
  params: FuzzParams;
  maxIterations?: number;
  budget: BudgetTracker;
  /** Locked paths; entries ending in "/" are directory prefixes. See lockedPaths(). */
  lockFiles: string[];
  onEvent?: (e: LoopEvent) => void;
  agentTimeoutMs?: number;
  /** Commit the run starts from. */
  baseRef?: string;
  /** Leave the per-iteration worktrees on disk (debugging). */
  keepWorktrees?: boolean;
}

export interface FixLoopResult {
  status: LoopStatus;
  exitCode: LoopExitCode;
  stopReason: StopReason;
  iterations: IterationRecord[];
  envWarnings: LoopEnvWarning[];
  /** Last accepted commit, reachable as refs/specfirst/runs/<runId>. */
  finalCommit: string;
}

const EXIT: Record<LoopStatus, LoopExitCode> = {
  passed: 0,
  exhausted: LOOP_EXHAUSTED_EXIT_CODE,
  stalled: LOOP_EXHAUSTED_EXIT_CODE,
  rejected: LOCK_MISMATCH_EXIT_CODE as 11,
  budget: BUDGET_EXCEEDED_EXIT_CODE as 15,
};

/** sha256(invariantId + callSequence), with the reason standing in for an empty sequence (errors). */
export function counterexampleSignature(c: Counterexample): string {
  const body = c.callSequence.length > 0 ? c.callSequence.join('\n') : `reason:${c.reason}`;
  return sha256Hex(`${c.invariantId}\n${body}`);
}

/** Failing and erroring invariants, both fed back to the agent. Errors carry no call sequence. */
export function counterexamplesOf(fuzz: FuzzResult): Counterexample[] {
  const out: Counterexample[] = [];
  for (const r of fuzz.results) {
    if (r.status === 'fail') {
      out.push(r.counterexample ?? { invariantId: r.invariantId, callSequence: [], reason: 'failed', source: 'forge' });
    } else if (r.status === 'error') {
      out.push({ invariantId: r.invariantId, callSequence: [], reason: `error: ${r.error ?? 'unknown'}`, source: 'forge' });
    }
  }
  return out;
}

class AgentTimeoutError extends Error {}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new AgentTimeoutError(`agent call exceeded ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeIteration(runDir: string, rec: IterationRecord, extra: Record<string, unknown>): Promise<void> {
  const dir = path.join(runDir, `iter-${rec.iteration}`);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(path.join(dir, 'counterexamples.json'), `${JSON.stringify(rec.counterexamples, null, 2)}\n`),
    writeFile(path.join(dir, 'diff.patch'), rec.diff),
    writeFile(path.join(dir, 'fuzz.json'), `${JSON.stringify({ reused: rec.fuzzReused ?? false, result: rec.fuzz }, null, 2)}\n`),
    writeFile(
      path.join(dir, 'agent.json'),
      `${JSON.stringify(
        { phase: rec.phase, costUsd: rec.costUsd, result: rec.agent ?? null, rejected: rec.rejected ?? null, changedPaths: rec.changedPaths, ...extra },
        null,
        2,
      )}\n`,
    ),
  ]);
}

/**
 * Fix loop (plan 3.3). Every iteration gets a fresh git worktree from the last accepted commit:
 *
 *   [implement if the contract file is missing] -> judge -> all pass? done (0)
 *   -> stop checks (iteration cap, same counterexample twice in a row, budget)
 *   -> agent.fix -> collectChanges -> guards -> commit, or discard the iteration as a failure.
 *
 * Touching a locked file ends the run (rejected, 11). Writing outside `contract.editable` only discards
 * that iteration; the next one re-uses the last judge result because the code did not change.
 */
export async function runFixLoop(input: FixLoopInput): Promise<FixLoopResult> {
  const { spec, projectDir, runId, agent, backend, params, budget, lockFiles } = input;
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const agentTimeoutMs = input.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const emit = input.onEvent ?? (() => {});
  const runDir = path.join(projectDir, RUNS_DIR, runId);
  const runRef = `refs/specfirst/runs/${runId}`;
  if (backend.role !== 'judge') throw new Error(`backend ${backend.name} is auxiliary and cannot judge a run`);

  const iterations: IterationRecord[] = [];
  const envWarnings: LoopEnvWarning[] = [];
  const worktrees: Worktree[] = [];
  let base = input.baseRef ?? 'HEAD';
  let lastFuzz: FuzzResult | null = null;
  let prevSignatures: Set<string> | null = null;
  let prevRejected = false;

  emit({ type: 'loop-start', runId, maxIterations });

  const finish = async (status: LoopStatus, stopReason: StopReason): Promise<FixLoopResult> => {
    const finalCommit = String((await execa('git', ['rev-parse', `${base}^{commit}`], { cwd: projectDir })).stdout).trim();
    await execa('git', ['update-ref', runRef, finalCommit], { cwd: projectDir });
    if (!input.keepWorktrees) for (const w of worktrees) await removeWorktree(projectDir, w.path);
    const exitCode = EXIT[status];
    emit({ type: 'loop-end', runId, status, exitCode, stopReason });
    return { status, exitCode, stopReason, iterations, envWarnings, finalCommit };
  };

  const budgetStop = (): StopReason | null => {
    const over = budget.exceeded();
    return over === 'run' ? 'budget-run' : over === 'total' ? 'budget-total' : null;
  };

  /**
   * Runs one agent call in the worktree, then collects, guards and commits.
   * Returns a stop decision, or null to continue.
   */
  const agentStep = async (
    wt: Worktree,
    rec: IterationRecord,
    call: (signal: AbortSignal) => Promise<AgentResult>,
  ): Promise<{ status: LoopStatus; reason: StopReason } | null> => {
    emit({ type: 'agent-start', runId, iteration: rec.iteration, phase: rec.phase });
    let result: AgentResult;
    try {
      result = await withTimeout(agentTimeoutMs, call);
    } catch (err) {
      if (err instanceof AgentTimeoutError) {
        rec.rejected = err.message;
        await writeIteration(runDir, rec, {});
        iterations.push(rec);
        return { status: 'stalled', reason: 'agent-timeout' };
      }
      throw err;
    }
    rec.agent = result;
    rec.costUsd = result.costUsd;
    await budget.add(result.costUsd);

    const changes = await collectChanges(wt.path);
    rec.diff = changes.diff;
    rec.changedPaths = changes.changedPaths;
    emit({ type: 'agent-result', runId, iteration: rec.iteration, costUsd: result.costUsd, changedPaths: changes.changedPaths });

    const locked = checkLockedTouched(changes.changedPaths, lockFiles);
    const outside = checkEditable(changes.changedPaths, spec.contract.editable);
    let stop: { status: LoopStatus; reason: StopReason } | null = null;
    let warnings: EnvBranchWarning[] = [];

    if (locked.length > 0) {
      rec.rejected = `locked files touched: ${locked.join(', ')}`;
      emit({ type: 'rejected', runId, iteration: rec.iteration, reason: rec.rejected, paths: locked });
      stop = { status: 'rejected', reason: 'locked-file-touched' };
    } else if (outside.length > 0) {
      rec.rejected = `outside contract.editable: ${outside.join(', ')}`;
      emit({ type: 'rejected', runId, iteration: rec.iteration, reason: rec.rejected, paths: outside });
    } else if (changes.changedPaths.length === 0) {
      stop = { status: 'stalled', reason: 'empty-diff' };
    } else {
      warnings = detectEnvBranches(changes.diff);
      for (const w of warnings) {
        envWarnings.push({ ...w, iteration: rec.iteration });
        emit({ type: 'env-warning', runId, iteration: rec.iteration, warning: w });
      }
      base = await commitAll(wt.path, `specfirst ${runId} iter-${rec.iteration} ${rec.phase}`);
      emit({ type: 'accepted', runId, iteration: rec.iteration, commit: base });
    }
    prevRejected = rec.rejected !== undefined;

    await writeIteration(runDir, rec, { envWarnings: warnings });
    iterations.push(rec);
    if (stop) return stop;
    const over = budgetStop();
    return over ? { status: 'budget', reason: over } : null;
  };

  /** The contract must be written first when the spec names no path or the base commit lacks the file. */
  const needsImplement = async (): Promise<boolean> => {
    if (!spec.contract.path) return iterations.every((r) => r.phase !== 'implement' || r.rejected !== undefined);
    const probe = await execa('git', ['cat-file', '-e', `${base}:${spec.contract.path}`], { cwd: projectDir, reject: false });
    return probe.exitCode !== 0;
  };

  // Implement step: iteration 0, repeated (and counted) only while the contract is still missing.
  let iteration = 0;
  while (await needsImplement()) {
    if (iteration >= maxIterations) return finish('exhausted', 'max-iterations');
    const over = budgetStop();
    if (over) return finish('budget', over);
    const wt = await createWorktree(projectDir, runId, iteration, base);
    worktrees.push(wt);
    emit({ type: 'iteration-start', runId, iteration, phase: 'implement', worktree: wt.path });
    const rec: IterationRecord = { iteration, phase: 'implement', counterexamples: [], diff: '', changedPaths: [], fuzz: null, costUsd: 0 };
    const stop = await agentStep(wt, rec, (signal) => agent.implement({ spec, worktree: wt.path, signal }));
    if (stop) return finish(stop.status, stop.reason);
    iteration += 1;
  }
  prevRejected = false;

  for (iteration = Math.max(iteration, 1); ; iteration++) {
    const wt = await createWorktree(projectDir, runId, iteration, base);
    worktrees.push(wt);
    emit({ type: 'iteration-start', runId, iteration, phase: 'fix', worktree: wt.path });

    const reused = prevRejected && lastFuzz !== null;
    const fuzz: FuzzResult = reused ? lastFuzz! : await backend.run({
          worktree: wt.path,
          spec,
          params,
          persistDir: path.join(runDir, `iter-${iteration}`, 'forge-persist'),
        });
    lastFuzz = fuzz;
    const counts = { pass: 0, fail: 0, error: 0 };
    for (const r of fuzz.results) counts[r.status] += 1;
    emit({ type: 'fuzz-result', runId, iteration, reused, ...counts });

    const counterexamples = counterexamplesOf(fuzz);
    const rec: IterationRecord = {
      iteration,
      phase: 'fix',
      counterexamples,
      diff: '',
      changedPaths: [],
      fuzz,
      costUsd: 0,
      ...(reused ? { fuzzReused: true } : {}),
    };
    const done = async (status: LoopStatus, reason: StopReason) => {
      await writeIteration(runDir, rec, {});
      iterations.push(rec);
      return finish(status, reason);
    };

    if (fuzz.results.length > 0 && counterexamples.length === 0) return done('passed', 'all-pass');
    if (fuzz.results.length === 0) {
      counterexamples.push({ invariantId: '*', callSequence: [], reason: 'error: judge returned no results', source: 'forge' });
    }

    const signatures = new Set(counterexamples.map(counterexampleSignature));
    if (!reused && prevSignatures && [...signatures].some((s) => prevSignatures!.has(s))) {
      return done('stalled', 'same-counterexample');
    }
    if (!reused) prevSignatures = signatures;
    if (iteration >= maxIterations) return done('exhausted', 'max-iterations');
    const over = budgetStop();
    if (over) return done('budget', over);

    const history = [...iterations];
    const stop = await agentStep(wt, rec, (signal) =>
      agent.fix({ spec, worktree: wt.path, counterexamples, history, signal }),
    );
    if (stop) return finish(stop.status, stop.reason);
  }
}
