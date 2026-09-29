import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { FuzzBackend, FuzzResult, FuzzRunInput, InvariantResult } from './types.js';

/** The locked invariant test file every project carries (plan 2). */
export const INVARIANTS_TEST_PATH = 'test/specfirst/Invariants.t.sol';

export class ForgeOutputError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = 'ForgeOutputError';
  }
}

/**
 * Maps a forge test name onto a spec invariant id.
 * `invariant_INV_1()` becomes `INV-1`: the prefix and parentheses are dropped and underscores become hyphens.
 * Returns null for anything that is not an invariant test (setUp, afterInvariant, unit tests).
 */
export function invariantIdFromTestName(name: string): string | null {
  const m = /^invariant_([A-Za-z0-9_]+?)(?:\(\))?$/.exec(name);
  return m ? m[1]!.replace(/_/g, '-') : null;
}

export interface ForgeCall {
  sender?: string;
  addr?: string;
  calldata?: string;
  contract_name?: string | null;
  func_name?: string | null;
  signature?: string | null;
  args?: string | null;
  raw_args?: string | null;
}

export interface ForgeTestResult {
  status: string;
  reason: string | null;
  counterexample: null | { Sequence?: unknown; Single?: unknown };
  /** Filled with -vv or higher, e.g. the "a <=~ b not satisfied" lines of an assertion. */
  decoded_logs?: string[];
  kind?: { Invariant?: { runs?: number; calls?: number }; Fuzz?: { runs?: number } };
}

interface ForgeSuite {
  duration?: string;
  test_results: Record<string, ForgeTestResult>;
}

/** One line per call: `Handler.withdraw(5) sender=0x.. target=0x..`. Falls back to raw calldata when unnamed. */
export function formatForgeCall(c: ForgeCall): string {
  const contract = c.contract_name ? c.contract_name.split(':').pop() : c.addr;
  const call = c.func_name ? `${c.func_name}(${c.raw_args ?? c.args ?? ''})` : `calldata ${c.calldata ?? ''}`;
  return `${contract}.${call} sender=${c.sender ?? '?'} target=${c.addr ?? '?'}`;
}

/**
 * forge 1.x writes `{"Sequence": [originalLength, [calls...]]}` for invariant failures.
 * Older builds and fuzz tests use `{"Sequence": [calls...]}` or `{"Single": call}`; all three are accepted.
 */
export function callsOf(ce: ForgeTestResult['counterexample']): ForgeCall[] {
  if (!ce) return [];
  if (ce.Single && typeof ce.Single === 'object') return [ce.Single as ForgeCall];
  const seq = ce.Sequence;
  if (!Array.isArray(seq)) return [];
  const list = seq.length === 2 && typeof seq[0] === 'number' && Array.isArray(seq[1]) ? seq[1] : seq;
  return (list as unknown[]).filter((c): c is ForgeCall => !!c && typeof c === 'object');
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Some forge builds print warnings before the JSON document; take the last line that parses.
    const lines = trimmed.split('\n').reverse();
    for (const line of lines) {
      if (!line.startsWith('{')) continue;
      try {
        return JSON.parse(line);
      } catch {
        /* keep looking */
      }
    }
    return undefined;
  }
}

const SETUP_ERROR = /^failed to set up|no contracts to fuzz/i;

/**
 * Parses `forge test --json` stdout into per-invariant results.
 *
 * - `Success` is pass. `Failure` with a counterexample, or with a plain assertion reason, is fail.
 * - A failing `setUp()` makes every invariant of that suite an error; so does forge's own set-up message.
 * - When `expectedIds` is given, the output is ordered by it and every id without a test becomes an error.
 * - Output that is not JSON (compile failure) turns every expected id into an error carrying the output;
 *   with no expected ids it throws ForgeOutputError.
 */
export function parseForgeJson(text: string, expectedIds: readonly string[] = []): FuzzResult['results'] {
  const doc = extractJson(text);
  if (!doc || typeof doc !== 'object') {
    const output = text.trim() || 'forge produced no output';
    if (expectedIds.length === 0) throw new ForgeOutputError('forge output is not JSON', output);
    return expectedIds.map((invariantId) => ({ invariantId, status: 'error', error: output }));
  }

  const found = new Map<string, InvariantResult>();
  let setupFailure: string | null = null;
  for (const suite of Object.values(doc as Record<string, ForgeSuite>)) {
    if (!suite || typeof suite !== 'object' || !suite.test_results) continue;
    for (const [name, r] of Object.entries(suite.test_results)) {
      if (name.startsWith('setUp') && r.status !== 'Success') {
        setupFailure = `setUp failed: ${r.reason ?? 'unknown reason'}`;
        continue;
      }
      const id = invariantIdFromTestName(name);
      if (!id) continue;
      found.set(id, toResult(id, r));
    }
  }

  const ids = expectedIds.length > 0 ? [...expectedIds] : [...found.keys()];
  for (const id of found.keys()) if (!ids.includes(id)) ids.push(id);
  return ids.map(
    (id) =>
      found.get(id) ?? {
        invariantId: id,
        status: 'error',
        error: setupFailure ?? `no invariant_${id.replace(/-/g, '_')} test in forge output`,
      },
  );
}

