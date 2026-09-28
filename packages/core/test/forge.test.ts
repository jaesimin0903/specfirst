import { realpathSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ForgeBackend,
  ForgeOutputError,
  formatForgeCall,
  invariantIdFromTestName,
  parseForgeJson,
  type Spec,
} from '../src/index.js';
import { loadSpec } from './helpers/repo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFile(path.join(here, 'fixtures/forge', name), 'utf8');

describe('invariantIdFromTestName', () => {
  it('maps invariant_INV_1 to INV-1 with or without parentheses', () => {
    expect(invariantIdFromTestName('invariant_INV_1()')).toBe('INV-1');
    expect(invariantIdFromTestName('invariant_INV_12')).toBe('INV-12');
  });
  it('ignores non-invariant tests', () => {
    expect(invariantIdFromTestName('setUp()')).toBeNull();
    expect(invariantIdFromTestName('afterInvariant()')).toBeNull();
    expect(invariantIdFromTestName('test_deposit()')).toBeNull();
  });
});

describe('parseForgeJson snapshots (forge 1.5.1)', () => {
  it('pass: every invariant passes', async () => {
    expect(parseForgeJson(await fx('pass.json'))).toEqual([
      { invariantId: 'INV-1', status: 'pass' },
      { invariantId: 'INV-2', status: 'pass' },
    ]);
  });

  it('fail: counterexample call sequence and reason come from forge', async () => {
    const results = parseForgeJson(await fx('fail.json'));
    expect(results.map((r) => [r.invariantId, r.status])).toEqual([
      ['INV-1', 'fail'],
      ['INV-2', 'pass'],
    ]);
    expect(results[0]!.counterexample).toEqual({
      invariantId: 'INV-1',
      source: 'forge',
      reason: 'INV-1: totalStaked != sum of balances: 376201893641224525 != 301753908837547104',
      callSequence: [
        'Handler.deposit(1111561464450649879556461314) sender=0x00000000000000000000000000000000000014bd target=0x2e234dae75c793f67a35089c9d99245e1c58470b',
        'Handler.withdraw(1018107047375819024971860639293) sender=0x0000000000000000000000000000000000001651 target=0x2e234dae75c793f67a35089c9d99245e1c58470b',
      ],
    });
  });

  it('compile error: stdout is not JSON, every expected invariant becomes an error with the compiler output', async () => {
    const out = await fx('compile-error.stdout.txt');
    const results = parseForgeJson(out, ['INV-1', 'INV-2']);
    expect(results.map((r) => [r.invariantId, r.status])).toEqual([
      ['INV-1', 'error'],
      ['INV-2', 'error'],
    ]);
    expect(results[0]!.error).toContain('Error (6933): Expected primary expression.');
    expect(() => parseForgeJson(out)).toThrow(ForgeOutputError);
  });

  it('setUp failure: every expected invariant is an error carrying the setUp reason', async () => {
    expect(parseForgeJson(await fx('setup.json'), ['INV-1', 'INV-2'])).toEqual([
      { invariantId: 'INV-1', status: 'error', error: 'setUp failed: boom' },
      { invariantId: 'INV-2', status: 'error', error: 'setUp failed: boom' },
    ]);
  });

  it('orders by expected ids, marks missing tests as errors and keeps unexpected ones last', async () => {
    const results = parseForgeJson(await fx('pass.json'), ['INV-3', 'INV-1']);
    expect(results).toEqual([
      { invariantId: 'INV-3', status: 'error', error: 'no invariant_INV_3 test in forge output' },
      { invariantId: 'INV-1', status: 'pass' },
      { invariantId: 'INV-2', status: 'pass' },
    ]);
  });
});

describe('parseForgeJson shapes', () => {
  const doc = (ce: unknown, status = 'Failure', reason: string | null = 'bad') =>
    JSON.stringify({ 'a.t.sol:S': { test_results: { 'invariant_INV_1()': { status, reason, counterexample: ce } } } });
  const call = { sender: '0x1', addr: '0x2', contract_name: 'x.sol:H', func_name: 'f', raw_args: '1', args: '1' };

  it('accepts a flat Sequence and Single', () => {
    expect(parseForgeJson(doc({ Sequence: [call] }))[0]!.counterexample!.callSequence).toHaveLength(1);
    expect(parseForgeJson(doc({ Single: call }))[0]!.counterexample!.callSequence).toEqual(['H.f(1) sender=0x1 target=0x2']);
  });

  it('a failure without calls is still a fail with an empty sequence', () => {
    expect(parseForgeJson(doc(null))[0]).toMatchObject({ status: 'fail', counterexample: { callSequence: [], reason: 'bad' } });
  });

  it("forge's own set-up message is an error, not a counterexample", () => {
    expect(parseForgeJson(doc(null, 'Failure', 'failed to set up invariant testing environment: No contracts to fuzz.'))[0]!.status).toBe('error');
  });

  it('takes the last JSON line when warnings precede it', () => {
    expect(parseForgeJson(`Warning: something\n${doc(null, 'Success', null)}`)).toEqual([{ invariantId: 'INV-1', status: 'pass' }]);
  });

  it('formats unnamed calls with calldata', () => {
    expect(formatForgeCall({ sender: '0x1', addr: '0x2', calldata: '0xabcd' })).toBe('0x2.calldata 0xabcd sender=0x1 target=0x2');
  });
});

