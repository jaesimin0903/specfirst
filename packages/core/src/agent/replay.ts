import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { collectChanges } from '../loop/worktree.js';
import type { AgentResult, FixInput, ImplAgent, ImplementInput } from './types.js';

export interface ReplayAgentOptions {
  /** Cost reported per call: one number for every call, or a list indexed by call (missing entries are 0). */
  costUsd?: number | number[];
  model?: string;
}

/**
 * Deterministic agent for tests and demos: every implement or fix call applies the next patch
 * with `git apply` inside the worktree. Once the patches run out it changes nothing.
 */
export class ReplayAgent implements ImplAgent {
  private next = 0;
  readonly calls: Array<{ kind: 'implement' | 'fix'; input: ImplementInput | FixInput }> = [];

  constructor(
    private readonly patches: string[],
    private readonly opts: ReplayAgentOptions = {},
  ) {}

  implement(i: ImplementInput): Promise<AgentResult> {
    this.calls.push({ kind: 'implement', input: i });
    return this.applyNext(i.worktree);
  }

  fix(i: FixInput): Promise<AgentResult> {
    this.calls.push({ kind: 'fix', input: i });
    return this.applyNext(i.worktree);
  }

  private cost(call: number): number {
    const c = this.opts.costUsd ?? 0;
    return typeof c === 'number' ? c : (c[call] ?? 0);
  }

  private async applyNext(worktree: string): Promise<AgentResult> {
    const call = this.calls.length - 1;
    const patch = this.patches[this.next];
    if (patch !== undefined) {
      this.next += 1;
      const dir = await mkdtemp(path.join(tmpdir(), 'specfirst-replay-'));
      try {
        const file = path.join(dir, 'change.patch');
        await writeFile(file, patch.endsWith('\n') ? patch : `${patch}\n`);
        await execa('git', ['apply', '--whitespace=nowarn', file], { cwd: worktree });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    const { diff, changedPaths } = await collectChanges(worktree);
    return {
      diff,
      changedPaths,
      costUsd: this.cost(call),
      model: this.opts.model ?? 'replay',
      cliVersion: 'replay',
      transcriptPath: '',
    };
  }
}
