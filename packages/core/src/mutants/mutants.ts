import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { FuzzBackend, FuzzParams, FuzzResult } from '../fuzz/types.js';
import { LOCK_DIR, PROPERTIES_DIR, lockPath } from '../lock/lock.js';
import { checkEditable } from '../loop/guard.js';
import { createWorktree, removeWorktree } from '../loop/worktree.js';
import type { Spec } from '../spec/schema.js';

/**
 * Mutant check (plan 3.1): every invariant needs a minimal patch that breaks it, and the locked
 * property suite must actually fail that invariant on the patched contract. A property that
 * survives its own mutant is vacuous, so `specfirst lock` refuses it with exit 3.
 *
 * Layout: `test/specfirst/mutants/<INV-id>.patch`, a git diff against the project root that may
 * only touch paths under `contract.editable`. The patches live under test/specfirst, so they are
 * part of propertyHash like every other property file.
 *
 * Baseline rule: the mutants are written against a passing implementation. Before any mutant is
 * applied, the baseline (the current contract, or the file given as `baseline`, copied onto
 * `contract.path`) must pass every invariant. Otherwise nothing is judged and the check fails.
 */
export const MUTANTS_DIR = `${PROPERTIES_DIR}/mutants`;
/** Written to <projectDir>/.specfirst/mutants.json by runMutantCheck. */
export const MUTANTS_FILE = 'mutants.json';

export function mutantPatchPath(invariantId: string): string {
  return `${MUTANTS_DIR}/${invariantId}.patch`;
}

export function mutantsReportPath(projectDir: string): string {
  return path.join(projectDir, LOCK_DIR, MUTANTS_FILE);
}

/**
 * - broke: the targeted invariant failed on the mutant (the only passing status).
 * - survived: the targeted invariant still passed.
 * - error: forge could not judge the targeted invariant (compile error, timeout, setUp failure).
 * - missing: no patch file.
 * - invalid: the patch does not apply, is empty, or touches a path outside contract.editable.
 * - skipped: not run because the check had already failed before forge (missing patch, failing baseline).
 */
export type MutantStatus = 'broke' | 'survived' | 'error' | 'missing' | 'invalid' | 'skipped';

export interface MutantCheckResult {
  invariantId: string;
  /** Relative to the project root, forward slashes. */
  patchPath: string;
  /** True only when the targeted invariant failed on the mutant. */
  broke: boolean;
  /** Other invariants that failed or errored on the same mutant. Informational, never a failure. */
  otherFailures: string[];
  status: MutantStatus;
  detail?: string;
  wallclockSec?: number;
}

export interface MutantBaseline {
  /** The file copied onto contract.path, or null when the contract was used as is. */
  source: string | null;
  /** Invariants that did not pass on the baseline. Non-empty means the check failed. */
  failures: string[];
  wallclockSec?: number;
}

export interface MutantCheckReport {
  ok: boolean;
  createdAt: string;
  /** spec contract.path, null when the spec leaves the contract to the implement step. */
  contractPath: string | null;
  baseline: MutantBaseline;
  params: FuzzParams;
  wallclockSec: number;
  results: MutantCheckResult[];
}

export type MutantEvent =
  | { type: 'mutant.baseline'; failures: string[]; wallclockSec: number }
  | { type: 'mutant.result'; result: MutantCheckResult };

export interface RunMutantCheckInput {
  projectDir: string;
  spec: Spec;
  backend: FuzzBackend;
  params: FuzzParams;
  /** File (relative to projectDir or absolute) copied onto contract.path before the baseline run. */
  baseline?: string;
  /** Keep the isolated checkout for debugging. */
  keepWorktree?: boolean;
  /** Where the report goes. Defaults to <projectDir>/.specfirst/mutants.json; null skips writing. */
  reportPath?: string | null;
  onEvent?: (e: MutantEvent) => void;
}

export class MutantCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutantCheckError';
  }
}

const toPosix = (p: string) => p.split(path.sep).join('/');

async function gitOut(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd, stripFinalNewline: false });
  return String(stdout);
}