function toResult(invariantId: string, r: ForgeTestResult): InvariantResult {
  if (r.status === 'Success') return { invariantId, status: 'pass' };
  const reason = r.reason ?? '';
  if (r.status !== 'Failure' || (!r.counterexample && SETUP_ERROR.test(reason))) {
    return { invariantId, status: 'error', error: reason || `forge status ${r.status}` };
  }
  return {
    invariantId,
    status: 'fail',
    counterexample: {
      invariantId,
      callSequence: callsOf(r.counterexample).map(formatForgeCall),
      reason: reason || 'invariant failed',
      source: 'forge',
    },
  };
}

function countCalls(text: string): number | undefined {
  const doc = extractJson(text) as Record<string, ForgeSuite> | undefined;
  if (!doc) return undefined;
  let total = 0;
  for (const suite of Object.values(doc)) {
    for (const r of Object.values(suite?.test_results ?? {})) total += r.kind?.Invariant?.calls ?? 0;
  }
  return total;
}

export interface ForgeBackendOptions {
  forgeBin?: string;
  /**
   * Where raw stdout and build output go, plus the failure corpus when the caller passes no persistDir.
   * Kept outside the worktree so collectChanges never sees them.
   */
  artifactDir?: string;
}

/** Judge backend: runs the locked Foundry invariant suite (plan decision A2). */
export class ForgeBackend implements FuzzBackend {
  readonly name = 'forge' as const;
  readonly role = 'judge' as const;
  private readonly forgeBin: string;
  private readonly artifactDir: string;
  private calls = 0;

  constructor(opts: ForgeBackendOptions = {}) {
    this.forgeBin = opts.forgeBin ?? 'forge';
    this.artifactDir = opts.artifactDir ?? path.join(tmpdir(), 'specfirst-forge');
  }

  async run({ worktree, spec, params, persistDir, target, forkUrl, forkBlockNumber, env: extraEnv }: FuzzRunInput): Promise<FuzzResult> {
    const n = ++this.calls;
    await mkdir(this.artifactDir, { recursive: true });
    const failurePersistDir = persistDir ?? path.join(this.artifactDir, `forge-persist-${Date.now()}-${n}`);
    await mkdir(failurePersistDir, { recursive: true });
    const env: Record<string, string> = {
      FOUNDRY_INVARIANT_RUNS: String(params.runs),
      FOUNDRY_INVARIANT_DEPTH: String(params.depth),
      FOUNDRY_OUT: path.join(this.artifactDir, 'out'),
      FOUNDRY_CACHE_PATH: path.join(this.artifactDir, 'cache'),
      // forge replays persisted failures before fuzzing; a fresh directory per call keeps runs independent.
      FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR: failurePersistDir,
    };
    if (params.seed !== undefined) env.FOUNDRY_FUZZ_SEED = params.seed;
    // Fork mode (plan 3.6 item 3): setUp attaches to SPECFIRST_TARGET instead of deploying.
    if (target !== undefined) env.SPECFIRST_TARGET = target;
    Object.assign(env, extraEnv ?? {});
    const args = ['test', '--match-path', INVARIANTS_TEST_PATH, '--json'];
    if (forkUrl !== undefined) {
      args.push('--fork-url', forkUrl);
      if (forkBlockNumber !== undefined) args.push('--fork-block-number', forkBlockNumber.toString());
    }

    const started = Date.now();
    const proc = await execa(this.forgeBin, args, {
      cwd: worktree,
      env,
      reject: false,
      timeout: params.timeoutSec * 1000,
      maxBuffer: 512 * 1024 * 1024,
      stripFinalNewline: false,
    });
    const wallclockSec = (Date.now() - started) / 1000;
    const stdout = String(proc.stdout ?? '');
    const stderr = String(proc.stderr ?? '');
    const rawArtifactPath = path.join(this.artifactDir, `forge-${n}.json`);
    await writeFile(rawArtifactPath, stdout);

    const ids = spec.invariants.map((i) => i.id);
    let results: FuzzResult['results'];
    if (proc.timedOut) {
      results = ids.map((invariantId) => ({
        invariantId,
        status: 'error',
        error: `forge timed out after ${params.timeoutSec}s`,
      }));
    } else if (extractJson(stdout) === undefined) {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n') || `forge exited ${proc.exitCode}`;
      results = parseForgeJson(output, ids);
    } else {
      results = parseForgeJson(stdout, ids);
    }
    if (params.seed !== undefined) {
      for (const r of results) if (r.counterexample) r.counterexample.seed = params.seed;
    }
    return { backend: 'forge', wallclockSec, executions: countCalls(stdout), results, rawArtifactPath };
  }
}
