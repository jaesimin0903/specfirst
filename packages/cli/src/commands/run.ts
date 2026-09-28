import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  BudgetTracker,
  BUDGET_FILE,
  ClaudeCodeAgent,
  DEFAULT_MAX_ITERATIONS,
  ForgeBackend,
  RUNS_DIR,
  ReplayAgent,
  SPEC_ERROR_EXIT_CODE,
  SpecError,
  lockedPaths,
  parseSpec,
  readLock,
  runFixLoop,
  sha256Hex,
  type FixLoopResult,
  type FuzzBackend,
  type FuzzParams,
  type FuzzResult,
  type ImplAgent,
  type LockFile,
  type LoopEvent,
  type Spec,
} from '@specfirst/core';
import { contextFrom, emitEvent, jsonReplacer, printLine, type CliContext } from '../lib/context.js';
import { ensureLock, LockMismatchError } from '../lib/ensureLock.js';
import { createRunLog, formatUsd, stage } from '../lib/runLog.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_RUNS = 64;
export const DEFAULT_DEPTH = 64;
export const DEFAULT_TIMEOUT_SEC = 300;

interface RunOptions {
  deploy: boolean;
  agent: string | false;
  allowPartial?: boolean;
  aux?: string;
  runs: string;
  depth: string;
  timeout: string;
  seed?: string;
  maxIterations: string;
  keepWorktrees?: boolean;
}

type AgentChoice =
  | { kind: 'claude' }
  | { kind: 'none' }
  | { kind: 'replay'; patches: string[] };

/** `claude`, `none`, or `replay:<patch>[,<patch>...]` with paths relative to the project. */
export function parseAgentChoice(value: string | false): AgentChoice {
  if (value === false || value === 'none') return { kind: 'none' };
  if (value === 'claude') return { kind: 'claude' };
  if (value.startsWith('replay:')) {
    const patches = value.slice('replay:'.length).split(',').map((p) => p.trim()).filter(Boolean);
    if (patches.length === 0) throw new Error('--agent replay:<patchfile> needs at least one patch file');
    return { kind: 'replay', patches };
  }
  throw new Error(`unknown --agent "${value}" (expected claude, none, or replay:<patchfile>)`);
}

