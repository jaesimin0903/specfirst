import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REJECT_REASONS, workerStatusSchema, workerTotalsOf, type WorkerStatus } from './index.js';

/** Where the worker keeps its cursor (state.json) and the per-request progress the web reads (status.json). */
export const WORKER_DIR = '.specfirst/worker';
export const WORKER_STATE_JSON = 'state.json';
export const WORKER_STATUS_JSON = 'status.json';

export class WorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerError';
  }
}

const decimal = z.string().regex(/^(0|[1-9]\d*)$/);

/**
 * What the worker must remember about a request it has started but not closed, so a restart resumes at the
 * failed step instead of paying for the check again: the saved report (block, reportPath, reportURI), the
 * attestation id once attested, or the reject decision. failures counts passes in a row whose transaction
 * step failed; gaveUp stops the worker from touching the request (the requester can still refundExpired).
 */
export const workerStateEntrySchema = z
  .object({
    failures: z.number().int().nonnegative(),
    block: decimal.optional(),
    reportPath: z.string().min(1).optional(),
    reportURI: z.string().min(1).optional(),
    attestationId: decimal.optional(),
    reject: z.enum(REJECT_REASONS).optional(),
    detail: z.string().optional(),
    gaveUp: z.boolean().optional(),
  })
  .strict();
export type WorkerStateEntry = z.infer<typeof workerStateEntrySchema>;

/**
 * state.json. cursor: every request id below it is closed onchain or given up, so a pass reads
 * requestOf(cursor .. requestCount - 1) only. desk and chainId bind the file to one desk.
 */
export const workerStateSchema = z
  .object({
    version: z.literal(1),
    desk: z.string().regex(/^0x[0-9a-f]{40}$/),
    chainId: z.number().int().positive(),
    cursor: decimal,
    requests: z.record(decimal, workerStateEntrySchema),
  })
  .strict();
export type WorkerState = z.infer<typeof workerStateSchema>;

export function emptyWorkerStatus(): WorkerStatus {
  return { totals: { gasCostWei: '0', fulfilled: 0, rejected: 0 } };
}

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, content);
  await rename(tmp, file);
}

async function readJsonFile(file: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new WorkerError(`${what} ${file} is not readable JSON: ${(err as Error).message}`);
  }
}

/** state.json and status.json of one desk, loaded and validated; save() rewrites both atomically. */
export class WorkerStore {
  constructor(
    readonly dir: string,
    public state: WorkerState,
    public status: WorkerStatus,
  ) {}

  get statePath(): string {
    return path.join(this.dir, WORKER_STATE_JSON);
  }

  get statusPath(): string {
    return path.join(this.dir, WORKER_STATUS_JSON);
  }

  /** Writes status.json (totals recomputed from the entries) and state.json, each through a temp file and rename. */
  async save(): Promise<void> {
    this.status.totals = workerTotalsOf(this.status);
    const status = workerStatusSchema.parse(this.status);
    await writeAtomic(this.statusPath, `${JSON.stringify(status, null, 2)}\n`);
    await writeAtomic(this.statePath, `${JSON.stringify(workerStateSchema.parse(this.state), null, 2)}\n`);
  }

  /**
   * Loads `<projectDir>/.specfirst/worker`. A missing state.json starts a fresh store (cursor 0, empty
   * status.json, whatever status.json was there is replaced on the first save). A state.json of another desk
   * or chain is refused: its cursor and entries mean nothing for this one.
   */
  static async load(projectDir: string, desk: { address: string; chainId: number }): Promise<WorkerStore> {
    const dir = path.join(projectDir, WORKER_DIR);
    const statePath = path.join(dir, WORKER_STATE_JSON);
    const deskLower = desk.address.toLowerCase();
    if (!existsSync(statePath)) {
      return new WorkerStore(dir, { version: 1, desk: deskLower, chainId: desk.chainId, cursor: '0', requests: {} }, emptyWorkerStatus());
    }
    const parsed = workerStateSchema.safeParse(await readJsonFile(statePath, 'worker state'));
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
      throw new WorkerError(`worker state ${statePath} is invalid: ${issues.join('; ')}`);
    }
    const state = parsed.data;
    if (state.desk !== deskLower || state.chainId !== desk.chainId) {
      throw new WorkerError(
        `${statePath} belongs to desk ${state.desk} on chain ${state.chainId}, not ${deskLower} on chain ${desk.chainId}; move ${WORKER_DIR} away to start a worker for this desk`,
      );
    }
    const statusPath = path.join(dir, WORKER_STATUS_JSON);
    let status = emptyWorkerStatus();
    if (existsSync(statusPath)) {
      const s = workerStatusSchema.safeParse(await readJsonFile(statusPath, 'worker status'));
      if (!s.success) {
        const issues = s.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
        throw new WorkerError(`worker status ${statusPath} is invalid: ${issues.join('; ')}`);
      }
      status = s.data;
    }
    return new WorkerStore(dir, state, status);
  }
}
