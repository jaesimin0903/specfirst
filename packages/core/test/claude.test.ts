import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_ALLOWED_TOOLS,
  ClaudeAgentError,
  ClaudeCodeAgent,
  buildFixPrompt,
  parseClaudeEnvelope,
  parseClaudeVersion,
  type ClaudeExec,
  type Counterexample,
  type IterationRecord,
  type Spec,
} from '../src/index.js';
import { initRepo, loadSpec, vaultWith } from './helpers/repo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFile(path.join(here, 'fixtures/claude', name), 'utf8');

describe('parseClaudeEnvelope', () => {
  it('reads cost, model, session and turns from the single result object', async () => {
    const env = parseClaudeEnvelope(await fx('result-success.json'));
    expect(env).toMatchObject({
      isError: false,
      subtype: 'success',
      costUsd: 0.4172,
      model: 'claude-sonnet-5',
      sessionId: '0b6c1f5e-6f4e-4b8e-9a53-1d2f3c4b5a60',
      numTurns: 7,
      permissionDenials: [],
    });
    expect(env!.result).toMatch(/^Root cause/);
  });

  it('picks the costliest modelUsage entry, not the helper model', async () => {
    expect(parseClaudeEnvelope(await fx('result-success.json'))!.model).toBe('claude-sonnet-5');
  });

  it('accepts the --verbose message array and takes the model from system/init', async () => {
    const env = parseClaudeEnvelope(await fx('result-verbose.json'));
    expect(env).toMatchObject({ costUsd: 1.25, model: 'claude-opus-5-5', numTurns: 4 });
    expect(env!.permissionDenials).toHaveLength(1);
  });

  it('keeps the cost of an error envelope so the budget still counts it', async () => {
    expect(parseClaudeEnvelope(await fx('result-error-max-turns.json'))).toMatchObject({
      isError: true,
      subtype: 'error_max_turns',
      costUsd: 2.5,
      result: '',
    });
  });

  it('finds the envelope after log lines', async () => {
    const text = `warning: something\n${(await fx('result-success.json')).trim()}\n`;
    expect(parseClaudeEnvelope(text)!.costUsd).toBe(0.4172);
  });

  it('returns null without a result envelope', () => {
    expect(parseClaudeEnvelope('')).toBeNull();
    expect(parseClaudeEnvelope('Error: not logged in')).toBeNull();
    expect(parseClaudeEnvelope('{"type":"assistant"}')).toBeNull();
  });

  it('treats a missing or negative cost as 0', () => {
    expect(parseClaudeEnvelope('{"type":"result","subtype":"success"}')!.costUsd).toBe(0);
    expect(parseClaudeEnvelope('{"type":"result","total_cost_usd":-1}')!.costUsd).toBe(0);
  });
});

describe('parseClaudeVersion', () => {
  it('extracts the semver from `claude --version`', () => {
    expect(parseClaudeVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseClaudeVersion('')).toBe('unknown');
  });
});

const CE: Counterexample[] = [
  {
    invariantId: 'INV-1',
    reason: 'INV-1: totalStaked != sum(balances)',
    callSequence: ['Handler.deposit(0, 5) sender=0x1 target=0x2', 'Handler.withdraw(4, 3) sender=0x1 target=0x2'],
    seed: '1',
    source: 'forge',
  },
  { invariantId: 'INV-5', reason: 'error: setUp failed', callSequence: [], source: 'forge' },
];

describe('buildFixPrompt', () => {
  let spec: Spec;
  beforeEach(async () => {
    spec = await loadSpec();
  });

  it('carries every invariant, the counterexamples, the history and the rules', () => {
    const history: IterationRecord[] = [
      {
        iteration: 1,
        phase: 'fix',
        counterexamples: CE,
        diff: '',
        changedPaths: ['test/specfirst/Invariants.t.sol'],
        fuzz: null,
        costUsd: 0.3,
        agent: { diff: '', changedPaths: [], costUsd: 0.3, model: 'm', cliVersion: 'v', transcriptPath: '' },
        rejected: 'locked files touched: test/specfirst/Invariants.t.sol',
      },
    ];
    const p = buildFixPrompt(spec, CE, history);
    for (const inv of spec.invariants) expect(p).toContain(`${inv.id} [${inv.kind}] ${inv.text}`);
    expect(p).toContain('INV-1: INV-1: totalStaked != sum(balances) (seed 1)');
    expect(p).toContain('  1. Handler.deposit(0, 5) sender=0x1 target=0x2');
    expect(p).toContain('  2. Handler.withdraw(4, 3) sender=0x1 target=0x2');
    expect(p).toContain('(no call sequence)');
    expect(p).toContain('DISCARDED: locked files touched: test/specfirst/Invariants.t.sol');
    expect(p).toContain(`Modify only files inside contract.editable (${spec.contract.editable.join(', ')})`);
    expect(p).toContain('Never touch test/, foundry.toml, remappings.txt or lib/');
    expect(p).toContain('Do not edit, weaken or delete the invariant tests');
    expect(p).toContain('Keep the diff minimal');
  });

  it('says so when there is no history', () => {
    expect(buildFixPrompt(spec, CE, [])).toContain('Previous iterations: none');
  });
});

