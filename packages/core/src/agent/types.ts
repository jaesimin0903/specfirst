import type { Counterexample, FuzzResult } from '../fuzz/types.js';
import type { Spec } from '../spec/schema.js';

export interface AgentResult {
  /** The agent's own view of its change. The loop trusts collectChanges, not this field. */
  diff: string;
  changedPaths: string[];
  costUsd: number;
  model: string;
  cliVersion: string;
  transcriptPath: string;
}

export interface IterationRecord {
  /** 0 is the implement step (only when the contract did not exist yet); fix iterations start at 1. */
  iteration: number;
  phase: 'implement' | 'fix';
  counterexamples: Counterexample[];
  /** Diff collected from the worktree after the agent ran, empty when the agent was not called. */
  diff: string;
  changedPaths: string[];
  /** Judge result that opened this iteration; null for the implement step. */
  fuzz: FuzzResult | null;
  /** True when the previous iteration was rejected, so the unchanged code was not fuzzed again. */
  fuzzReused?: boolean;
  costUsd: number;
  agent?: AgentResult;
  /** Set when the change was discarded, with the reason. */
  rejected?: string;
}

export interface ImplementInput {
  spec: Spec;
  worktree: string;
  signal?: AbortSignal;
}

export interface FixInput {
  spec: Spec;
  worktree: string;
  counterexamples: Counterexample[];
  history: IterationRecord[];
  signal?: AbortSignal;
}

export interface ImplAgent {
  implement(i: ImplementInput): Promise<AgentResult>;
  fix(i: FixInput): Promise<AgentResult>;
}
