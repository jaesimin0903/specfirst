import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerLockCommand } from '../src/commands/lock.js';
import { registerRunCommand } from '../src/commands/run.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';
import { git, sampleRepo } from './helpers/sampleRepo.js';

/**
 * Local end-to-end run against real forge (plan 4, 10/3): the planted reentrancy sample, the replay
 * agent applying the known fix, and a judge-only pass. Needs forge on PATH. Set SPECFIRST_SKIP_FORGE=1 to skip.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const SPEC = 'spec/staking-vault.spec.yaml';
const FIXED_ARGS = ['--no-deploy', '--runs', '64', '--seed', '1'];

/** Stage labels and per-invariant marks, without run ids, hashes, timings or call arguments. */
function skeleton(lines: string[]): string[] {
  return lines
    .map((l) => {
      const inv = /^ {2}([✗✓!]) (INV-\d+)/.exec(l);
      if (inv) return `${inv[1]} ${inv[2]}`;
      const st = /^(spec|lock|run|impl|fuzz #\d+|fix #\d+|done)\b/.exec(l);
      return st ? st[1]! : null;
    })
    .filter((x): x is string => x !== null);
}

describe.skipIf(process.env.SPECFIRST_SKIP_FORGE === '1')('specfirst run with forge (staking-vault sample)', { timeout: 300_000 }, () => {
  let dir: string;

  const cli = (...args: string[]) =>
    capture(() => buildProgram(registerRunCommand).parseAsync(['node', 'specfirst', '--project', dir, ...args]));

  beforeAll(async () => {
    dir = await sampleRepo();
    await capture(() => buildProgram(registerLockCommand).parseAsync(['node', 'specfirst', '--project', dir, 'lock', SPEC]));
    expect(process.exitCode ?? 0).toBe(0);
  }, 60_000);

  afterAll(async () => {
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('replay agent: INV-1..4 fail, the fix is applied, 7/7 pass, exit 0 in 2 iterations', async () => {
    process.exitCode = undefined;
    const { out } = await cli('run', SPEC, ...FIXED_ARGS, '--agent', 'replay:fixtures/fix-reentrancy.patch');
    expect(process.exitCode).toBe(0);

    const text = out.join('\n');
    const sk = skeleton(out);
    expect(sk).toEqual([
      'spec', 'lock', 'run', 'impl',
      'fuzz #1', '✗ INV-1', '✗ INV-2', '✗ INV-3', '✗ INV-4', '✓ INV-5', '✓ INV-6', '✓ INV-7',
      'fix #1',
      'fuzz #2', '✓ INV-1', '✓ INV-2', '✓ INV-3', '✓ INV-4', '✓ INV-5', '✓ INV-6', '✓ INV-7',
      'done',
    ]);
    expect(text).toContain('4 fail, 3 pass');
    expect(text).toContain('changed src/StakingVault.sol');
    expect(text).toContain('7/7 pass');
    expect(text).toContain('passed in 2 iterations  exit 0');

    // The saved terminal transcript has the same shape as a live run.
    const fixture = (await readFile(path.join(here, 'fixtures/run-replay.txt'), 'utf8')).split('\n');
    expect(skeleton(fixture)).toEqual(sk);

    const runs = await readdir(path.join(dir, '.specfirst/runs'));
    expect(runs).toHaveLength(1);
    const summary = JSON.parse(await readFile(path.join(dir, '.specfirst/runs', runs[0]!, 'run.json'), 'utf8'));
    expect(summary).toMatchObject({
      status: 'passed',
      exitCode: 0,
      stopReason: 'all-pass',
      iterations: 2,
      result: { pass: 7, fail: 0, error: 0, failing: [] },
      params: { runs: 64, depth: 64, timeoutSec: 300, seed: '1' },
      agent: { kind: 'replay', calls: 1 },
      deploy: 'skipped',
    });
    expect(summary.history[0]).toMatchObject({ failing: ['INV-1', 'INV-2', 'INV-3', 'INV-4'], changedPaths: ['src/StakingVault.sol'] });

    // The fix lives on the run ref; the user's checkout is untouched.
    const onRef = await git(dir, 'show', `${summary.runRef}:src/StakingVault.sol`);
    const onHead = await git(dir, 'show', 'HEAD:src/StakingVault.sol');
    expect(onRef).not.toBe(onHead);
    expect((await git(dir, 'status', '--porcelain')).trim()).toBe('');
  });

  it('--agent none: judges once, exit 10 with counterexamples and no fix', async () => {
    process.exitCode = undefined;
    const { out } = await cli('run', SPEC, ...FIXED_ARGS, '--agent', 'none');
    expect(process.exitCode).toBe(10);
    const sk = skeleton(out);
    expect(sk).not.toContain('fix #1');
    expect(sk).not.toContain('fuzz #2');
    expect(sk.filter((s) => s.startsWith('✗'))).toEqual(['✗ INV-1', '✗ INV-2', '✗ INV-3', '✗ INV-4']);
    expect(out.join('\n')).toContain('judge only, no fix attempted  exit 10');
  });

  it('--json: loop events as NDJSON, ending with run-summary', async () => {
    process.exitCode = undefined;
    const { stdout, out } = await capture(() =>
      buildProgram(registerRunCommand).parseAsync([
        'node', 'specfirst', '--json', '--project', dir,
        'run', SPEC, ...FIXED_ARGS, '--agent', 'replay:fixtures/fix-reentrancy.patch',
      ]),
    );
    expect(process.exitCode).toBe(0);
    expect(out).toEqual([]);
    const events = stdout.trim().split('\n').map((l) => JSON.parse(l) as { type: string; [k: string]: unknown });
    expect(events.map((e) => e.type)).toEqual([
      'loop-start',
      'iteration-start', 'fuzz-result', 'agent-start', 'agent-result', 'accepted',
      'iteration-start', 'fuzz-result',
      'loop-end',
      'run-summary',
    ]);
    expect(events[2]).toMatchObject({ iteration: 1, pass: 3, fail: 4, error: 0 });
    expect(events[7]).toMatchObject({ iteration: 2, pass: 7, fail: 0 });
    expect(events.at(-1)).toMatchObject({ status: 'passed', exitCode: 0, iterations: 2 });
  });
});
