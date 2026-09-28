import { existsSync } from 'node:fs';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BudgetTracker,
  MockBackend,
  ReplayAgent,
  counterexampleSignature,
  runFixLoop,
  type AgentResult,
  type FixLoopInput,
  type ImplAgent,
  type LoopEvent,
  type MockScenario,
  type Spec,
} from '../src/index.js';
import { buildPatches, git, initRepo, INVARIANTS, loadSpec, VAULT, vaultWith } from './helpers/repo.js';

const LOCKS = ['test/specfirst/', 'foundry.toml', 'remappings.txt', 'spec/vault.spec.yaml', '.specfirst/'];
const PARAMS = { runs: 8, depth: 8, timeoutSec: 60, seed: '1' };

const pass: MockScenario = [
  { invariantId: 'INV-1', status: 'pass' },
  { invariantId: 'INV-2', status: 'pass' },
];
const fail = (seq: string): MockScenario => [
  {
    invariantId: 'INV-1',
    status: 'fail',
    counterexample: { invariantId: 'INV-1', callSequence: [`Handler.withdraw(${seq})`], reason: 'INV-1 broken', source: 'forge' },
  },
  { invariantId: 'INV-2', status: 'pass' },
];

let repo: string;
let spec: Spec;
let head: string;
let events: LoopEvent[];

beforeEach(async () => {
  repo = await initRepo();
  spec = await loadSpec();
  head = (await git(repo, 'rev-parse', 'HEAD')).trim();
  events = [];
});
afterEach(() => rm(repo, { recursive: true, force: true }));

async function run(over: Partial<FixLoopInput> & Pick<FixLoopInput, 'agent' | 'backend'>, budgetOpts: { runCapUsd?: number; totalCapUsd?: number } = {}) {
  const budget = await BudgetTracker.open({ file: path.join(repo, '.specfirst/budget.json'), runId: 'r1', ...budgetOpts });
  return runFixLoop({
    spec,
    projectDir: repo,
    runId: 'r1',
    params: PARAMS,
    budget,
    lockFiles: LOCKS,
    onEvent: (e) => events.push(e),
    ...over,
  });
}

const iterDir = (n: number) => path.join(repo, '.specfirst/runs/r1', `iter-${n}`);

