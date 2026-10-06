import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAddress } from 'viem';
import { z } from 'zod';
import { parseCheckReport } from '../attest/params.js';
import { acquirePidLock, writeAtomic } from '../desk/store.js';
import type { StandardCheckReport } from '../standards/report.js';
import { outcomeOfReport } from './decide.js';
import {
  FEED_KINDS,
  FEED_SOURCES,
  feedEventSchema,
  WATCH_DIR,
  WATCH_FEED_NDJSON,
  WATCH_STATUS_JSON,
  WATCH_VAULTS_JSON,
  watchStatusSchema,
  watchVaultsSchema,
  type FeedEvent,
  type FeedKind,
  type WatchLastCheck,
  type WatchStatus,
  type WatchVaults,
} from './schema.js';

/** The watcher's own state next to the files the web reads, and the lock that keeps one watcher per directory. */
export const WATCH_STATE_JSON = 'state.json';
export const WATCH_LOCK = 'watch.lock';

export class WatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchError';
  }
}

const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const iso = z.string().datetime();
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const lowerAddress = z.string().regex(/^0x[0-9a-f]{40}$/);
const checksummed = z.string().refine((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && getAddress(a) === a, 'a checksummed address');
const source = z.enum(FEED_SOURCES);
const count = z.number().int().nonnegative();

export const queueEntrySchema = z
  .object({
    subject: checksummed,
    source,
    priority: count,
    enqueuedAt: iso,
    block: decimal.optional(),
    txHash: hex32.optional(),
    attempts: count,
    notBefore: iso.optional(),
  })
  .strict();

/**
 * state.json: what the watcher needs to resume and nobody else reads. cursor: the first block whose logs
 * are not read (null until the first pass sets it). seq: the last feed seq written. rejected: addresses
 * whose probe said "not a vault". probing: candidates whose probe failed on an RPC error, retried each pass.
 * beacons: the beacon each known vault resolves its implementation through (from its latest report).
 * attempted: when a check of the vault last started. subscriptions: subscriptions whose first check was
 * delivered. sweeps: start times of sweep checks within the last hour. attestDay: attestations made on one
 * UTC day. recent: feed events of the last 24 hours the status counts. sourcesSeen: signals per source name.
 * deferred: checks whose attestation waits for the daily budget or a readable registry.
 */
export const watchStateSchema = z
  .object({
    v: z.literal(1),
    chainId: z.number().int().positive(),
    cursor: decimal.nullable(),
    seq: count,
    queue: z.array(queueEntrySchema),
    rejected: z.record(lowerAddress, z.object({ at: iso, block: decimal, reason: z.string() }).strict()),
    probing: z.record(
      lowerAddress,
      z
        .object({
          source,
          block: decimal,
          txHash: hex32.optional(),
          factory: z.object({ address: checksummed, name: z.string().min(1) }).strict().optional(),
          failures: count,
        })
        .strict(),
    ),
    beacons: z.record(lowerAddress, lowerAddress),
    attempted: z.record(lowerAddress, iso),
    subscriptions: z.record(decimal, z.object({ firstCheckAt: iso }).strict()),
    sweeps: z.array(iso),
    attestDay: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), used: count }).strict(),
    recent: z.array(z.object({ kind: z.enum(FEED_KINDS), at: iso }).strict()),
    sourcesSeen: z.record(z.string(), count),
    deferred: z.record(lowerAddress, z.object({ reportPath: z.string().min(1), reportURI: z.string().min(1), source, at: iso }).strict()),
  })
  .strict();
export type WatchState = z.infer<typeof watchStateSchema>;

/** A feed event before the store stamps it with v and seq. */
export type FeedEventInput = Omit<FeedEvent, 'v' | 'seq'>;

/** Feed kinds status.json counts over the last 24 hours. */
const COUNTED: ReadonlySet<FeedKind> = new Set(['detected', 'checked', 'attested', 'changed']);
const DAY_MS = 86_400_000;

export function emptyWatchState(chainId: number): WatchState {
  return {
    v: 1,
    chainId,
    cursor: null,
    seq: 0,
    queue: [],
    rejected: {},
    probing: {},
    beacons: {},
    attempted: {},
    subscriptions: {},
    sweeps: [],
    attestDay: { day: '1970-01-01', used: 0 },
    recent: [],
    sourcesSeen: {},
    deferred: {},
  };
}

