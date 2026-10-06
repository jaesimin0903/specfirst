import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { REJECT_REASONS, workerStatusSchema, workerTotalsOf, type WorkerStatus } from './index.js';

/** Where the worker keeps its cursor (state.json) and the per-request progress the web reads (status.json). */
export const WORKER_DIR = '.specfirst/worker';
export const WORKER_STATE_JSON = 'state.json';
export const WORKER_STATUS_JSON = 'status.json';
/** Holds the pid of the running worker, so two workers never serve one project directory at once. */
export const WORKER_LOCK = 'worker.lock';

export class WorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerError';
  }
}

const decimal = z.string().regex(/^(0|[1-9]\d*)$/);

const iso = z.string().datetime();

/**
 * What the worker must remember about a request it has started but not closed, so a restart resumes at the
 * failed step instead of paying for the check again: the saved report (block, reportPath, reportURI), the
 * attest transaction once sent (attestTx: hash and nonce, written before its receipt is awaited), the
 * attestation id once attested, or the reject decision. failures counts passes in a row whose transaction
 * step failed; gaveUp stops the worker from touching the request (the requester can still refundExpired).
 * retryAt holds a request back after a subject RPC failure (deferrals in a row set the wait) or between
 * reruns; checkRuns counts checks that ran but could not be attested (fork RPC errors, a newer attestation).
 */
export const workerStateEntrySchema = z
  .object({
    failures: z.number().int().nonnegative(),
    block: decimal.optional(),
    reportPath: z.string().min(1).optional(),
    reportURI: z.string().min(1).optional(),
    attestTx: z.object({ hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), nonce: z.number().int().nonnegative() }).strict().optional(),
    attestationId: decimal.optional(),
    reject: z.enum(REJECT_REASONS).optional(),
    detail: z.string().optional(),
    gaveUp: z.boolean().optional(),
    retryAt: iso.optional(),
    deferrals: z.number().int().nonnegative().optional(),
    checkRuns: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkerStateEntry = z.infer<typeof workerStateEntrySchema>;

/**
 * state.json. cursor: every request id below it is closed onchain or given up, so a pass reads
 * requestOf(cursor .. requestCount - 1) only. desk and chainId bind the file to one desk. timedOut: subjects
 * (lowercase) whose check ran out of its time budget, with when and at which block; their requests are
 * rejected without a check until the cool-off has passed.
 */
export const workerStateSchema = z
  .object({
    version: z.literal(1),
    desk: z.string().regex(/^0x[0-9a-f]{40}$/),
    chainId: z.number().int().positive(),
    cursor: decimal,
    requests: z.record(decimal, workerStateEntrySchema),
    timedOut: z.record(z.string().regex(/^0x[0-9a-f]{40}$/), z.object({ at: iso, block: decimal }).strict()).optional(),
  })
  .strict();
export type WorkerState = z.infer<typeof workerStateSchema>;

export function emptyWorkerStatus(): WorkerStatus {
  return { totals: { gasCostWei: '0', fulfilled: 0, rejected: 0 } };
}

/** Writes through a temp file in the same directory and a rename, so readers never see half a file. */
export async function writeAtomic(file: string, content: string): Promise<void> {
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes `file` (created exclusively, holding the pid) for one process. A lock whose pid is still alive
 * refuses the start with `error`; a lock left by a process that is gone is taken over. `holder` names the
 * kind of process in the message ("worker", "watcher"). Returns the release function.
 */
export async function acquirePidLock(
  file: string,
  opts: { holder: string; error: (message: string) => Error; pid?: number; isAlive?: (pid: number) => boolean },
): Promise<() => Promise<void>> {
  const pid = opts.pid ?? process.pid;
  const isAlive = opts.isAlive ?? pidAlive;
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, `${pid}\n`, { flag: 'wx' });
      return async () => {
        const holder = await readFile(file, 'utf8').catch(() => '');
        if (holder.trim() === String(pid)) await rm(file, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const other = Number((await readFile(file, 'utf8').catch(() => '')).trim());
      if (Number.isSafeInteger(other) && other > 0 && other !== pid && isAlive(other)) {
        throw opts.error(`another ${opts.holder} (pid ${other}) is running on ${path.dirname(file)}; stop it first, or remove ${file} if that pid is not a ${opts.holder}`);
      }
      await rm(file, { force: true });
    }
  }
  throw opts.error(`could not take ${file}`);
}

/**
 * Takes `<projectDir>/.specfirst/worker/worker.lock` (created exclusively, holding the pid). A lock whose
 * pid is still alive refuses the start: two workers on one state directory would attest twice and race on
 * nonces. A lock left by a process that is gone is taken over. Returns the release function.
 */
export function acquireWorkerLock(
  projectDir: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<() => Promise<void>> {
  return acquirePidLock(path.join(projectDir, WORKER_DIR, WORKER_LOCK), { ...opts, holder: 'worker', error: (m) => new WorkerError(m) });
}