describe('ClaudeCodeAgent', () => {
  let repo: string;
  let spec: Spec;
  let transcriptDir: string;
  const calls: Array<{ args: string[]; cwd?: string; signal?: AbortSignal }> = [];

  beforeEach(async () => {
    repo = await initRepo();
    spec = await loadSpec();
    transcriptDir = path.join(repo, '.specfirst/runs/r1');
    calls.length = 0;
  });
  afterEach(() => rm(repo, { recursive: true, force: true }));

  /** Fake CLI: answers --version, otherwise edits the vault in cwd and prints the given envelope. */
  const fakeExec =
    (envelope: string, edit = true): ClaudeExec =>
    async (_bin, args, opts) => {
      calls.push({ args, cwd: opts.cwd, signal: opts.signal });
      if (args[0] === '--version') return { stdout: '2.1.283 (Claude Code)\n', stderr: '', exitCode: 0 };
      if (edit) await writeFile(path.join(opts.cwd!, 'src/StakingVault.sol'), vaultWith('fixed'));
      return { stdout: envelope, stderr: '', exitCode: 0 };
    };

  it('runs claude -p in the worktree and fills AgentResult from the envelope', async () => {
    const agent = new ClaudeCodeAgent({ exec: fakeExec(await fx('result-success.json')), transcriptDir, maxBudgetUsd: 5 });
    const res = await agent.fix({ spec, worktree: repo, counterexamples: CE, history: [] });

    expect(res).toMatchObject({
      costUsd: 0.4172,
      model: 'claude-sonnet-5',
      cliVersion: '2.1.283',
      changedPaths: ['src/StakingVault.sol'],
    });
    expect(res.diff).toContain('+    // fixed');
    const run = calls.find((c) => c.args[0] === '-p')!;
    expect(run.cwd).toBe(repo);
    expect(run.signal).toBeInstanceOf(AbortSignal);
    expect(run.args[1]).toContain('INV-1');
    expect(run.args.slice(2)).toEqual([
      '--output-format',
      'json',
      '--model',
      'claude-sonnet-5',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      CLAUDE_ALLOWED_TOOLS,
      '--max-budget-usd',
      '5',
    ]);
    expect(res.transcriptPath).toBe(path.join(transcriptDir, path.basename(repo), 'claude.json'));
    const transcript = JSON.parse(await readFile(res.transcriptPath, 'utf8'));
    expect(transcript).toMatchObject({ model: 'claude-sonnet-5', cliVersion: '2.1.283', exitCode: 0 });
  });

  it('asks for the CLI version once per agent', async () => {
    const agent = new ClaudeCodeAgent({ exec: fakeExec(await fx('result-success.json'), false), transcriptDir });
    await agent.fix({ spec, worktree: repo, counterexamples: CE, history: [] });
    await agent.fix({ spec, worktree: repo, counterexamples: CE, history: [] });
    expect(calls.filter((c) => c.args[0] === '--version')).toHaveLength(1);
  });

  it('escalates the model from the third fix iteration', async () => {
    const agent = new ClaudeCodeAgent({ exec: fakeExec(await fx('result-success.json'), false), transcriptDir });
    const rec = (iteration: number): IterationRecord => ({
      iteration,
      phase: 'fix',
      counterexamples: CE,
      diff: '',
      changedPaths: [],
      fuzz: null,
      costUsd: 0,
    });
    await agent.fix({ spec, worktree: repo, counterexamples: CE, history: [rec(1)] });
    await agent.fix({ spec, worktree: repo, counterexamples: CE, history: [rec(1), rec(2)] });
    const models = calls.filter((c) => c.args[0] === '-p').map((c) => c.args[c.args.indexOf('--model') + 1]);
    expect(models).toEqual(['claude-sonnet-5', 'claude-opus-5-5']);
  });

  it('throws ClaudeAgentError when the CLI prints no envelope, and keeps the transcript', async () => {
    const exec: ClaudeExec = async (_b, args) =>
      args[0] === '--version'
        ? { stdout: '2.1.283\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: 'Invalid API key', exitCode: 1 };
    const agent = new ClaudeCodeAgent({ exec, transcriptDir });
    await expect(agent.fix({ spec, worktree: repo, counterexamples: CE, history: [] })).rejects.toBeInstanceOf(ClaudeAgentError);
    expect(existsSync(path.join(transcriptDir, path.basename(repo), 'claude.json'))).toBe(true);
  });

  it('aborts the call through the signal after timeoutMs', async () => {
    let seen: AbortSignal | undefined;
    const exec: ClaudeExec = async (_b, args, opts) => {
      if (args[0] === '--version') return { stdout: '2.1.283\n', stderr: '', exitCode: 0 };
      seen = opts.signal;
      await new Promise<void>((resolve) => opts.signal!.addEventListener('abort', () => resolve()));
      throw new ClaudeAgentError('claude call was aborted', '');
    };
    const agent = new ClaudeCodeAgent({ exec, transcriptDir, timeoutMs: 50 });
    await expect(agent.fix({ spec, worktree: repo, counterexamples: CE, history: [] })).rejects.toThrow('aborted');
    expect(seen!.aborted).toBe(true);
  });

  it('forwards the caller signal', async () => {
    const ctrl = new AbortController();
    let seen: AbortSignal | undefined;
    const exec: ClaudeExec = async (_b, args, opts) => {
      if (args[0] === '--version') return { stdout: '2.1.283\n', stderr: '', exitCode: 0 };
      seen = opts.signal;
      ctrl.abort();
      return { stdout: await fx('result-success.json'), stderr: '', exitCode: 0 };
    };
    const agent = new ClaudeCodeAgent({ exec, transcriptDir });
    await agent.fix({ spec, worktree: repo, counterexamples: CE, history: [], signal: ctrl.signal });
    expect(seen!.aborted).toBe(true);
  });
});
