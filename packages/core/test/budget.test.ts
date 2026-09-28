import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BUDGET_EXCEEDED_EXIT_CODE, BudgetTracker } from '../src/index.js';

let dir: string;
let file: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'specfirst-budget-'));
  file = path.join(dir, '.specfirst/budget.json');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('BudgetTracker', () => {
  it('defaults to 5 USD per run and 60 USD total, exit code 15', async () => {
    const b = await BudgetTracker.open({ file, runId: 'r1' });
    expect([b.runCapUsd, b.totalCapUsd, BUDGET_EXCEEDED_EXIT_CODE]).toEqual([5, 60, 15]);
  });

  it('reports run once spend is strictly above the run cap', async () => {
    const b = await BudgetTracker.open({ file, runId: 'r1' });
    await b.add(5);
    expect(b.exceeded()).toBeNull();
    await b.add(0.01);
    expect(b.exceeded()).toBe('run');
  });

  it('persists across instances and reports total across runs', async () => {
    const a = await BudgetTracker.open({ file, runId: 'r1', totalCapUsd: 6 });
    await a.add(4);
    const b = await BudgetTracker.open({ file, runId: 'r2', totalCapUsd: 6 });
    expect(b.runUsd).toBe(0);
    expect(b.totalUsd).toBe(4);
    await b.add(3);
    expect(b.exceeded()).toBe('total');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, totalUsd: 7, runs: { r1: 4, r2: 3 } });
  });

  it('rejects negative or non-finite costs', async () => {
    const b = await BudgetTracker.open({ file, runId: 'r1' });
    await expect(b.add(-1)).rejects.toThrow();
    await expect(b.add(Number.NaN)).rejects.toThrow();
  });

  it('starts fresh from an unrecognised file', async () => {
    await writeFile(path.join(dir, 'b.json'), '{"version":9}');
    const b = await BudgetTracker.open({ file: path.join(dir, 'b.json'), runId: 'r' });
    expect(b.totalUsd).toBe(0);
  });
});