/** Repository-relative prefix of projectDir ("" at the root, "examples/x/" below it), or null outside git. */
async function gitPrefix(projectDir: string): Promise<string | null> {
  try {
    await gitOut(projectDir, ['rev-parse', '--verify', 'HEAD^{commit}']);
    return (await gitOut(projectDir, ['rev-parse', '--show-prefix'])).trim();
  } catch {
    return null;
  }
}

function splitZ(text: string): string[] {
  return text.split('\0').filter(Boolean);
}

interface Sandbox {
  /** The project root inside the isolated checkout. */
  dir: string;
  /** Repository-relative prefix passed to git apply --directory, "" when none. */
  prefix: string;
  dispose(): Promise<void>;
}

const COPY_SKIP = new Set(['.specfirst', 'out', 'cache', '.git', 'node_modules']);

/**
 * Isolated copy of the current working tree. In a git repository this is a detached worktree
 * (loop/worktree.ts) with uncommitted and untracked files laid over it, so the check sees exactly
 * what `lock` hashes. Outside git it is a plain copy in the temp directory.
 */
async function createSandbox(projectDir: string, keep: boolean): Promise<Sandbox> {
  const prefix = await gitPrefix(projectDir);
  if (prefix === null) {
    const root = await mkdtemp(path.join(tmpdir(), 'specfirst-mutants-'));
    await cp(projectDir, root, {
      recursive: true,
      filter: (src) => !COPY_SKIP.has(path.relative(projectDir, src).split(path.sep)[0] ?? ''),
    });
    return { dir: root, prefix: '', dispose: () => (keep ? Promise.resolve() : rm(root, { recursive: true, force: true })) };
  }

  // Read the working tree state before the worktree itself appears under .specfirst/.
  const changed = splitZ(await gitOut(projectDir, ['ls-files', '-z', '--modified', '--others', '--exclude-standard'])).filter(
    (rel) => !rel.startsWith(`${LOCK_DIR}/`) && !rel.endsWith('/'),
  );
  const deleted = splitZ(await gitOut(projectDir, ['ls-files', '-z', '--deleted']));
  const runId = `mutants-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const wt = await createWorktree(projectDir, runId, 0);
  const dir = path.join(wt.path, prefix);
  // Lay the working tree over the committed checkout: modified and untracked files, then deletions.
  for (const rel of changed) {
    const from = path.join(projectDir, rel);
    if (!existsSync(from)) continue;
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await copyFile(from, path.join(dir, rel));
  }
  for (const rel of deleted) {
    await rm(path.join(dir, rel), { force: true });
  }
  // Dependencies kept outside git (ignored, not a submodule) are copied from the project.
  const lib = path.join(projectDir, 'lib');
  if (existsSync(lib) && !existsSync(path.join(dir, 'lib'))) {
    await cp(lib, path.join(dir, 'lib'), { recursive: true, verbatimSymlinks: true });
  }
  return {
    dir,
    prefix,
    dispose: async () => {
      if (keep) return;
      await removeWorktree(projectDir, wt.path);
      // The per-check parent (.specfirst/worktrees/<runId>) belongs to this check alone.
      await rm(path.dirname(wt.path), { recursive: true, force: true });
    },
  };
}

/** Paths a patch touches, relative to the project root. Throws when git cannot read the patch. */
async function patchPaths(sandbox: Sandbox, patchFile: string): Promise<string[]> {
  const args = ['apply', '--numstat', '-z'];
  if (sandbox.prefix) args.push(`--directory=${sandbox.prefix}`);
  const out = await gitOut(sandbox.dir, [...args, patchFile]);
  // -z numstat: "<added>\t<deleted>\t<path>\0"; renames: "<a>\t<d>\t\0<from>\0<to>\0".
  const paths: string[] = [];
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = /^[0-9-]+\t[0-9-]+\t(.*)$/.exec(parts[i]!);
    if (!m) continue;
    if (m[1]) paths.push(m[1]);
    else {
      if (parts[i + 1]) paths.push(parts[i + 1]!);
      if (parts[i + 2]) paths.push(parts[i + 2]!);
      i += 2;
    }
  }
  const strip = sandbox.prefix;
  return paths.map((p) => (strip && p.startsWith(strip) ? p.slice(strip.length) : p));
}

async function gitApply(sandbox: Sandbox, patchFile: string): Promise<void> {
  const args = ['apply', '--whitespace=nowarn'];
  if (sandbox.prefix) args.push(`--directory=${sandbox.prefix}`);
  await execa('git', [...args, patchFile], { cwd: sandbox.dir });
}

/** Saves the given project-relative files so a mutant can be undone without touching git state. */
async function snapshot(dir: string, rels: string[]): Promise<() => Promise<void>> {
  const saved = await Promise.all(
    rels.map(async (rel) => {
      const abs = path.join(dir, rel);
      return { abs, data: existsSync(abs) ? await readFile(abs) : null };
    }),
  );
  return async () => {
    for (const s of saved) {
      if (s.data === null) await rm(s.abs, { force: true });
      else {
        await mkdir(path.dirname(s.abs), { recursive: true });
        await writeFile(s.abs, s.data);
      }
    }
  };
}

function notPassing(fuzz: FuzzResult): string[] {
  return fuzz.results.filter((r) => r.status !== 'pass').map((r) => r.invariantId);
}

function resultDetail(fuzz: FuzzResult, id: string): string | undefined {
  const r = fuzz.results.find((x) => x.invariantId === id);
  if (!r) return `no result for ${id}`;
  if (r.status === 'error') return (r.error ?? 'forge error').split('\n').slice(0, 5).join('\n');
  if (r.status === 'fail') return r.counterexample?.reason;
  return `${id} still passes on the mutant`;
}

type Planned = { invariantId: string; patchPath: string; abs: string };

/**
 * Runs the baseline and then one mutant per invariant in a single isolated checkout, restoring the
 * touched files after each mutant so forge can compile incrementally. Always returns a report
 * (ok=false on any missing, invalid, surviving or erroring mutant, or a failing baseline) and
 * writes it to mutants.json; throws only when the baseline file itself is missing.
 */
export async function runMutantCheck(input: RunMutantCheckInput): Promise<MutantCheckReport> {
  const { projectDir, spec, backend, params } = input;
  const started = Date.now();
  const createdAt = new Date(started).toISOString();
  const contractPath = spec.contract.path ? toPosix(spec.contract.path) : null;

  let baselineAbs: string | null = null;
  if (input.baseline) {
    baselineAbs = path.resolve(projectDir, input.baseline);
    if (!existsSync(baselineAbs)) throw new MutantCheckError(`baseline file not found: ${input.baseline}`);
    if (!contractPath) throw new MutantCheckError('a baseline needs contract.path in the spec');
  }
  const baselineSource = baselineAbs ? toPosix(path.relative(projectDir, baselineAbs)) : null;

  const finish = async (baseline: MutantBaseline, results: MutantCheckResult[]): Promise<MutantCheckReport> => {
    const report: MutantCheckReport = {
      ok: baseline.failures.length === 0 && results.length > 0 && results.every((r) => r.broke),
      createdAt,
      contractPath,
      baseline,
      params,
      wallclockSec: (Date.now() - started) / 1000,
      results,
    };
    const out = input.reportPath === undefined ? mutantsReportPath(projectDir) : input.reportPath;
    if (out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    }
    return report;
  };

  const planned: Planned[] = spec.invariants.map(({ id }) => ({
    invariantId: id,
    patchPath: mutantPatchPath(id),
    abs: path.join(projectDir, mutantPatchPath(id)),
  }));
  const skipped = (p: Planned, detail: string): MutantCheckResult => ({
    invariantId: p.invariantId,
    patchPath: p.patchPath,
    broke: false,
    otherFailures: [],
    status: 'skipped',
    detail,
  });

  // Missing patches fail the check before any forge run.
  if (planned.some((p) => !existsSync(p.abs))) {
    const results = planned.map((p): MutantCheckResult =>
      existsSync(p.abs)
        ? skipped(p, 'not run: another mutant patch is missing')
        : { invariantId: p.invariantId, patchPath: p.patchPath, broke: false, otherFailures: [], status: 'missing', detail: `no ${p.patchPath}` },
    );
    for (const result of results) input.onEvent?.({ type: 'mutant.result', result });
    return finish({ source: baselineSource, failures: [] }, results);
  }

  const sandbox = await createSandbox(projectDir, input.keepWorktree ?? false);
  const persistRoot = await mkdtemp(path.join(tmpdir(), 'specfirst-mutant-persist-'));
  try {
    let n = 0;
    // A fresh failure corpus per forge call: a persisted counterexample must not leak across mutants.
    const judge = () => backend.run({ worktree: sandbox.dir, spec, params, persistDir: path.join(persistRoot, String(n++)) });

    if (baselineAbs && contractPath) {
      await mkdir(path.dirname(path.join(sandbox.dir, contractPath)), { recursive: true });
      await copyFile(baselineAbs, path.join(sandbox.dir, contractPath));
    }
    const base = await judge();
    const baseline: MutantBaseline = { source: baselineSource, failures: notPassing(base), wallclockSec: base.wallclockSec };
    input.onEvent?.({ type: 'mutant.baseline', failures: baseline.failures, wallclockSec: base.wallclockSec });
    if (baseline.failures.length > 0) {
      const detail = `not run: baseline fails ${baseline.failures.join(', ')}`;
      return await finish(baseline, planned.map((p) => skipped(p, detail)));
    }

    const results: MutantCheckResult[] = [];
    for (const p of planned) {
      const result = await checkOne(sandbox, spec, p, judge);
      results.push(result);
      input.onEvent?.({ type: 'mutant.result', result });
    }
    return await finish(baseline, results);
  } finally {
    await rm(persistRoot, { recursive: true, force: true });
    await sandbox.dispose();
  }
}

async function checkOne(sandbox: Sandbox, spec: Spec, p: Planned, judge: () => Promise<FuzzResult>): Promise<MutantCheckResult> {
  const base = { invariantId: p.invariantId, patchPath: p.patchPath, broke: false, otherFailures: [] as string[] };
  const invalid = (detail: string): MutantCheckResult => ({ ...base, status: 'invalid', detail });

  let touched: string[];
  try {
    touched = await patchPaths(sandbox, p.abs);
  } catch (err) {
    return invalid(`cannot read patch: ${firstLine(err)}`);
  }
  if (touched.length === 0) return invalid('patch changes no file');
  const outside = checkEditable(touched, spec.contract.editable);
  if (outside.length > 0) return invalid(`patch touches paths outside contract.editable: ${outside.join(', ')}`);

  const restore = await snapshot(sandbox.dir, touched);
  try {
    try {
      await gitApply(sandbox, p.abs);
    } catch (err) {
      return invalid(`patch does not apply: ${firstLine(err)}`);
    }
    const fuzz = await judge();
    const target = fuzz.results.find((r) => r.invariantId === p.invariantId);
    const status: MutantStatus = target?.status === 'fail' ? 'broke' : target?.status === 'pass' ? 'survived' : 'error';
    const detail = resultDetail(fuzz, p.invariantId);
    return {
      ...base,
      broke: status === 'broke',
      otherFailures: notPassing(fuzz).filter((id) => id !== p.invariantId),
      status,
      ...(detail ? { detail } : {}),
      wallclockSec: fuzz.wallclockSec,
    };
  } finally {
    await restore();
  }
}

function firstLine(err: unknown): string {
  const e = err as { stderr?: unknown; message?: string };
  const text = (typeof e.stderr === 'string' && e.stderr.trim()) || e.message || String(err);
  return text.trim().split('\n')[0] ?? '';
}

/**
 * Adds fields to an existing .specfirst/lock.json without touching the locked hashes, e.g.
 * `{ mutantsSkipped: true }`. verifyLock ignores keys it does not know.
 */
export async function annotateLock(projectDir: string, fields: Record<string, unknown>): Promise<void> {
  const file = lockPath(projectDir);
  const lock = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  await writeFile(file, `${JSON.stringify({ ...lock, ...fields }, null, 2)}\n`);
}
