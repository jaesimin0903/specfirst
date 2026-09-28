import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MockBackend,
  MutantCheckError,
  annotateLock,
  mutantPatchPath,
  runMutantCheck,
  type FuzzParams,
  type FuzzRunInput,
  type InvariantResult,
  type Spec,
} from '../src/index.js';
import { GIT_ID, VAULT, buildPatches, git, initRepo, loadSpec, vaultWith, writeFiles } from './helpers/repo.js';

const PARAMS: FuzzParams = { runs: 8, depth: 8, timeoutSec: 60 };
const IDS = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7'];

function source(i: FuzzRunInput): string {
  return readFileSync(path.join(i.worktree, 'src/StakingVault.sol'), 'utf8');
}

/**
 * Judges from the contract actually present in the checkout: a `// mutant INV-n` marker fails INV-n.
 * `ignore` lists markers the properties are blind to (a vacuous property), `also` extra ids that fail
 * alongside a given marker, `requireMarker` a line the baseline must carry to pass at all.
 */
function judge(
  opts: { ignore?: string[]; also?: Record<string, string[]>; requireMarker?: string; error?: string[]; seen?: string[] } = {},
) {
  return (i: FuzzRunInput): InvariantResult[] => {
    const src = source(i);
    opts.seen?.push(src);
    const hit = /\/\/ mutant (INV-\d+)/.exec(src)?.[1];
    const failing = new Set<string>();
    if (opts.requireMarker && !src.includes(opts.requireMarker)) IDS.forEach((id) => failing.add(id));
    if (hit && !opts.ignore?.includes(hit)) {
      failing.add(hit);
      for (const extra of opts.also?.[hit] ?? []) failing.add(extra);
    }
    return IDS.map((invariantId): InvariantResult => {
      if (hit && opts.error?.includes(hit) && invariantId === hit) return { invariantId, status: 'error', error: 'compile failed' };
      return failing.has(invariantId)
        ? { invariantId, status: 'fail', counterexample: { invariantId, callSequence: [], reason: `${invariantId} broken`, source: 'forge' } }
        : { invariantId, status: 'pass' };
    });
  };
}

/** One patch per invariant, each adding a `// mutant INV-n` line to `base`. */
async function writeMutants(repo: string, base = VAULT, only = IDS): Promise<void> {
  const patches = await buildPatches(
    repo,
    only.map((id) => ({ files: { 'src/StakingVault.sol': base.replace('    uint256 public totalStaked;\n', `    uint256 public totalStaked;\n    // mutant ${id}\n`) }, accept: false })),
  );
  // Left uncommitted on purpose: the check must see the working tree, like lock does.
  await writeFiles(repo, Object.fromEntries(only.map((id, k) => [mutantPatchPath(id), patches[k]!])));
}

