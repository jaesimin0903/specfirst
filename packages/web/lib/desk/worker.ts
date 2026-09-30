import { readFile } from 'node:fs/promises';
import { workerRequestStatusSchema, workerTotalsSchema, type WorkerRequestStatus } from './contract';
import { workerStatusPath } from './paths';

/*
 * The worker's status.json. It is written by another process while we read it, so a torn or invalid file is
 * "not available" rather than an error, and one bad entry does not hide the others.
 */

export interface WorkerTotals {
  gasCostWei: bigint;
  fulfilled: number;
  rejected: number;
}

export interface WorkerSnapshot {
  available: boolean;
  /** Why it is not available: "missing", "unreadable", "invalid JSON". */
  problem: string | null;
  requests: Map<string, WorkerRequestStatus>;
  totals: WorkerTotals | null;
  /** Entries that did not match the schema, by id. */
  invalid: string[];
}

export function parseWorkerStatus(raw: unknown): WorkerSnapshot {
  const out: WorkerSnapshot = { available: true, problem: null, requests: new Map(), totals: null, invalid: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...out, available: false, problem: 'not an object' };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === 'totals') {
      const t = workerTotalsSchema.safeParse(value);
      if (t.success) out.totals = { gasCostWei: BigInt(t.data.gasCostWei), fulfilled: t.data.fulfilled, rejected: t.data.rejected };
      else out.invalid.push('totals');
      continue;
    }
    if (!/^\d+$/.test(key)) continue;
    const e = workerRequestStatusSchema.safeParse(value);
    if (e.success) out.requests.set(String(BigInt(key)), e.data);
    else out.invalid.push(key);
  }
  return out;
}

export async function readWorkerStatus(file: string = workerStatusPath()): Promise<WorkerSnapshot> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    return { available: false, problem: missing ? 'missing' : 'unreadable', requests: new Map(), totals: null, invalid: [] };
  }
  try {
    return parseWorkerStatus(JSON.parse(text));
  } catch {
    return { available: false, problem: 'invalid JSON', requests: new Map(), totals: null, invalid: [] };
  }
}
