import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Counterexample } from '../fuzz/types.js';
import { collectChanges } from '../loop/worktree.js';
import type { Spec } from '../spec/schema.js';
import type { AgentResult, FixInput, ImplAgent, ImplementInput, IterationRecord } from './types.js';

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

/** The claude CLI failed before producing a JSON result envelope. */
export class ClaudeAgentError extends Error {
  constructor(
    message: string,
    readonly output: string,
  ) {
    super(message);
    this.name = 'ClaudeAgentError';
  }
}

export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-5';
export const DEFAULT_CLAUDE_ESCALATE_MODEL = 'claude-opus-5-5';
export const DEFAULT_CLAUDE_ESCALATE_FROM = 3;
/** Per call, matching the loop's own limit (plan 3.3). */
export const DEFAULT_CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Tools the headless agent may use without asking. Everything else is denied (`--permission-mode dontAsk`).
 * Read, Glob and Grep are read-only; Edit and Write are confined afterwards by the loop's own guards.
 */
export const CLAUDE_ALLOWED_TOOLS = 'Read,Glob,Grep,Edit,Write,Bash(forge build*)';

export interface ClaudeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

export type ClaudeExec = (
  bin: string,
  args: string[],
  opts: { cwd?: string; signal?: AbortSignal },
) => Promise<ClaudeExecResult>;

export interface ClaudeCodeAgentOptions {
  /** Default claude-sonnet-5; from the third fix iteration the plan switches to claude-opus-5-5. */
  model?: string;
  escalateModel?: string;
  /** 1-based fix iteration from which escalateModel is used. */
  escalateFromIteration?: number;
  claudeBin?: string;
  /** Hard limit per call, enforced with an AbortSignal on top of the caller's own. */
  timeoutMs?: number;
  /** Passed as --max-budget-usd so one call cannot overspend the run cap on its own. */
  maxBudgetUsd?: number;
  /**
   * Directory for transcripts, usually .specfirst/runs/<runId>. Each call writes
   * `<dir>/<worktree basename>/claude.json`, next to the loop's own iter-N records.
   * Must be outside the worktree, or the loop would see it as a change.
   */
  transcriptDir?: string;
  /** Process runner, replaceable in tests. Defaults to execa. */
  exec?: ClaudeExec;
}

/** Fields read from the `--output-format json` result envelope. */
export interface ClaudeEnvelope {
  isError: boolean;
  subtype: string;
  result: string;
  costUsd: number;
  /** Model that carried the call: the init message's model, else the costliest modelUsage entry. */
  model: string | null;
  sessionId: string | null;
  numTurns: number | null;
  permissionDenials: unknown[];
}

function lastJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split('\n').reverse()) {
      const l = line.trim();
      if (!l.startsWith('{') && !l.startsWith('[')) continue;
      try {
        return JSON.parse(l);
      } catch {
        /* keep looking */
      }
    }
    return undefined;
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

