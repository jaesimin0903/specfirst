import { existsSync, readFileSync } from 'node:fs';
import { readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockBackend, type FuzzRunInput, type InvariantResult, type MockScenario } from '@specfirst/core';
import { registerLockCommand } from '../src/commands/lock.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';
import { sampleRepo } from './helpers/sampleRepo.js';

const SPEC = 'spec/staking-vault.spec.yaml';
const IDS = ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7'];

const fail = (invariantId: string): InvariantResult => ({
  invariantId,
  status: 'fail',
  counterexample: { invariantId, callSequence: [], reason: `${invariantId} broken`, source: 'forge' },
});

/** The fixed sample debits before it pays; the planted bug pays first. */
function isFixed(i: FuzzRunInput): boolean {
  const src = readFileSync(path.join(i.worktree, 'src/StakingVault.sol'), 'utf8');
  return src.indexOf('balances[msg.sender] = bal - amount') < src.indexOf('msg.sender.call');
}

/** Baseline passes only on the fixed contract; mutant k fails INV-k unless listed in `survivors`. */
function scenarios(survivors: string[] = []): MockScenario[] {
  const baseline: MockScenario = (i) => IDS.map((id) => (isFixed(i) ? { invariantId: id, status: 'pass' } : fail(id)));
  const mutants = IDS.map(
    (target): MockScenario => () => IDS.map((id) => (id === target && !survivors.includes(id) ? fail(id) : { invariantId: id, status: 'pass' })),
  );
  return [baseline, ...mutants];
}

describe('specfirst lock', () => {
  let dir: string;
  let backend: MockBackend;

  const lock = (...args: string[]) =>
    capture(() =>
      buildProgram((p) => registerLockCommand(p, { backend: () => backend })).parseAsync([
        'node',
        'specfirst',
        '--project',
        dir,
        'lock',
        SPEC,
        ...args,
      ]),
    );
  const lockJson = async () => JSON.parse(await readFile(path.join(dir, '.specfirst/lock.json'), 'utf8'));

  beforeEach(async () => {
    dir = await sampleRepo();
    process.exitCode = undefined;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('runs the mutant check against --baseline, prints the per-invariant table, then writes lock.json', async () => {
    backend = new MockBackend(scenarios());
    const { out } = await lock('--baseline', 'fixed/StakingVault.sol');

    expect(process.exitCode ?? 0).toBe(0);
    expect(backend.calls).toBe(8);
    expect(out[0]).toMatch(/^mutant check {2}baseline fixed\/StakingVault\.sol/);
    for (const id of IDS) expect(out).toContainEqual(expect.stringMatching(new RegExp(`^ {2}✓ ${id} {2}broke {5}test/specfirst/mutants/${id}\\.patch`)));
    expect(out).toContain('7/7 mutants broke their invariant');
    expect(out.some((l) => l.includes('mutant check: not implemented yet'))).toBe(false);
    expect(out.some((l) => l.startsWith('specHash:'))).toBe(true);
    expect(out.some((l) => l.startsWith('invariantSetHash:'))).toBe(true);
    expect(out.some((l) => l.startsWith('propertyHash:'))).toBe(true);

    const written = await lockJson();
    expect(written.specHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(written.mutantsSkipped).toBe(false);
    expect(written.mutants).toEqual({ report: '.specfirst/mutants.json', baseline: 'fixed/StakingVault.sol' });
    // The mutant patches are property files, so they are part of propertyHash.
    expect(written.properties.map((f: { path: string }) => f.path)).toContain('test/specfirst/mutants/INV-7.patch');

    const report = JSON.parse(await readFile(path.join(dir, '.specfirst/mutants.json'), 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.results.map((r: { invariantId: string; broke: boolean }) => [r.invariantId, r.broke])).toEqual(IDS.map((id) => [id, true]));
  });

  it('exits 3 and writes no lock when a property survives its mutant', async () => {
    backend = new MockBackend(scenarios(['INV-5']));
    const { out, err } = await lock('--baseline', 'fixed/StakingVault.sol');

    expect(process.exitCode).toBe(3);
    expect(out).toContainEqual(expect.stringMatching(/^ {2}✗ INV-5 {2}survived/));
    expect(out).toContain('mutant check failed (6/7 broke)');
    expect(err.join('\n')).toContain('lock refused');
    expect(existsSync(path.join(dir, '.specfirst/lock.json'))).toBe(false);
  });

  it('exits 3 when a mutant patch is missing, without running forge', async () => {
    backend = new MockBackend([]);
    await unlink(path.join(dir, 'test/specfirst/mutants/INV-2.patch'));
    const { out } = await lock('--baseline', 'fixed/StakingVault.sol');

    expect(process.exitCode).toBe(3);
    expect(backend.calls).toBe(0);
    expect(out).toContainEqual(expect.stringMatching(/^ {2}✗ INV-2 {2}missing/));
    expect(existsSync(path.join(dir, '.specfirst/lock.json'))).toBe(false);
  });

  it('exits 3 when the contract under lock does not pass (no --baseline on the buggy sample)', async () => {
    backend = new MockBackend(scenarios());
    const { out } = await lock();

    expect(process.exitCode).toBe(3);
    expect(backend.calls).toBe(1);
    expect(out.join('\n')).toContain('baseline fails INV-1, INV-2, INV-3, INV-4, INV-5, INV-6, INV-7');
    expect(existsSync(path.join(dir, '.specfirst/lock.json'))).toBe(false);
  });

  it('--skip-mutants locks without the check, warns, and records mutantsSkipped: true', async () => {
    backend = new MockBackend([]);
    const { out, err } = await lock('--skip-mutants');

    expect(process.exitCode ?? 0).toBe(0);
    expect(backend.calls).toBe(0);
    expect(err.join('\n')).toContain('warning: mutant check skipped');
    expect(out.some((l) => l.startsWith('mutant check'))).toBe(false);
    expect(out).toContain('mutants skipped: this lock is not backed by a mutant check');
    expect((await lockJson()).mutantsSkipped).toBe(true);
  });

  it('emits NDJSON mutant events with --json', async () => {
    backend = new MockBackend(scenarios());
    const { stdout } = await capture(() =>
      buildProgram((p) => registerLockCommand(p, { backend: () => backend })).parseAsync([
        'node', 'specfirst', '--json', '--project', dir, 'lock', SPEC, '--baseline', 'fixed/StakingVault.sol',
      ]),
    );
    const types = stdout.trim().split('\n').map((l) => JSON.parse(l).type);
    expect(types).toEqual(['mutant.baseline', ...IDS.map(() => 'mutant.result'), 'mutant.done', 'lock.done']);
  });

  it('exits 1 when --baseline does not exist', async () => {
    backend = new MockBackend([]);
    const { err } = await lock('--baseline', 'fixed/Nope.sol');
    expect(process.exitCode).toBe(1);
    expect(err.join('\n')).toContain('baseline file not found');
  });

  it('exits with code 2 when the spec file is missing', async () => {
    backend = new MockBackend([]);
    await capture(() =>
      buildProgram((p) => registerLockCommand(p, { backend: () => backend })).parseAsync([
        'node', 'specfirst', '--project', dir, 'lock', 'spec/does-not-exist.yaml',
      ]),
    );
    expect(process.exitCode).toBe(2);
  });
});
