import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerLockCommand } from '../src/commands/lock.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';
import { sampleRepo } from './helpers/sampleRepo.js';

/**
 * Mutant check with real forge on the staking-vault sample (plan 3.1, 10/2 exit criterion): all seven
 * sample mutants must break their invariant against fixed/StakingVault.sol. Needs forge on PATH.
 * Set SPECFIRST_SKIP_FORGE=1 to skip.
 */
const SPEC = 'spec/staking-vault.spec.yaml';
const ARGS = ['lock', SPEC, '--baseline', 'fixed/StakingVault.sol', '--seed', '1'];

describe.skipIf(process.env.SPECFIRST_SKIP_FORGE === '1')('specfirst lock mutant check with forge', { timeout: 300_000 }, () => {
  let dir: string;
  const lock = () => capture(() => buildProgram(registerLockCommand).parseAsync(['node', 'specfirst', '--project', dir, ...ARGS]));

  beforeAll(async () => {
    dir = await sampleRepo();
  });

  afterAll(async () => {
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it('all 7 sample mutants break their invariant, and the lock is written', async () => {
    process.exitCode = undefined;
    const { out } = await lock();
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain('7/7 mutants broke their invariant');

    const report = JSON.parse(await readFile(path.join(dir, '.specfirst/mutants.json'), 'utf8'));
    expect(report.ok).toBe(true);
    expect(report.baseline.failures).toEqual([]);
    expect(report.results.map((r: { invariantId: string; status: string }) => `${r.invariantId}:${r.status}`)).toEqual(
      ['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7'].map((id) => `${id}:broke`),
    );
    expect(JSON.parse(await readFile(path.join(dir, '.specfirst/lock.json'), 'utf8')).mutantsSkipped).toBe(false);
  });

  it('a mutant that only touches a comment survives and the lock is refused with exit 3', async () => {
    process.exitCode = undefined;
    await rm(path.join(dir, '.specfirst/lock.json'), { force: true });
    const patch = path.join(dir, 'test/specfirst/mutants/INV-5.patch');
    const original = await readFile(patch, 'utf8');
    await writeFile(
      patch,
      [
        'diff --git a/src/StakingVault.sol b/src/StakingVault.sol',
        '--- a/src/StakingVault.sol',
        '+++ b/src/StakingVault.sol',
        '@@ -50,3 +50,3 @@ contract StakingVault {',
        '     function setRewardRate(uint256 rate) external onlyOwner {',
        '-        rewardRate = rate;',
        '+        rewardRate = rate; // harmless',
        '         emit RewardRateChanged(rate);',
        '',
      ].join('\n'),
    );
    try {
      const { out } = await lock();
      expect(process.exitCode).toBe(3);
      expect(out).toContainEqual(expect.stringMatching(/✗ INV-5 {2}survived/));
      expect(out).toContain('mutant check failed (6/7 broke)');
    } finally {
      await writeFile(patch, original);
    }
  });
});
