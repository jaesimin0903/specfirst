import type { AgentResult, FixInput, ImplAgent } from './types.js';

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet`);
    this.name = 'NotImplementedError';
  }
}

export interface ClaudeCodeAgentOptions {
  /** Default claude-sonnet-5; from the third fix iteration the plan switches to claude-opus-5-5. */
  model?: string;
  escalateModel?: string;
  escalateFromIteration?: number;
  claudeBin?: string;
}

/**
 * Stub for plan decision B2 (headless Claude Code CLI). Planned behaviour, not wired yet:
 *
 * - Run `claude -p --output-format json` with cwd set to the iteration worktree the loop created
 *   (src/loop/worktree.ts), never the user's checkout.
 * - Restrict tools with `--allowedTools`: Read, Edit, Write limited to `contract.editable`, and
 *   Bash limited to `forge build` and `forge test`. No network, no git, no package installs.
 * - The prompt carries the spec, the counterexamples (call sequence and reason) and the previous
 *   IterationRecords, including any rejected reason, so the agent does not repeat a discarded change.
 * - Parse `total_cost_usd`, the model and the CLI version (`claude --version`) from the JSON result,
 *   keep the transcript under `.specfirst/runs/<runId>/iter-N/`, and return AgentResult.
 * - Honour the AbortSignal: the loop aborts after 10 minutes per call.
 * - The loop still collects and guards every change itself (plan 3.3), whatever the agent claims.
 */
export class ClaudeCodeAgent implements ImplAgent {
  constructor(readonly opts: ClaudeCodeAgentOptions = {}) {}

  async implement(): Promise<AgentResult> {
    throw new NotImplementedError('ClaudeCodeAgent.implement');
  }

  async fix(_i?: FixInput): Promise<AgentResult> {
    throw new NotImplementedError('ClaudeCodeAgent.fix');
  }
}