async function readJson(file: string, what: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new WatchError(`${what} ${file} is not readable JSON: ${(err as Error).message}`);
  }
}

function invalid(what: string, file: string, error: z.ZodError): WatchError {
  const issues = error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return new WatchError(`${what} ${file} is invalid: ${issues.join('; ')}`);
}

/** The seq of the last complete line of feed.ndjson, or 0. Reads only the tail of the file. */
async function lastFeedSeq(file: string): Promise<number> {
  if (!existsSync(file)) return 0;
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, 65_536);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    lines.pop();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const seq = (JSON.parse(lines[i]!) as { seq?: unknown }).seq;
        if (typeof seq === 'number' && Number.isSafeInteger(seq)) return seq;
      } catch {
        /* a cut line at the start of the tail */
      }
    }
    return 0;
  } finally {
    await fh.close();
  }
}

/**
 * The watcher's files of one subject chain in `.specfirst/watch/<chainId>/`: state.json (its own),
 * vaults.json and status.json (rewritten atomically) and feed.ndjson (appended, one event per line).
 */
export class WatchStore {
  constructor(
    readonly dir: string,
    public state: WatchState,
    public vaults: WatchVaults,
  ) {}

  get statePath(): string {
    return path.join(this.dir, WATCH_STATE_JSON);
  }
  get statusPath(): string {
    return path.join(this.dir, WATCH_STATUS_JSON);
  }
  get vaultsPath(): string {
    return path.join(this.dir, WATCH_VAULTS_JSON);
  }
  get feedPath(): string {
    return path.join(this.dir, WATCH_FEED_NDJSON);
  }

  /** Writes vaults.json and state.json, then status.json when given, each through a temp file and a rename. */
  async save(status?: WatchStatus): Promise<void> {
    await writeAtomic(this.vaultsPath, `${JSON.stringify(watchVaultsSchema.parse(this.vaults), null, 2)}\n`);
    await writeAtomic(this.statePath, `${JSON.stringify(watchStateSchema.parse(this.state), null, 2)}\n`);
    if (status) await writeAtomic(this.statusPath, `${JSON.stringify(watchStatusSchema.parse(status), null, 2)}\n`);
  }

  /**
   * Stamps each event with v 1 and the next seq, validates it and appends all of them to feed.ndjson in one
   * write. Counted kinds are remembered for status.json's 24 hour counts. Returns the stamped events.
   */
  async append(events: readonly FeedEventInput[], now: Date): Promise<FeedEvent[]> {
    if (events.length === 0) return [];
    let seq = this.state.seq;
    const stamped = events.map((e) => feedEventSchema.parse({ v: 1, seq: ++seq, ...e }));
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.feedPath, stamped.map((e) => `${JSON.stringify(e)}\n`).join(''));
    this.state.seq = seq;
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    this.state.recent = this.state.recent.filter((r) => r.at >= since);
    for (const e of stamped) if (COUNTED.has(e.kind)) this.state.recent.push({ kind: e.kind, at: e.at });
    return stamped;
  }

  /**
   * Loads `<projectDir>/.specfirst/watch/<chainId>`. Missing files start empty. A state.json of another chain
   * is refused. seq continues after the last line of feed.ndjson when that is ahead of state.json (a crash
   * between the append and the save).
   */
  static async load(projectDir: string, chainId: number): Promise<WatchStore> {
    const dir = path.join(projectDir, WATCH_DIR, String(chainId));
    const statePath = path.join(dir, WATCH_STATE_JSON);
    let state = emptyWatchState(chainId);
    if (existsSync(statePath)) {
      const parsed = watchStateSchema.safeParse(await readJson(statePath, 'watch state'));
      if (!parsed.success) throw invalid('watch state', statePath, parsed.error);
      if (parsed.data.chainId !== chainId) throw new WatchError(`${statePath} is for chain ${parsed.data.chainId}, not ${chainId}`);
      state = parsed.data as WatchState;
    }
    const vaultsPath = path.join(dir, WATCH_VAULTS_JSON);
    let vaults: WatchVaults = { v: 1, vaults: {} };
    if (existsSync(vaultsPath)) {
      const parsed = watchVaultsSchema.safeParse(await readJson(vaultsPath, 'watch vaults'));
      if (!parsed.success) throw invalid('watch vaults', vaultsPath, parsed.error);
      vaults = parsed.data;
    }
    state.seq = Math.max(state.seq, await lastFeedSeq(path.join(dir, WATCH_FEED_NDJSON)));
    return new WatchStore(dir, state, vaults);
  }
}