describe('ForgeBackend', () => {
  let dir: string;
  let spec: Spec;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-forgebin-'));
    spec = await loadSpec();
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  /** Fake forge: records argv and env, prints a fixture, exits like forge. */
  async function fakeForge(stdoutFile: string, exitCode: number, stderr = ''): Promise<string> {
    const bin = path.join(dir, 'forge');
    await writeFile(
      bin,
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" > "${dir}/argv"`,
        `env | grep -E '^FOUNDRY_' | sort > "${dir}/env"`,
        `pwd > "${dir}/cwd"`,
        `cat "${path.join(here, 'fixtures/forge', stdoutFile)}"`,
        stderr ? `printf '%s\\n' '${stderr}' >&2` : '',
        `exit ${exitCode}`,
      ].join('\n'),
    );
    await chmod(bin, 0o755);
    return bin;
  }

  it('runs the locked suite in the worktree with parameters injected through FOUNDRY_ env', async () => {
    const bin = await fakeForge('fail.json', 1);
    const artifactDir = path.join(dir, 'artifacts');
    const backend = new ForgeBackend({ forgeBin: bin, artifactDir });
    const res = await backend.run({ worktree: dir, spec, params: { runs: 64, depth: 32, timeoutSec: 30, seed: '0x2a' } });

    expect((await readFile(path.join(dir, 'argv'), 'utf8')).trim()).toBe('test --match-path test/specfirst/Invariants.t.sol --json');
    const env = await readFile(path.join(dir, 'env'), 'utf8');
    expect(env).toContain('FOUNDRY_INVARIANT_RUNS=64');
    expect(env).toContain('FOUNDRY_INVARIANT_DEPTH=32');
    expect(env).toContain('FOUNDRY_FUZZ_SEED=0x2a');
    expect(env).toContain(`FOUNDRY_OUT=${artifactDir}/out`);
    expect(env).toContain(`FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR=${artifactDir}/invariant-failures`);
    expect(realpathSync((await readFile(path.join(dir, 'cwd'), 'utf8')).trim())).toBe(realpathSync(dir));

    expect(res.backend).toBe('forge');
    expect(res.executions).toBe(200);
    expect(res.results.map((r) => [r.invariantId, r.status])).toEqual([
      ['INV-1', 'fail'],
      ['INV-2', 'pass'],
      ['INV-3', 'error'],
      ['INV-4', 'error'],
      ['INV-5', 'error'],
      ['INV-6', 'error'],
      ['INV-7', 'error'],
    ]);
    expect(res.results[0]!.counterexample!.seed).toBe('0x2a');
    expect(await readFile(res.rawArtifactPath, 'utf8')).toBe(await fx('fail.json'));
  });

  it('turns a compile failure into errors with the compiler output', async () => {
    const bin = await fakeForge('compile-error.stdout.txt', 1, 'Error: Compilation failed');
    const res = await new ForgeBackend({ forgeBin: bin, artifactDir: path.join(dir, 'a') }).run({
      worktree: dir,
      spec,
      params: { runs: 1, depth: 1, timeoutSec: 30 },
    });
    expect(res.results.every((r) => r.status === 'error')).toBe(true);
    expect(res.results[0]!.error).toContain('Expected primary expression');
    expect(res.results[0]!.error).toContain('Error: Compilation failed');
    expect(await readFile(path.join(dir, 'env'), 'utf8')).not.toContain('FOUNDRY_FUZZ_SEED');
  });

  it('turns a timeout into errors', async () => {
    const bin = path.join(dir, 'forge');
    await writeFile(bin, '#!/bin/sh\nexec sleep 5\n');
    await chmod(bin, 0o755);
    const res = await new ForgeBackend({ forgeBin: bin, artifactDir: path.join(dir, 'a') }).run({
      worktree: dir,
      spec,
      params: { runs: 1, depth: 1, timeoutSec: 0.2 },
    });
    expect(res.results[0]).toEqual({ invariantId: 'INV-1', status: 'error', error: 'forge timed out after 0.2s' });
  });

  it('is a judge', () => {
    const b = new ForgeBackend();
    expect([b.name, b.role]).toEqual(['forge', 'judge']);
  });
});
