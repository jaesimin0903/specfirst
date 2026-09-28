import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** CLI exit code when a run or the total spend passes its cap. */
export const BUDGET_EXCEEDED_EXIT_CODE = 15;
export const DEFAULT_RUN_CAP_USD = 5;
export const DEFAULT_TOTAL_CAP_USD = 60;
export const BUDGET_FILE = '.specfirst/budget.json';

export interface BudgetFile {
  version: 1;
  totalUsd: number;
  runs: Record<string, number>;
}

export interface BudgetOptions {
  /** Absolute path, usually <projectDir>/.specfirst/budget.json. */
  file: string;
  runId: string;
  runCapUsd?: number;
  totalCapUsd?: number;
}

export type BudgetExceeded = 'run' | 'total' | null;

/** Accumulates agent spend per run and across runs, persisted so the total cap survives restarts. */
export class BudgetTracker {
  readonly runCapUsd: number;
  readonly totalCapUsd: number;

  private constructor(
    private readonly opts: BudgetOptions,
    private state: BudgetFile,
  ) {
    this.runCapUsd = opts.runCapUsd ?? DEFAULT_RUN_CAP_USD;
    this.totalCapUsd = opts.totalCapUsd ?? DEFAULT_TOTAL_CAP_USD;
  }

  static async open(opts: BudgetOptions): Promise<BudgetTracker> {
    let state: BudgetFile = { version: 1, totalUsd: 0, runs: {} };
    try {
      const parsed = JSON.parse(await readFile(opts.file, 'utf8')) as BudgetFile;
      if (parsed.version === 1 && typeof parsed.totalUsd === 'number' && parsed.runs) state = parsed;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return new BudgetTracker(opts, state);
  }

  get runUsd(): number {
    return this.state.runs[this.opts.runId] ?? 0;
  }

  get totalUsd(): number {
    return this.state.totalUsd;
  }

  async add(costUsd: number): Promise<void> {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error(`invalid cost ${costUsd}`);
    this.state.totalUsd += costUsd;
    this.state.runs[this.opts.runId] = this.runUsd + costUsd;
    await mkdir(path.dirname(this.opts.file), { recursive: true });
    const tmp = `${this.opts.file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`);
    await rename(tmp, this.opts.file);
  }

  /** 'run' or 'total' once spend is strictly above that cap, else null. The run cap is reported first. */
  exceeded(): BudgetExceeded {
    if (this.runUsd > this.runCapUsd) return 'run';
    if (this.totalUsd > this.totalCapUsd) return 'total';
    return null;
  }
}
