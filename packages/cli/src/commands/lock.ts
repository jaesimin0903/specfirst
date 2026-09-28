import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import {
  ForgeBackend,
  LOCK_DIR,
  LockError,
  MUTANT_CHECK_EXIT_CODE,
  MutantCheckError,
  SPEC_ERROR_EXIT_CODE,
  SpecError,
  annotateLock,
  createLock,
  mutantsReportPath,
  parseSpec,
  runMutantCheck,
  type FuzzBackend,
  type FuzzParams,
  type MutantCheckReport,
  type MutantCheckResult,
} from '@specfirst/core';
import { contextFrom, emitEvent, printLine, type CliContext } from '../lib/context.js';
import { DEFAULT_DEPTH, DEFAULT_RUNS, DEFAULT_TIMEOUT_SEC } from './run.js';

export interface LockCommandDeps {
  /** Judge used by the mutant check. Defaults to ForgeBackend writing under .specfirst/mutants-forge. */
  backend?: (artifactDir: string) => FuzzBackend;
}

interface LockOptions {
  baseline?: string;
  skipMutants?: boolean;
  runs: string;
  depth: string;
  timeout: string;
  seed?: string;
  keepWorktree?: boolean;
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer, got ${value}`);
  return n;
}

function markOf(r: MutantCheckResult): string {
  if (r.broke) return pc.green('✓');
  if (r.status === 'skipped') return pc.dim('-');
  return pc.red('✗');
}

function printReport(ctx: CliContext, report: MutantCheckReport): void {
  const base = report.baseline.source ?? report.contractPath ?? 'contract';
  const passed = report.results.filter((r) => r.broke).length;
  printLine(ctx, `${pc.bold('mutant check')}  baseline ${base}  ${pc.dim(`${report.wallclockSec.toFixed(1)}s`)}`);
  if (report.baseline.failures.length > 0) {
    printLine(ctx, `  ${pc.red('✗')} baseline fails ${report.baseline.failures.join(', ')}; mutants must be written against a passing contract`);
  }
  const idWidth = Math.max(...report.results.map((r) => r.invariantId.length), 5);
  for (const r of report.results) {
    const time = r.wallclockSec !== undefined ? pc.dim(`${r.wallclockSec.toFixed(1)}s`) : '';
    const also = r.otherFailures.length > 0 ? pc.dim(`also fails ${r.otherFailures.join(', ')}`) : '';
    const cols = [`  ${markOf(r)} ${r.invariantId.padEnd(idWidth)}`, r.status.padEnd(8), r.patchPath, time, also];
    printLine(ctx, cols.filter(Boolean).join('  '));
    if (!r.broke && r.detail && r.status !== 'skipped') printLine(ctx, `      ${pc.dim(r.detail.split('\n')[0] ?? '')}`);
  }
  const total = report.results.length;
  printLine(
    ctx,
    report.ok ? pc.green(`${passed}/${total} mutants broke their invariant`) : pc.red(`mutant check failed (${passed}/${total} broke)`),
  );
}

export function registerLockCommand(program: Command, deps: LockCommandDeps = {}): void {
  program
    .command('lock <spec>')
    .description('Run the mutant check, then compute specHash/invariantSetHash/propertyHash and write .specfirst/lock.json.')
    .option('--baseline <file>', 'passing implementation copied onto contract.path before the mutants are applied (e.g. fixed/StakingVault.sol)')
    .option('--skip-mutants', 'lock without the mutant check; recorded as mutantsSkipped: true in lock.json')
    .option('--runs <n>', 'invariant runs per mutant campaign', String(DEFAULT_RUNS))
    .option('--depth <n>', 'calls per invariant run', String(DEFAULT_DEPTH))
    .option('--timeout <s>', 'wall-clock limit per forge campaign, seconds', String(DEFAULT_TIMEOUT_SEC))
    .option('--seed <seed>', 'fuzz seed (decimal or 0x hex) for reproducible mutant campaigns')
    .option('--keep-worktree', 'leave the mutant checkout in place for debugging')
    .action(async (specArg: string, opts: LockOptions, command: Command) => {
      const ctx = contextFrom(command);
      const specPath = path.resolve(ctx.projectDir, specArg);

      let specText: string;
      try {
        specText = await readFile(specPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error(`specfirst lock: spec file not found: ${specPath}`);
          process.exitCode = SPEC_ERROR_EXIT_CODE;
          return;
        }
        throw err;
      }

      let spec;
      try {
        spec = parseSpec(specText);
      } catch (err) {
        if (err instanceof SpecError) {
          console.error(err.message);
          process.exitCode = SPEC_ERROR_EXIT_CODE;
          return;
        }
        throw err;
      }

      let params: FuzzParams;
      try {
        params = {
          runs: positiveInt('runs', opts.runs),
          depth: positiveInt('depth', opts.depth),
          timeoutSec: positiveInt('timeout', opts.timeout),
          ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
        };
      } catch (err) {
        console.error(`specfirst lock: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }

      // The mutant check gates the lock: nothing is written unless every property is broken by its mutant.
      let report: MutantCheckReport | null = null;
      if (opts.skipMutants) {
        console.error(pc.yellow('specfirst lock: warning: mutant check skipped (--skip-mutants); lock.json records mutantsSkipped: true'));
      } else {
        const artifactDir = path.join(ctx.projectDir, LOCK_DIR, 'mutants-forge');
        const backend = deps.backend ? deps.backend(artifactDir) : new ForgeBackend({ artifactDir });
        try {
          report = await runMutantCheck({
            projectDir: ctx.projectDir,
            spec,
            backend,
            params,
            ...(opts.baseline ? { baseline: opts.baseline } : {}),
            ...(opts.keepWorktree ? { keepWorktree: true } : {}),
            onEvent: (e) => emitEvent(ctx, e),
          });
        } catch (err) {
          if (err instanceof MutantCheckError) {
            console.error(`specfirst lock: ${err.message}`);
            process.exitCode = 1;
            return;
          }
          throw err;
        }
        emitEvent(ctx, { type: 'mutant.done', ok: report.ok, wallclockSec: report.wallclockSec, results: report.results });
        printReport(ctx, report);
        if (!report.ok) {
          console.error(`specfirst lock: mutant check failed, lock refused; see ${path.relative(ctx.projectDir, mutantsReportPath(ctx.projectDir))}`);
          process.exitCode = MUTANT_CHECK_EXIT_CODE;
          return;
        }
      }

      try {
        const lock = await createLock({ projectDir: ctx.projectDir, spec, specPath });
        await annotateLock(
          ctx.projectDir,
          report
            ? { mutantsSkipped: false, mutants: { report: `${LOCK_DIR}/mutants.json`, baseline: report.baseline.source } }
            : { mutantsSkipped: true },
        );
        emitEvent(ctx, {
          type: 'lock.done',
          lockPath: path.relative(ctx.projectDir, path.join(ctx.projectDir, LOCK_DIR, 'lock.json')),
          specHash: lock.specHash,
          invariantSetHash: lock.invariantSetHash,
          propertyHash: lock.propertyHash,
          mutantsSkipped: report === null,
        });

        printLine(ctx, `${pc.bold('specHash:')}         ${lock.specHash}`);
        printLine(ctx, `${pc.bold('invariantSetHash:')}  ${lock.invariantSetHash}`);
        printLine(ctx, `${pc.bold('propertyHash:')}      ${lock.propertyHash}`);
        printLine(ctx, `wrote .specfirst/lock.json (${lock.properties.length} property file(s) locked)`);
        if (!report) printLine(ctx, pc.yellow('mutants skipped: this lock is not backed by a mutant check'));
      } catch (err) {
        if (err instanceof LockError) {
          console.error(`specfirst lock: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