function modelFromUsage(usage: unknown): string | null {
  if (!isObj(usage)) return null;
  let best: string | null = null;
  let bestCost = -1;
  for (const [name, u] of Object.entries(usage)) {
    const cost = isObj(u) && typeof u.costUSD === 'number' ? u.costUSD : 0;
    if (cost > bestCost) {
      best = name;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Parses the stdout of `claude -p --output-format json`. Accepts the single result object and the
 * message array printed with --verbose (the result is its `type: "result"` element, the model comes
 * from the `system/init` element). Returns null when no result envelope is present.
 */
export function parseClaudeEnvelope(stdout: string): ClaudeEnvelope | null {
  const doc = lastJsonDocument(stdout);
  let result: Json | undefined;
  let initModel: string | null = null;
  if (Array.isArray(doc)) {
    for (const m of doc) {
      if (!isObj(m)) continue;
      if (m.type === 'result') result = m;
      if (m.type === 'system' && m.subtype === 'init' && typeof m.model === 'string') initModel = m.model;
    }
  } else if (isObj(doc) && doc.type === 'result') {
    result = doc;
  }
  if (!result) return null;
  const cost = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : 0;
  return {
    isError: result.is_error === true,
    subtype: typeof result.subtype === 'string' ? result.subtype : 'unknown',
    result: typeof result.result === 'string' ? result.result : '',
    costUsd: Number.isFinite(cost) && cost >= 0 ? cost : 0,
    model: initModel ?? (typeof result.model === 'string' ? result.model : null) ?? modelFromUsage(result.modelUsage),
    sessionId: typeof result.session_id === 'string' ? result.session_id : null,
    numTurns: typeof result.num_turns === 'number' ? result.num_turns : null,
    permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials : [],
  };
}

/** First version-looking token of `claude --version`: "2.1.283 (Claude Code)" becomes "2.1.283". */
export function parseClaudeVersion(stdout: string): string {
  const line = stdout.trim().split('\n')[0] ?? '';
  const m = /\d+\.\d+\.\d+\S*/.exec(line);
  return m ? m[0] : line || 'unknown';
}

const MAX_CALLS_PER_COUNTEREXAMPLE = 40;

function specSection(spec: Spec): string {
  const lines = [
    `Contract: ${spec.contract.name}${spec.contract.path ? ` at ${spec.contract.path}` : ''}`,
    `Editable paths (contract.editable): ${spec.contract.editable.join(', ')}`,
    `Solidity: ${spec.solc}`,
    '',
    'Invariants (all of them must hold):',
    ...spec.invariants.map((i) => `- ${i.id} [${i.kind}] ${i.text}`),
  ];
  if (spec.unverified.length > 0) {
    lines.push('', 'Explicitly out of scope (do not try to address):', ...spec.unverified.map((u) => `- ${u}`));
  }
  return lines.join('\n');
}

function rulesSection(spec: Spec): string {
  return [
    'Rules:',
    `- Modify only files inside contract.editable (${spec.contract.editable.join(', ')}). Any change elsewhere discards the iteration.`,
    '- Never touch test/, foundry.toml, remappings.txt or lib/. Those are locked; touching them ends the run.',
    '- Do not edit, weaken or delete the invariant tests. Fix the contract so the properties hold.',
    '- Keep the diff minimal: change only what the counterexamples require and keep the public interface.',
    '- Do not branch on block.chainid, block.number, block.timestamp, tx.origin, extcodesize or address(this).code to pass the tests.',
    '- You may run `forge build` to check that the code compiles. Do not run git.',
  ].join('\n');
}

function counterexampleSection(cs: readonly Counterexample[]): string {
  if (cs.length === 0) return 'Failing invariants: none reported.';
  const out = ['Failing invariants and counterexamples from the forge invariant campaign:'];
  for (const c of cs) {
    out.push('', `${c.invariantId}: ${c.reason}${c.seed ? ` (seed ${c.seed})` : ''}`);
    if (c.callSequence.length === 0) {
      out.push('  (no call sequence)');
      continue;
    }
    const shown = c.callSequence.slice(0, MAX_CALLS_PER_COUNTEREXAMPLE);
    shown.forEach((call, i) => out.push(`  ${i + 1}. ${call}`));
    if (c.callSequence.length > shown.length) out.push(`  ... ${c.callSequence.length - shown.length} more calls`);
  }
  return out.join('\n');
}

function historySection(history: readonly IterationRecord[]): string {
  if (history.length === 0) return 'Previous iterations: none, this is the first attempt.';
  const out = ['Previous iterations of this run:'];
  for (const r of history) {
    const failing = [...new Set(r.counterexamples.map((c) => c.invariantId))];
    const parts = [`- iteration ${r.iteration} (${r.phase})`];
    if (r.phase === 'fix') parts.push(failing.length > 0 ? `failing: ${failing.join(', ')}` : 'all invariants passed');
    if (r.changedPaths.length > 0) parts.push(`changed: ${r.changedPaths.join(', ')}`);
    else if (r.agent) parts.push('no change');
    parts.push(r.rejected ? `DISCARDED: ${r.rejected}` : r.agent ? 'change kept' : 'agent not called');
    out.push(parts.join('; '));
  }
  out.push('Do not repeat a discarded change. The code you see already contains every kept change.');
  return out.join('\n');
}

/** Prompt for the implement step (the contract file does not exist yet). */
export function buildImplementPrompt(spec: Spec): string {
  return [
    `You are implementing the Solidity contract ${spec.contract.name} in this Foundry project so that it satisfies its spec.`,
    '',
    specSection(spec),
    '',
    'The invariant suite lives in test/specfirst/. Read it first to learn the interface the contract must expose.',
    '',
    rulesSection(spec),
    '',
    'When done, reply with one short paragraph describing the implementation.',
  ].join('\n');
}

/** Prompt for a fix iteration: the full spec, the counterexamples, the run history and the rules. */
export function buildFixPrompt(
  spec: Spec,
  counterexamples: readonly Counterexample[],
  history: readonly IterationRecord[],
): string {
  return [
    `You are fixing the Solidity contract ${spec.contract.name} in this Foundry project. A locked invariant suite found violations of its spec.`,
    '',
    specSection(spec),
    '',
    counterexampleSection(counterexamples),
    '',
    historySection(history),
    '',
    rulesSection(spec),
    '',
    'When done, reply with one short paragraph naming the root cause and the change.',
  ].join('\n');
}

const defaultExec: ClaudeExec = async (bin, args, opts) => {
  const r = await execa(bin, args, {
    cwd: opts.cwd,
    cancelSignal: opts.signal,
    forceKillAfterDelay: 5000,
    reject: false,
    stdin: 'ignore',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.isCanceled) throw new ClaudeAgentError('claude call was aborted', String(r.stderr ?? ''));
  return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), exitCode: r.exitCode };
};

/**
 * Headless Claude Code agent (plan decision B2). Each call runs
 * `claude -p <prompt> --output-format json --model M --permission-mode dontAsk --allowedTools ...`
 * with cwd set to the iteration worktree the loop created, never the user's checkout.
 * The claude CLI has no --cwd flag; the process cwd is what scopes it.
 * The loop still collects and guards every change itself (plan 3.3), whatever the agent claims.
 */
export class ClaudeCodeAgent implements ImplAgent {
  private versionPromise: Promise<string> | null = null;
  private readonly exec: ClaudeExec;
  private readonly bin: string;

  constructor(readonly opts: ClaudeCodeAgentOptions = {}) {
    this.exec = opts.exec ?? defaultExec;
    this.bin = opts.claudeBin ?? 'claude';
  }

  /** Model for a fix iteration (1-based). The implement step always uses the base model. */
  modelFor(fixIteration: number): string {
    const base = this.opts.model ?? DEFAULT_CLAUDE_MODEL;
    const from = this.opts.escalateFromIteration ?? DEFAULT_CLAUDE_ESCALATE_FROM;
    return fixIteration >= from ? (this.opts.escalateModel ?? DEFAULT_CLAUDE_ESCALATE_MODEL) : base;
  }

  /** argv after the binary. The prompt sits right after -p so the variadic --allowedTools cannot swallow it. */
  argsFor(prompt: string, model: string): string[] {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      model,
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      CLAUDE_ALLOWED_TOOLS,
    ];
    if (this.opts.maxBudgetUsd !== undefined) args.push('--max-budget-usd', String(this.opts.maxBudgetUsd));
    return args;
  }

  cliVersion(): Promise<string> {
    this.versionPromise ??= this.exec(this.bin, ['--version'], {}).then(
      (r) => parseClaudeVersion(r.stdout),
      () => 'unknown',
    );
    return this.versionPromise;
  }

  implement(i: ImplementInput): Promise<AgentResult> {
    return this.call(i.worktree, buildImplementPrompt(i.spec), this.opts.model ?? DEFAULT_CLAUDE_MODEL, i.signal);
  }

  fix(i: FixInput): Promise<AgentResult> {
    const fixIteration = i.history.filter((r) => r.phase === 'fix').length + 1;
    return this.call(
      i.worktree,
      buildFixPrompt(i.spec, i.counterexamples, i.history),
      this.modelFor(fixIteration),
      i.signal,
    );
  }

  private async call(worktree: string, prompt: string, model: string, outer?: AbortSignal): Promise<AgentResult> {
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? DEFAULT_CLAUDE_TIMEOUT_MS);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    const cliVersion = await this.cliVersion();
    const proc = await this.exec(this.bin, this.argsFor(prompt, model), { cwd: worktree, signal });

    const dir = path.join(this.opts.transcriptDir ?? path.join(tmpdir(), 'specfirst-claude'), path.basename(worktree));
    await mkdir(dir, { recursive: true });
    const transcriptPath = path.join(dir, 'claude.json');
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ model, cliVersion, exitCode: proc.exitCode ?? null, prompt, stdout: proc.stdout, stderr: proc.stderr }, null, 2)}\n`,
    );

    const env = parseClaudeEnvelope(proc.stdout);
    if (!env) {
      const output = [proc.stdout.trim(), proc.stderr.trim()].filter(Boolean).join('\n');
      throw new ClaudeAgentError(
        `claude exited ${proc.exitCode ?? '?'} without a JSON result (transcript: ${transcriptPath})`,
        output,
      );
    }
    const { diff, changedPaths } = await collectChanges(worktree);
    return { diff, changedPaths, costUsd: env.costUsd, model: env.model ?? model, cliVersion, transcriptPath };
  }
}