/**
 * Takes `.specfirst/watch/<chainId>/watch.lock`: two watchers on one directory would check and attest the
 * same signals twice and interleave the feed.
 */
export function acquireWatchLock(projectDir: string, chainId: number, opts: { pid?: number; isAlive?: (pid: number) => boolean } = {}): Promise<() => Promise<void>> {
  return acquirePidLock(path.join(projectDir, WATCH_DIR, String(chainId), WATCH_LOCK), { ...opts, holder: 'watcher', error: (m) => new WatchError(m) });
}

/** vaults.json's lastCheck for a report kept at `reportPath`. */
export function lastCheckOf(report: StandardCheckReport, reportPath: string): WatchLastCheck {
  const o = outcomeOfReport(report);
  return { block: report.blockNumber, at: report.startedAt, reportPath, summary: o.summary, failed: o.failed, implementationKey: o.implementationKey };
}

/** The beacon a report says the subject resolves its implementation through (lowercase), or null. */
export function beaconOf(report: StandardCheckReport): string | null {
  const p = report.identity.proxy;
  return p && 'beacon' in p && p.beacon ? p.beacon.toLowerCase() : null;
}

const REPORT_FILE = /^(0|[1-9]\d*)-[0-9a-f]{16}\.json$/;

/**
 * Adds the vaults of `certs/checks/<chainId>/` (the known set before the watcher, docs/adr/0006) to
 * vaults.json: an address not known yet gets firstSeen backfill (block and startedAt of its oldest report)
 * and its latest report as lastCheck; a known one whose newest report is newer than its lastCheck (a desk
 * check, say) gets that report as lastCheck. The beacon map follows the report used. Unreadable reports are
 * skipped and listed.
 */
export async function seedKnownVaults(projectDir: string, store: WatchStore): Promise<{ added: number; updated: number; skipped: string[] }> {
  const chainId = store.state.chainId;
  const root = path.join(projectDir, 'certs', 'checks', String(chainId));
  const out = { added: 0, updated: 0, skipped: [] as string[] };
  if (!existsSync(root)) return out;
  for (const dirName of (await readdir(root)).sort()) {
    if (!/^0x[0-9a-f]{40}$/.test(dirName)) continue;
    const files = (await readdir(path.join(root, dirName))).filter((f) => REPORT_FILE.test(f));
    if (files.length === 0) continue;
    const byBlock = files.map((f) => ({ f, block: BigInt(f.split('-')[0]!) })).sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : a.f.localeCompare(b.f)));
    const read = async (f: string): Promise<{ report: StandardCheckReport; reportPath: string } | null> => {
      const reportPath = `certs/checks/${chainId}/${dirName}/${f}`;
      try {
        const report = parseCheckReport(await readFile(path.join(projectDir, reportPath), 'utf8'));
        if (report.chainId !== chainId || report.address.toLowerCase() !== dirName) throw new Error(`report is about ${report.chainId}:${report.address}`);
        return { report, reportPath };
      } catch (err) {
        out.skipped.push(`${reportPath}: ${(err as Error).message.split('\n')[0]}`);
        return null;
      }
    };
    const latest = await read(byBlock[byBlock.length - 1]!.f);
    if (!latest) continue;
    const known = store.vaults.vaults[dirName];
    if (!known) {
      const oldest = byBlock.length > 1 ? ((await read(byBlock[0]!.f)) ?? latest) : latest;
      store.vaults.vaults[dirName] = {
        firstSeen: { source: 'backfill', block: oldest.report.blockNumber, at: oldest.report.startedAt },
        deployBlock: null,
        lastCheck: lastCheckOf(latest.report, latest.reportPath),
        lastAttestationId: null,
        firstDepositBlock: null,
      };
      out.added++;
    } else if (!known.lastCheck || BigInt(known.lastCheck.block) < BigInt(latest.report.blockNumber)) {
      known.lastCheck = lastCheckOf(latest.report, latest.reportPath);
      out.updated++;
    } else {
      continue;
    }
    const beacon = beaconOf(latest.report);
    if (beacon) store.state.beacons[dirName] = beacon;
    else delete store.state.beacons[dirName];
  }
  return out;
}