function positiveInt(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

/** UTC timestamp plus 6 hex chars, e.g. 20260929-104512-3fa9c1. Sorts by start time. */
export function makeRunId(specHash: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const hash = sha256Hex(`${specHash}\n${now.toISOString()}\n${randomBytes(8).toString('hex')}`).replace(/^0x/, '');
  return `${ts}-${hash.slice(0, 6)}`;
}

/** Agent for `--agent none`: the loop is capped at one judge pass, so it is only reached when the contract is missing. */
class NoAgent implements ImplAgent {
  async implement(): Promise<never> {
    throw new Error('--agent none cannot write a missing contract; commit contract.path first or pick an agent');
  }
  async fix(): Promise<never> {
    throw new Error('--agent none never fixes');
  }
}

/** Forwards to the judge and remembers its last result, so the log can print per-invariant detail. */
class RecordingBackend implements FuzzBackend {
  readonly name: FuzzBackend['name'];
  readonly role: FuzzBackend['role'];
  last: FuzzResult | null = null;
  constructor(private readonly inner: FuzzBackend) {
    this.name = inner.name;
    this.role = inner.role;
  }
  async run(i: Parameters<FuzzBackend['run']>[0]): Promise<FuzzResult> {
    this.last = await this.inner.run(i);
    return this.last;
  }
}

async function toolVersion(bin: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(bin, args);
    return stdout.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

async function cliVersion(): Promise<string> {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // src/commands and dist/commands both sit two levels below the package root.
    const pkg = JSON.parse(await readFile(path.join(here, '..', '..', 'package.json'), 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return 'unknown';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

function fail(ctx: CliContext, code: number, message: string): void {
  console.error(message);
  emitEvent(ctx, { type: 'run-error', exitCode: code, message });
  process.exitCode = code;
}

function summarizeIterations(result: FixLoopResult) {
  return result.iterations.map((r) => {
    const counts = { pass: 0, fail: 0, error: 0 };
    for (const x of r.fuzz?.results ?? []) counts[x.status] += 1;
    return {
      iteration: r.iteration,
      phase: r.phase,
      fuzz: r.fuzz ? { ...counts, reused: r.fuzzReused ?? false, wallclockSec: r.fuzz.wallclockSec } : null,
      failing: [...new Set(r.counterexamples.map((c) => c.invariantId))],
      agentCalled: r.agent !== undefined,
      changedPaths: r.changedPaths,
      costUsd: r.costUsd,
      ...(r.rejected ? { rejected: r.rejected } : {}),
    };
  });
}

/**
 * `specfirst run <spec>` (plan 3.3, 3.10): spec parse (exit 2) -> lock check (exit 11) -> fix loop
 * with the chosen agent and the forge judge -> run.json. Exit 0 when every invariant passes,
 * 10 when the loop gave up, 11 when the agent touched a locked file, 15 over budget.
 * Deploy, rehearsal, verify and cert issue are the next step; without --no-deploy the command only warns.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run <spec>')
    .description('Lock check, then the fix loop (fuzz, fix, re-fuzz) until every invariant passes. Deploy is not implemented yet.')
    .option('--no-deploy', 'stop after the fix loop (deploy is not implemented yet either way)')
    .option('--agent <kind>', 'fix agent: claude, none (judge once, no fixes), or replay:<patchfile>[,<patchfile>]', 'claude')
    .option('--no-agent', 'same as --agent none')
    .option('--allow-partial', 'record that a partial certificate may be issued (used by cert issue)')
    .option('--aux <backend>', 'auxiliary fuzz backend (not implemented, ignored)')
    .option('--runs <n>', 'invariant runs per campaign', String(DEFAULT_RUNS))
    .option('--depth <n>', 'calls per invariant run', String(DEFAULT_DEPTH))
    .option('--timeout <s>', 'wall-clock limit per forge campaign, seconds', String(DEFAULT_TIMEOUT_SEC))
    .option('--seed <seed>', 'fuzz seed (decimal or 0x hex), for reproducible campaigns')
    .option('--max-iterations <n>', 'fix iteration cap', String(DEFAULT_MAX_ITERATIONS))
    .option('--keep-worktrees', 'leave per-iteration worktrees under .specfirst/worktrees for debugging')
    .action(async (specArg: string, opts: RunOptions, command: Command) => {
      const ctx = contextFrom(command);
      const startedAt = new Date();
      const specPath = path.resolve(ctx.projectDir, specArg);
      const specRel = path.relative(ctx.projectDir, specPath);

      // 1. spec
      let spec: Spec;
      try {
        spec = parseSpec(await readFile(specPath, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail(ctx, SPEC_ERROR_EXIT_CODE, `specfirst run: spec file not found: ${specPath}`);
        }
        if (err instanceof SpecError) return fail(ctx, SPEC_ERROR_EXIT_CODE, err.message);
        throw err;
      }

      let params: FuzzParams;
      let maxIterations: number;
      let choice: AgentChoice;
      try {
        params = {
          runs: positiveInt('--runs', opts.runs),
          depth: positiveInt('--depth', opts.depth),
          timeoutSec: positiveInt('--timeout', opts.timeout),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        };
        maxIterations = positiveInt('--max-iterations', opts.maxIterations);
        choice = parseAgentChoice(opts.agent);
      } catch (err) {
        return fail(ctx, 1, `specfirst run: ${(err as Error).message}`);
      }
      if (choice.kind === 'none') maxIterations = 1;

      // 2. lock
      let lock: LockFile;
      try {
        await ensureLock({ projectDir: ctx.projectDir, spec });
        lock = (await readLock(ctx.projectDir))!;
      } catch (err) {
        if (err instanceof LockMismatchError) {
          return fail(ctx, err.exitCode, `specfirst run: ${err.message}. Run \`specfirst lock ${specArg}\` if the change is intended.`);
        }
        throw err;
      }

      let baseCommit: string;
      try {
        baseCommit = (await git(ctx.projectDir, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
      } catch {
        return fail(ctx, 1, 'specfirst run: the project must be a git repository with at least one commit (worktrees start from HEAD)');
      }
      const dirty = (await git(ctx.projectDir, ['status', '--porcelain', '--untracked-files=no'])).trim();

      const runId = makeRunId(lock.specHash, startedAt);
      const runDir = path.join(ctx.projectDir, RUNS_DIR, runId);
      await mkdir(runDir, { recursive: true });

      // 3. agent
      let agent: ImplAgent;
      let agentLabel: string;
      const budget = await BudgetTracker.open({ file: path.join(ctx.projectDir, BUDGET_FILE), runId });
      if (choice.kind === 'replay') {
        const patches: string[] = [];
        for (const p of choice.patches) {
          try {
            patches.push(await readFile(path.resolve(ctx.projectDir, p), 'utf8'));
          } catch (err) {
            return fail(ctx, 1, `specfirst run: cannot read replay patch ${p}: ${(err as Error).message}`);
          }
        }
        agent = new ReplayAgent(patches);
        agentLabel = `replay ${choice.patches.join(', ')}`;
      } else if (choice.kind === 'claude') {
        agent = new ClaudeCodeAgent({ transcriptDir: runDir, maxBudgetUsd: budget.runCapUsd });
        agentLabel = 'claude';
      } else {
        agent = new NoAgent();
        agentLabel = 'none';
      }

      const backend = new RecordingBackend(new ForgeBackend({ artifactDir: path.join(runDir, 'forge') }));

      printLine(ctx, stage('spec', `${spec.name}  ${spec.invariants.length} invariants  ${pc.dim(specRel)}`));
      printLine(ctx, stage('lock', `${pc.green('ok')}  ${pc.dim(`specHash ${lock.specHash.slice(0, 10)}  propertyHash ${lock.propertyHash.slice(0, 10)}`)}`));
      printLine(ctx, stage('run', `${runId}  agent ${agentLabel}  base ${baseCommit.slice(0, 7)}`));
      if (dirty) printLine(ctx, pc.yellow(`${' '.repeat(9)}! uncommitted changes are not visible to the run; it starts from HEAD`));
      if (opts.aux) console.error(pc.yellow(`specfirst run: --aux ${opts.aux} is not implemented yet, ignored`));

      const render = createRunLog({ spec, params, agentLabel, lastFuzz: () => backend.last });
      const onEvent = (e: LoopEvent) => {
        if (ctx.json) emitEvent(ctx, e as unknown as Record<string, unknown>);
        else for (const line of render(e)) console.log(line);
      };

      // 4. loop
      let result: FixLoopResult;
      try {
        result = await runFixLoop({
          spec,
          projectDir: ctx.projectDir,
          runId,
          agent,
          backend,
          params,
          maxIterations,
          budget,
          lockFiles: lockedPaths(lock),
          onEvent,
          baseRef: baseCommit,
          keepWorktrees: opts.keepWorktrees ?? false,
        });
      } catch (err) {
        return fail(ctx, 1, `specfirst run: fix loop failed: ${(err as Error).message}`);
      }

      // 5. summary
      const agentCalls = result.iterations.filter((r) => r.agent);
      const lastAgent = agentCalls.at(-1)?.agent;
      const last = result.iterations.at(-1);
      const lastCounts = { pass: 0, fail: 0, error: 0 };
      for (const r of last?.fuzz?.results ?? []) lastCounts[r.status] += 1;
      const summary = {
        version: 1,
        runId,
        spec: { path: specRel, name: spec.name, specHash: lock.specHash, invariantSetHash: lock.invariantSetHash, propertyHash: lock.propertyHash },
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        baseCommit,
        finalCommit: result.finalCommit,
        runRef: `refs/specfirst/runs/${runId}`,
        status: result.status,
        exitCode: result.exitCode,
        stopReason: result.stopReason,
        judgeOnly: choice.kind === 'none',
        iterations: result.iterations.length,
        result: last?.fuzz
          ? {
              pass: lastCounts.pass,
              fail: lastCounts.fail,
              error: lastCounts.error,
              failing: last.fuzz.results.filter((r) => r.status !== 'pass').map((r) => r.invariantId),
            }
          : null,
        params: { ...params, maxIterations },
        agent: {
          kind: choice.kind,
          ...(choice.kind === 'replay' ? { patches: choice.patches } : {}),
          model: lastAgent?.model ?? null,
          cliVersion: lastAgent?.cliVersion ?? null,
          calls: agentCalls.length,
        },
        cost: { runUsd: budget.runUsd, totalUsd: budget.totalUsd, runCapUsd: budget.runCapUsd, totalCapUsd: budget.totalCapUsd },
        envWarnings: result.envWarnings,
        allowPartial: opts.allowPartial ?? false,
        deploy: opts.deploy ? 'not-implemented' : 'skipped',
        versions: {
          specfirst: await cliVersion(),
          forge: await toolVersion('forge', ['--version']),
        },
        history: summarizeIterations(result),
      };
      const runJson = path.join(runDir, 'run.json');
      await writeFile(runJson, `${JSON.stringify(summary, jsonReplacer, 2)}\n`);

      const n = result.iterations.length;
      const failing = summary.result?.failing ?? [];
      const verdict =
        choice.kind === 'none' && result.status !== 'passed'
          ? pc.red(`${failing.length} invariant${failing.length === 1 ? '' : 's'} not passing (${failing.join(', ')}), judge only, no fix attempted`)
          : result.status === 'passed'
            ? pc.green(`passed in ${n} iteration${n === 1 ? '' : 's'}`)
            : pc.red(`${result.status} (${result.stopReason}) after ${n} iteration${n === 1 ? '' : 's'}`);
      printLine(ctx, stage('done', `${verdict}  exit ${result.exitCode}  cost ${formatUsd(budget.runUsd)}`));
      printLine(ctx, `${' '.repeat(9)}${pc.dim(path.relative(ctx.projectDir, runJson))}`);
      if (opts.deploy) {
        console.error(pc.yellow('specfirst run: deploy not implemented yet; stopping after the fix loop (pass --no-deploy to silence)'));
      }
      emitEvent(ctx, { type: 'run-summary', runId, status: result.status, exitCode: result.exitCode, iterations: result.iterations.length, runJson: path.relative(ctx.projectDir, runJson) });
      process.exitCode = result.exitCode;
    });
}