describe('runMutantCheck', () => {
  let repo: string;
  let spec: Spec;

  beforeEach(async () => {
    repo = await initRepo();
    spec = await loadSpec();
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('passes when every mutant breaks its own invariant, and writes mutants.json', async () => {
    await writeMutants(repo);
    const seen: string[] = [];
    const backend = new MockBackend(Array.from({ length: 8 }, () => judge({ also: { 'INV-4': ['INV-3'] }, seen })));
    const events: string[] = [];
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS, onEvent: (e) => events.push(e.type) });

    expect(report.ok).toBe(true);
    expect(backend.calls).toBe(8); // baseline plus one per invariant
    expect(report.baseline).toMatchObject({ source: null, failures: [] });
    expect(report.results.map((r) => [r.invariantId, r.status, r.broke])).toEqual(IDS.map((id) => [id, 'broke', true]));
    expect(report.results.find((r) => r.invariantId === 'INV-4')!.otherFailures).toEqual(['INV-3']);
    expect(report.results[0]!.patchPath).toBe('test/specfirst/mutants/INV-1.patch');
    expect(events).toEqual(['mutant.baseline', ...IDS.map(() => 'mutant.result')]);

    // Each mutant is undone before the next: no run saw two markers, and the project itself is untouched.
    expect(seen.map((src) => src.match(/\/\/ mutant (INV-\d+)/g) ?? [])).toEqual([[], ...IDS.map((id) => [`// mutant ${id}`])]);
    expect(await readFile(path.join(repo, 'src/StakingVault.sol'), 'utf8')).toBe(VAULT);

    const saved = JSON.parse(await readFile(path.join(repo, '.specfirst/mutants.json'), 'utf8'));
    expect(saved.ok).toBe(true);
    expect(saved.results).toHaveLength(7);
    expect(saved.params).toEqual(PARAMS);

    // The isolated checkout is gone.
    expect(await git(repo, 'worktree', 'list')).not.toContain('mutants-');
    expect(await readdir(path.join(repo, '.specfirst/worktrees'))).toEqual([]);
  });

  it('fails when a mutant survives (the property is blind to it)', async () => {
    await writeMutants(repo);
    const backend = new MockBackend(Array.from({ length: 8 }, () => judge({ ignore: ['INV-5'] })));
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS });

    expect(report.ok).toBe(false);
    const inv5 = report.results.find((r) => r.invariantId === 'INV-5')!;
    expect(inv5).toMatchObject({ broke: false, status: 'survived', otherFailures: [] });
    expect(report.results.filter((r) => r.broke)).toHaveLength(6);
  });

  it('does not count a mutant that makes forge error out (e.g. compile failure) as broken', async () => {
    await writeMutants(repo);
    const backend = new MockBackend(Array.from({ length: 8 }, () => judge({ error: ['INV-2'] })));
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS });
    expect(report.ok).toBe(false);
    expect(report.results.find((r) => r.invariantId === 'INV-2')).toMatchObject({ broke: false, status: 'error', detail: 'compile failed' });
  });

  it('fails before any forge run when a patch file is missing', async () => {
    await writeMutants(repo, VAULT, IDS.filter((id) => id !== 'INV-7'));
    const backend = new MockBackend([]);
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS });

    expect(report.ok).toBe(false);
    expect(backend.calls).toBe(0);
    expect(report.results.find((r) => r.invariantId === 'INV-7')).toMatchObject({ status: 'missing', broke: false });
    expect(report.results.filter((r) => r.status === 'skipped')).toHaveLength(6);
    expect(existsSync(path.join(repo, '.specfirst/mutants.json'))).toBe(true);
  });

  it('fails without judging mutants when the baseline itself does not pass', async () => {
    await writeMutants(repo);
    const backend = new MockBackend([judge({ requireMarker: '// fixed' })]);
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS });

    expect(report.ok).toBe(false);
    expect(backend.calls).toBe(1);
    expect(report.baseline.failures).toEqual(IDS);
    expect(report.results.every((r) => r.status === 'skipped' && !r.broke)).toBe(true);
  });

  it('copies --baseline onto contract.path first, so mutants written against the fixed code apply', async () => {
    // Mutants are authored against the fixed code; the committed contract is still the buggy one.
    const fixed = vaultWith('fixed');
    await writeFiles(repo, { 'fixed/StakingVault.sol': fixed, 'src/StakingVault.sol': fixed });
    await git(repo, ...GIT_ID, 'commit', '-qam', 'fixed');
    await writeMutants(repo, fixed);
    await writeFiles(repo, { 'src/StakingVault.sol': VAULT });
    await git(repo, ...GIT_ID, 'commit', '-qam', 'buggy again');
    const backend = new MockBackend(Array.from({ length: 8 }, () => judge({ requireMarker: '// fixed' })));
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS, baseline: 'fixed/StakingVault.sol' });

    expect(report.ok).toBe(true);
    expect(report.baseline.source).toBe('fixed/StakingVault.sol');
    // The project's own (buggy) contract is left alone.
    expect(await readFile(path.join(repo, 'src/StakingVault.sol'), 'utf8')).toBe(VAULT);
  });

  it('marks a patch invalid when it does not apply or reaches outside contract.editable', async () => {
    await writeMutants(repo);
    const [outside] = await buildPatches(repo, [{ files: { 'test/specfirst/Invariants.t.sol': '// gutted\n' }, accept: false }]);
    await writeFiles(repo, {
      [mutantPatchPath('INV-3')]: outside!,
      [mutantPatchPath('INV-6')]: (await readFile(path.join(repo, mutantPatchPath('INV-6')), 'utf8')).replace('uint256 public totalStaked;', 'uint256 public nope;'),
    });
    const backend = new MockBackend(Array.from({ length: 6 }, () => judge()));
    const report = await runMutantCheck({ projectDir: repo, spec, backend, params: PARAMS });

    expect(report.ok).toBe(false);
    expect(backend.calls).toBe(6); // baseline plus the five valid mutants
    const inv3 = report.results.find((r) => r.invariantId === 'INV-3')!;
    expect(inv3.status).toBe('invalid');
    expect(inv3.detail).toContain('outside contract.editable');
    const inv6 = report.results.find((r) => r.invariantId === 'INV-6')!;
    expect(inv6.status).toBe('invalid');
    expect(inv6.detail).toContain('does not apply');
  });

  it('works on a project that is not a git repository', async () => {
    await writeMutants(repo);
    const plain = await mkdtemp(path.join(tmpdir(), 'specfirst-plain-'));
    try {
      await cp(repo, plain, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
      const backend = new MockBackend(Array.from({ length: 8 }, () => judge()));
      const report = await runMutantCheck({ projectDir: plain, spec, backend, params: PARAMS, reportPath: null });
      expect(report.ok).toBe(true);
      expect(existsSync(path.join(plain, '.specfirst/mutants.json'))).toBe(false);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('rejects a baseline path that does not exist', async () => {
    await writeMutants(repo);
    await expect(
      runMutantCheck({ projectDir: repo, spec, backend: new MockBackend([]), params: PARAMS, baseline: 'fixed/nope.sol' }),
    ).rejects.toBeInstanceOf(MutantCheckError);
  });
});

describe('annotateLock', () => {
  it('adds fields to lock.json and keeps the rest', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'specfirst-annotate-'));
    try {
      await writeFiles(dir, { '.specfirst/lock.json': JSON.stringify({ version: 1, specHash: '0xab' }) });
      await annotateLock(dir, { mutantsSkipped: true });
      expect(JSON.parse(await readFile(path.join(dir, '.specfirst/lock.json'), 'utf8'))).toEqual({
        version: 1,
        specHash: '0xab',
        mutantsSkipped: true,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