describe('runFixLoop', () => {
  it('one counterexample, one fix, then pass: 2 iterations, exit 0', async () => {
    const patches = await buildPatches(repo, [{ files: { 'src/StakingVault.sol': vaultWith('fixed') } }]);
    const agent = new ReplayAgent(patches, { costUsd: 0.4 });
    const backend = new MockBackend([fail('7'), pass]);
    const res = await run({ agent, backend });

    expect(res.status).toBe('passed');
    expect(res.exitCode).toBe(0);
    expect(res.stopReason).toBe('all-pass');
    expect(res.iterations).toHaveLength(2);
    expect(res.iterations[0]!.counterexamples[0]!.invariantId).toBe('INV-1');
    expect(res.iterations[0]!.changedPaths).toEqual(['src/StakingVault.sol']);
    expect(res.iterations[0]!.costUsd).toBe(0.4);
    expect(res.iterations[1]!.counterexamples).toEqual([]);
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.kind).toBe('fix');

    // Accepted work lives on the run ref, the user's checkout is unchanged.
    expect(await git(repo, 'show', `${res.finalCommit}:src/StakingVault.sol`)).toContain('// fixed');
    expect((await git(repo, 'rev-parse', 'refs/specfirst/runs/r1')).trim()).toBe(res.finalCommit);
    expect(await readFile(path.join(repo, 'src/StakingVault.sol'), 'utf8')).toBe(VAULT);

    // The second judge ran on a fresh worktree that already had the fix.
    expect(backend.inputs[0]!.worktree).not.toBe(backend.inputs[1]!.worktree);

    for (const f of ['counterexamples.json', 'diff.patch', 'fuzz.json', 'agent.json']) {
      expect(existsSync(path.join(iterDir(1), f))).toBe(true);
      expect(existsSync(path.join(iterDir(2), f))).toBe(true);
    }
    expect(await readFile(path.join(iterDir(1), 'diff.patch'), 'utf8')).toContain('+    // fixed');
    expect(JSON.parse(await readFile(path.join(iterDir(1), 'counterexamples.json'), 'utf8'))[0].callSequence).toEqual(['Handler.withdraw(7)']);

    // Worktrees are cleaned up.
    expect(existsSync(path.join(repo, '.specfirst/worktrees/r1/iter-1'))).toBe(false);
    expect((await git(repo, 'worktree', 'list')).trim().split('\n')).toHaveLength(1);
  });

  it('stops after 5 iterations with exit 10 when every judge run fails', async () => {
    const patches = await buildPatches(repo, [1, 2, 3, 4, 5].map((n) => ({ files: { 'src/StakingVault.sol': vaultWith(`try ${n}`) } })));
    const agent = new ReplayAgent(patches);
    const backend = new MockBackend([fail('1'), fail('2'), fail('3'), fail('4'), fail('5'), pass]);
    const res = await run({ agent, backend });

    expect(res.status).toBe('exhausted');
    expect(res.exitCode).toBe(10);
    expect(res.stopReason).toBe('max-iterations');
    expect(res.iterations.map((r) => r.iteration)).toEqual([1, 2, 3, 4, 5]);
    expect(backend.calls).toBe(5);
    expect(agent.calls).toHaveLength(4);
    expect(await git(repo, 'show', `${res.finalCommit}:src/StakingVault.sol`)).toContain('// try 4');
  });

  it('respects a lower maxIterations', async () => {
    const res = await run({ agent: new ReplayAgent([]), backend: new MockBackend([fail('1')]), maxIterations: 1 });
    expect([res.status, res.iterations.length]).toEqual(['exhausted', 1]);
  });

  it('stops early (stalled) when the same invariant fails with the same counterexample twice in a row', async () => {
    const patches = await buildPatches(repo, [
      { files: { 'src/StakingVault.sol': vaultWith('a') } },
      { files: { 'src/StakingVault.sol': vaultWith('b') } },
    ]);
    const agent = new ReplayAgent(patches);
    const res = await run({ agent, backend: new MockBackend([fail('9'), fail('9'), pass]) });

    expect(res.status).toBe('stalled');
    expect(res.exitCode).toBe(10);
    expect(res.stopReason).toBe('same-counterexample');
    expect(res.iterations).toHaveLength(2);
    expect(agent.calls).toHaveLength(1);
    expect(counterexampleSignature(res.iterations[0]!.counterexamples[0]!)).toBe(
      counterexampleSignature(res.iterations[1]!.counterexamples[0]!),
    );
  });

  it('rejects the run with exit 11 when the agent edits a locked file, and keeps nothing', async () => {
    const patches = await buildPatches(repo, [
      {
        files: {
          'src/StakingVault.sol': vaultWith('fix'),
          'test/specfirst/Invariants.t.sol': INVARIANTS.replace('view {}', 'view { return; }'),
        },
      },
    ]);
    const res = await run({ agent: new ReplayAgent(patches), backend: new MockBackend([fail('1'), pass]) });

    expect(res.status).toBe('rejected');
    expect(res.exitCode).toBe(11);
    expect(res.stopReason).toBe('locked-file-touched');
    expect(res.iterations).toHaveLength(1);
    expect(res.iterations[0]!.rejected).toBe('locked files touched: test/specfirst/Invariants.t.sol');
    expect(res.finalCommit).toBe(head);
    const agentJson = JSON.parse(await readFile(path.join(iterDir(1), 'agent.json'), 'utf8'));
    expect(agentJson.rejected).toContain('test/specfirst/Invariants.t.sol');
    expect(events.some((e) => e.type === 'rejected')).toBe(true);
  });

  it('discards an iteration that creates an untracked file outside contract.editable, and counts it', async () => {
    const patches = await buildPatches(repo, [
      { files: { 'src/StakingVault.sol': vaultWith('half'), 'script/Hack.s.sol': 'contract Hack {}\n' }, accept: false },
      { files: { 'src/StakingVault.sol': vaultWith('fixed') } },
    ]);
    const agent = new ReplayAgent(patches);
    const backend = new MockBackend([fail('1'), pass]);
    const res = await run({ agent, backend });

    expect(res.status).toBe('passed');
    expect(res.iterations).toHaveLength(3);
    const [rejected, retried, final] = res.iterations;
    expect(rejected!.rejected).toBe('outside contract.editable: script/Hack.s.sol');
    expect(rejected!.changedPaths).toEqual(['script/Hack.s.sol', 'src/StakingVault.sol']);
    // Code did not change, so the judge is not run again; the retry works from the same counterexamples.
    expect(retried!.fuzzReused).toBe(true);
    expect(retried!.counterexamples).toEqual(rejected!.counterexamples);
    expect(retried!.rejected).toBeUndefined();
    expect(final!.fuzzReused).toBeUndefined();
    expect(backend.calls).toBe(2);
    // The agent saw the rejected attempt in its history.
    const second = agent.calls[1]!.input as { history: Array<{ rejected?: string }> };
    expect(second.history[0]!.rejected).toContain('script/Hack.s.sol');
    // Nothing from the rejected attempt reached the accepted commit.
    const tree = await git(repo, 'ls-tree', '-r', '--name-only', res.finalCommit);
    expect(tree).not.toContain('script/Hack.s.sol');
    expect(await git(repo, 'show', `${res.finalCommit}:src/StakingVault.sol`)).toContain('// fixed');
  });

  it('a rejected iteration still counts toward the iteration cap', async () => {
    const patches = await buildPatches(repo, [1, 2, 3, 4].map((n) => ({ files: { [`docs/n${n}.md`]: 'x\n' }, accept: false })));
    const res = await run({ agent: new ReplayAgent(patches), backend: new MockBackend([fail('1')]) });
    expect(res.status).toBe('exhausted');
    expect(res.iterations.map((r) => Boolean(r.rejected))).toEqual([true, true, true, true, false]);
  });

  it('records environment branch warnings from accepted diffs and emits them', async () => {
    const patched = VAULT.replace(
      '        uint256 bal = balances[msg.sender];\n',
      '        require(tx.origin == msg.sender);\n        if (block.timestamp > 1700000000) revert();\n        uint256 bal = balances[msg.sender];\n',
    );
    const patches = await buildPatches(repo, [{ files: { 'src/StakingVault.sol': patched } }]);
    const res = await run({ agent: new ReplayAgent(patches), backend: new MockBackend([fail('1'), pass]) });

    expect(res.status).toBe('passed');
    expect(res.envWarnings.map((w) => [w.kind, w.file, w.iteration])).toEqual([
      ['tx.origin', 'src/StakingVault.sol', 1],
      ['block.timestamp-compare', 'src/StakingVault.sol', 1],
    ]);
    expect(events.filter((e) => e.type === 'env-warning')).toHaveLength(2);
    const agentJson = JSON.parse(await readFile(path.join(iterDir(1), 'agent.json'), 'utf8'));
    expect(agentJson.envWarnings).toHaveLength(2);
  });

  it('stops with exit 15 once the run cost passes the cap', async () => {
    const patches = await buildPatches(repo, [1, 2, 3].map((n) => ({ files: { 'src/StakingVault.sol': vaultWith(`c${n}`) } })));
    const res = await run({ agent: new ReplayAgent(patches, { costUsd: 3 }), backend: new MockBackend([fail('1'), fail('2'), fail('3'), pass]) });

    expect(res.status).toBe('budget');
    expect(res.exitCode).toBe(15);
    expect(res.stopReason).toBe('budget-run');
    expect(res.iterations).toHaveLength(2);
    expect(res.iterations.map((r) => r.costUsd)).toEqual([3, 3]);
    const file = JSON.parse(await readFile(path.join(repo, '.specfirst/budget.json'), 'utf8'));
    expect(file).toEqual({ version: 1, totalUsd: 6, runs: { r1: 6 } });
  });

  it('refuses to call the agent when the total cap is already spent', async () => {
    await mkdir(path.join(repo, '.specfirst'), { recursive: true });
    await writeFile(path.join(repo, '.specfirst/budget.json'), JSON.stringify({ version: 1, totalUsd: 60.5, runs: { old: 60.5 } }));
    const agent = new ReplayAgent([]);
    const res = await run({ agent, backend: new MockBackend([fail('1')]) });
    expect([res.status, res.exitCode, res.stopReason]).toEqual(['budget', 15, 'budget-total']);
    expect(agent.calls).toHaveLength(0);
  });

  it('stops (stalled) when the agent returns an empty diff', async () => {
    const res = await run({ agent: new ReplayAgent([]), backend: new MockBackend([fail('1'), pass]) });
    expect([res.status, res.exitCode, res.stopReason]).toEqual(['stalled', 10, 'empty-diff']);
    expect(res.iterations[0]!.diff).toBe('');
  });

  it('aborts an agent call that exceeds the timeout', async () => {
    let aborted = false;
    const hanging: ImplAgent = {
      implement: () => new Promise<AgentResult>(() => {}),
      fix: ({ signal }) =>
        new Promise<AgentResult>(() => {
          signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    };
    const res = await run({ agent: hanging, backend: new MockBackend([fail('1')]), agentTimeoutMs: 50 });
    expect([res.status, res.exitCode, res.stopReason]).toEqual(['stalled', 10, 'agent-timeout']);
    expect(aborted).toBe(true);
    expect(res.iterations[0]!.rejected).toContain('exceeded 50ms');
  });

  it('runs implement first (iteration 0) when the contract file does not exist yet', async () => {
    await rm(path.join(repo, 'src/StakingVault.sol'));
    await git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-a', '-m', 'drop');
    const patches = await buildPatches(repo, [{ files: { 'src/StakingVault.sol': VAULT } }]);
    const agent = new ReplayAgent(patches, { costUsd: 1 });
    const res = await run({ agent, backend: new MockBackend([pass]) });

    expect(res.status).toBe('passed');
    expect(res.iterations.map((r) => [r.iteration, r.phase])).toEqual([
      [0, 'implement'],
      [1, 'fix'],
    ]);
    expect(res.iterations[0]!.fuzz).toBeNull();
    expect(res.iterations[0]!.changedPaths).toEqual(['src/StakingVault.sol']);
    expect(agent.calls.map((c) => c.kind)).toEqual(['implement']);
    expect(existsSync(path.join(iterDir(0), 'diff.patch'))).toBe(true);
    expect(await git(repo, 'show', `${res.finalCommit}:src/StakingVault.sol`)).toBe(VAULT.trimEnd());
  });

  it('feeds judge errors (for example a compile failure) back to the agent', async () => {
    const patches = await buildPatches(repo, [{ files: { 'src/StakingVault.sol': vaultWith('compiles') } }]);
    const agent = new ReplayAgent(patches);
    const res = await run({
      agent,
      backend: new MockBackend([[{ invariantId: 'INV-1', status: 'error', error: 'Compiler run failed' }], pass]),
    });
    expect(res.status).toBe('passed');
    const fix = agent.calls[0]!.input as { counterexamples: Array<{ reason: string; callSequence: string[] }> };
    expect(fix.counterexamples).toEqual([{ invariantId: 'INV-1', callSequence: [], reason: 'error: Compiler run failed', source: 'forge' }]);
  });

  it('emits NDJSON-ready events from loop-start to loop-end', async () => {
    const patches = await buildPatches(repo, [{ files: { 'src/StakingVault.sol': vaultWith('fixed') } }]);
    await run({ agent: new ReplayAgent(patches), backend: new MockBackend([fail('1'), pass]) });
    const lines = events.map((e) => JSON.stringify(e));
    expect(lines.every((l) => !l.includes('\n'))).toBe(true);
    expect(events.map((e) => e.type)).toEqual([
      'loop-start',
      'iteration-start',
      'fuzz-result',
      'agent-start',
      'agent-result',
      'accepted',
      'iteration-start',
      'fuzz-result',
      'loop-end',
    ]);
    expect(events.at(-1)).toMatchObject({ type: 'loop-end', status: 'passed', exitCode: 0 });
  });

  it('refuses an auxiliary backend as judge', async () => {
    const aux = { name: 'ultrafuzz' as const, role: 'auxiliary' as const, run: async () => { throw new Error('unused'); } };
    await expect(run({ agent: new ReplayAgent([]), backend: aux })).rejects.toThrow(/auxiliary/);
  });
});
