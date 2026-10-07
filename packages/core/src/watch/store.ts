import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rename, rm, truncate } from 'node:fs/promises';
import path from 'node:path';
import { getAddress } from 'viem';
import { z } from 'zod';
import { parseCheckReport } from '../attest/params.js';
import { acquirePidLock } from '../desk/store.js';
import type { StandardCheckReport } from '../standards/report.js';
import { defaultCacheDir } from '../standards/workspace.js';
import { ATTEST_CLASSES, outcomeOfReport } from './decide.js';
import {
  CHECK_CHANGE_KINDS,
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
 * deferred: checks whose attestation waits for a budget, the balance floor or a readable registry, each with its
 * own retry time. gasCostWei: what the watcher's attestations cost, summed. fingerprints: code hash and EIP-1967
 * slots of each vault at its last check, so an Upgraded that changed nothing does not buy a check. cooldowns:
 * vaults whose check timed out, not checked again before `until`. pending: changes waiting for a second check
 * at a later block. perSubject: attestations per vault on one UTC day. errorsAt: when an error line was last
 * written per key, so a failing subject writes at most one an hour. checkedBlocks: the block of the last
 * `checked` event per vault, so a newer report found in certs/checks at start is told from the watcher's own.
 * attesting: attest transactions sent whose receipt was not seen yet, recorded before it is awaited; each is
 * looked up first in the next pass, and nothing else is sent while one is; `replaced` holds the hashes of the
 * same nonce sent before with a lower fee, any of which may still be mined. A deferred entry's `nonce` resends
 * with the nonce of a transaction the node dropped, so at most one of the two can be mined. upgrades: Upgraded
 * or BeaconUpgraded of known vaults whose fingerprint could not be read yet, carried to the next pass.
 * implementations: the implementation each known vault ran at its last check. prices: the share value of each
 * subject whose value is followed (docs/adr/0006, "Share value"): the reference a drop is measured from
 * (assetsPerShare of 10 ** (decimals + scale) shares at `block`), the last read, a drop over the threshold waiting
 * for its confirming read, and the per-subject limits of drops. priceLowResolution: vaults whose share value is too
 * small to measure, not read again for six hours. recent entries of a price-drop carry drop: true, so status.json
 * counts them apart from changes of a result.
 */
export const watchStateSchema = z
  .object({
    v: z.literal(1),
    chainId: z.number().int().positive(),
    cursor: decimal.nullable(),
    seq: count,
    queue: z.array(queueEntrySchema),
    rejected: z.record(lowerAddress, z.object({ at: iso, block: decimal, reason: z.string(), fingerprint: hex32.optional() }).strict()),
    probing: z.record(
      lowerAddress,
      z
        .object({
          source,
          block: decimal,
          txHash: hex32.optional(),
          factory: z.object({ address: checksummed, name: z.string().min(1) }).strict().optional(),
          failures: count,
          notBefore: iso.optional(),
        })
        .strict(),
    ),
    beacons: z.record(lowerAddress, lowerAddress),
    attempted: z.record(lowerAddress, iso),
    subscriptions: z.record(decimal, z.object({ firstCheckAt: iso }).strict()),
    sweeps: z.array(iso),
    attestDay: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), used: count, unsolicited: count.default(0), candidateFails: count.default(0) }).strict(),
    recent: z.array(z.object({ kind: z.enum(FEED_KINDS), at: iso, drop: z.literal(true).optional() }).strict()),
    sourcesSeen: z.record(z.string(), count),
    deferred: z.record(
      lowerAddress,
      z
        .object({
          reportPath: z.string().min(1),
          reportURI: z.string().min(1),
          source,
          at: iso,
          cls: z.enum(ATTEST_CLASSES).optional(),
          failures: count.default(0),
          notBefore: iso.optional(),
          nonce: count.optional(),
          /** A fail of a candidate no factory announced and nobody attested: counted against maxCandidateFailsPerDay. */
          candidate: z.boolean().optional(),
        })
        .strict(),
    ),
    gasCostWei: decimal.default('0'),
    fingerprints: z.record(lowerAddress, hex32).default({}),
    cooldowns: z.record(lowerAddress, z.object({ until: iso, timeouts: count }).strict()).default({}),
    pending: z
      .record(
        lowerAddress,
        z
          .object({
            reportPath: z.string().min(1),
            reportURI: z.string().min(1),
            block: decimal,
            at: iso,
            outcome: z
              .object({
                summary: z.object({ pass: count, fail: count, inconclusive: count, notApplicable: count }).strict(),
                failed: z.array(z.string()),
                implementationKey: hex32.nullable(),
              })
              .strict(),
            source,
            firstCheck: z.boolean(),
            attempts: count,
            /** The change the second check must agree on; absent in states written before it was recorded. */
            kind: z.enum(CHECK_CHANGE_KINDS).optional(),
            /** The fuzz seed of the pending check, which its confirmation reuses. */
            seed: hex32.optional(),
          })
          .strict(),
      )
      .default({}),
    perSubject: z.record(lowerAddress, z.object({ day: z.string(), used: count }).strict()).default({}),
    errorsAt: z.record(z.string(), iso).default({}),
    checkedBlocks: z.record(lowerAddress, decimal).default({}),
    attesting: z
      .record(
        lowerAddress,
        z
          .object({
            hash: hex32,
            nonce: count,
            at: iso,
            reportPath: z.string().min(1),
            reportURI: z.string().min(1),
            block: decimal,
            source,
            cls: z.enum(ATTEST_CLASSES),
            /** Written before the attested event took it from the receipt; read no more. */
            supersedes: decimal.nullable().optional(),
            replaced: z.array(hex32).default([]),
            bumps: count.default(0),
            candidate: z.boolean().optional(),
          })
          .strict(),
      )
      .default({}),
    upgrades: z
      .record(lowerAddress, z.object({ source, block: decimal, txHash: hex32.optional(), failures: count, notBefore: iso.optional() }).strict())
      .default({}),
    implementations: z.record(lowerAddress, lowerAddress).default({}),
    prices: z
      .record(
        lowerAddress,
        z
          .object({
            decimals: count,
            scale: count.default(0),
            assetsPerShare: decimal,
            block: decimal,
            /** Absent in states written before rises waited for a second read (b30a051): the reference then. */
            readAssetsPerShare: decimal.optional(),
            readBlock: decimal,
            readAt: iso,
            drop: z.object({ assetsPerShare: decimal, block: decimal, at: iso, misses: count.default(0) }).strict().optional(),
            /** Since when the subject is not followed (no subscription, no attestation, no --price-all); forgotten 24 hours later. */
            unfollowedAt: iso.optional(),
            /** Price-drop events of this subject on one UTC day, against maxPriceDropsPerDay, and the largest of them in bps. */
            dropsDay: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count, maxBps: count.default(0) }).strict().optional(),
            /** When a drop last queued a re-check of the subject (one per upgradeCooldownMs). */
            recheckAt: iso.optional(),
          })
          .strict()
          .transform((t) => ({ ...t, readAssetsPerShare: t.readAssetsPerShare ?? t.assetsPerShare })),
      )
      .default({}),
    /** Vaults whose share value is too small to measure a drop in at any scale, and when that was found. */
    priceLowResolution: z.record(lowerAddress, iso).default({}),
  })
  .strict();
export type WatchState = z.output<typeof watchStateSchema>;

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
    attestDay: { day: '1970-01-01', used: 0, unsolicited: 0, candidateFails: 0 },
    recent: [],
    sourcesSeen: {},
    deferred: {},
    gasCostWei: '0',
    fingerprints: {},
    cooldowns: {},
    pending: {},
    perSubject: {},
    errorsAt: {},
    checkedBlocks: {},
    attesting: {},
    upgrades: {},
    implementations: {},
    prices: {},
    priceLowResolution: {},
  };
}

/**
 * Writes through a temp file in the same directory, fsyncs it, renames it into place and fsyncs the
 * directory, so a crash leaves either the old file or the new one, never a half or an empty one.
 */
async function writeDurable(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
  const d = await open(dir, 'r');
  try {
    await d.sync();
  } catch {
    /* some filesystems refuse fsync on a directory */
  } finally {
    await d.close();
  }
}

/**
 * Start-up repair of a watch directory after a crash: a last feed line without its newline (a write cut
 * short) is cut off, so the next append starts a clean line, and temp files of interrupted writes are removed.
 */
async function repairDir(dir: string, feedPath: string): Promise<void> {
  if (!existsSync(dir)) return;
  for (const f of await readdir(dir)) {
    if (/^\..+\.tmp-\d+-[0-9a-f]{8}$/.test(f)) await rm(path.join(dir, f), { force: true });
  }
  if (!existsSync(feedPath)) return;
  const fh = await open(feedPath, 'r');
  let keep: number | null = null;
  try {
    const { size } = await fh.stat();
    if (size === 0) return;
    const last = Buffer.alloc(1);
    await fh.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    // Walk back to the last newline; everything after it is the cut line.
    const chunk = 65_536;
    let end = size;
    keep = 0;
    while (end > 0) {
      const start = Math.max(0, end - chunk);
      const buf = Buffer.alloc(end - start);
      await fh.read(buf, 0, buf.length, start);
      const i = buf.lastIndexOf(0x0a);
      if (i >= 0) {
        keep = start + i + 1;
        break;
      }
      end = start;
    }
  } finally {
    await fh.close();
  }
  if (keep !== null) await truncate(feedPath, keep);
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

  /** Writes vaults.json and state.json, then status.json when given, each through an fsynced temp file and a rename. */
  async save(status?: WatchStatus): Promise<void> {
    await writeDurable(this.vaultsPath, `${JSON.stringify(watchVaultsSchema.parse(this.vaults), null, 2)}\n`);
    await writeDurable(this.statePath, `${JSON.stringify(watchStateSchema.parse(this.state), null, 2)}\n`);
    if (status) await writeDurable(this.statusPath, `${JSON.stringify(watchStatusSchema.parse(status), null, 2)}\n`);
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
    for (const e of stamped) if (COUNTED.has(e.kind)) this.state.recent.push({ kind: e.kind, at: e.at, ...(e.change?.kind === 'price-drop' ? { drop: true as const } : {}) });
    return stamped;
  }

  /**
   * Loads `<projectDir>/.specfirst/watch/<chainId>`. Missing files start empty. A state.json of another chain
   * is refused. seq continues after the last line of feed.ndjson when that is ahead of state.json (a crash
   * between the append and the save). With `repair` (the lock's holder), a cut last feed line and temp files
   * left by interrupted writes are removed first.
   */
  static async load(projectDir: string, chainId: number, opts: { repair?: boolean } = {}): Promise<WatchStore> {
    const dir = path.join(projectDir, WATCH_DIR, String(chainId));
    const statePath = path.join(dir, WATCH_STATE_JSON);
    // Only the holder of the directory's lock repairs it: another watcher may be in the middle of a write.
    if (opts.repair) await repairDir(dir, path.join(dir, WATCH_FEED_NDJSON));
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

/** Where issuer locks live: $SPECFIRST_LOCK_DIR, else `locks` in the cache directory (defaultCacheDir). */
export const LOCK_DIR_ENV = 'SPECFIRST_LOCK_DIR';

export function lockDir(env: NodeJS.ProcessEnv = process.env): string {
  return env[LOCK_DIR_ENV] ? path.resolve(env[LOCK_DIR_ENV]!) : path.join(defaultCacheDir(env), 'locks');
}

/**
 * Takes `<lockDir>/issuer-<address>.lock` for the user: two watchers that sign with one key collide on nonces
 * even when they watch different chains or projects, so the key, not the directory, is what is locked.
 */
export function acquireIssuerLock(
  issuer: string,
  opts: { dir?: string; pid?: number; isAlive?: (pid: number) => boolean } = {},
): Promise<() => Promise<void>> {
  const { dir, ...rest } = opts;
  return acquirePidLock(path.join(dir ?? lockDir(), `issuer-${issuer.toLowerCase()}.lock`), {
    ...rest,
    holder: `watcher signing as ${getAddress(issuer)}`,
    error: (m) => new WatchError(m),
  });
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

/** The implementation a report says the subject's proxy ran (lowercase), or null for no proxy or an unknown one. */
export function implementationOf(report: StandardCheckReport): string | null {
  const p = report.identity.proxy as { implementation?: string | null } | null;
  return p && typeof p.implementation === 'string' && /^0x[0-9a-fA-F]{40}$/.test(p.implementation) ? p.implementation.toLowerCase() : null;
}

const REPORT_FILE = /^(0|[1-9]\d*)-[0-9a-f]{16}\.json$/;

/**
 * Adds the vaults of `certs/checks/<chainId>/` (the known set before the watcher, docs/adr/0006) to
 * vaults.json: an address not known yet gets firstSeen backfill (block and startedAt of its oldest report)
 * and its latest report as lastCheck. A known one whose newest report is newer than its last `checked` event
 * (a desk check, say) is not overwritten: it is returned in `adopt`, for the watcher to take through the
 * change decision like a check of its own. Unreadable reports are skipped and listed.
 */
export async function seedKnownVaults(
  projectDir: string,
  store: WatchStore,
): Promise<{ added: number; adopt: Array<{ subject: string; reportPath: string }>; skipped: string[] }> {
  const chainId = store.state.chainId;
  const root = path.join(projectDir, 'certs', 'checks', String(chainId));
  const out = { added: 0, adopt: [] as Array<{ subject: string; reportPath: string }>, skipped: [] as string[] };
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
    const known = store.vaults.vaults[dirName];
    if (known) {
      const newest = byBlock[byBlock.length - 1]!;
      const seen = store.state.checkedBlocks[dirName] ?? known.lastCheck?.block;
      if (seen === undefined || newest.block > BigInt(seen)) {
        const r = await read(newest.f);
        if (r) out.adopt.push({ subject: dirName, reportPath: r.reportPath });
      }
      continue;
    }
    const latest = await read(byBlock[byBlock.length - 1]!.f);
    if (!latest) continue;
    const oldest = byBlock.length > 1 ? ((await read(byBlock[0]!.f)) ?? latest) : latest;
    store.vaults.vaults[dirName] = {
      firstSeen: { source: 'backfill', block: oldest.report.blockNumber, at: oldest.report.startedAt },
      deployBlock: null,
      lastCheck: lastCheckOf(latest.report, latest.reportPath),
      lastAttestationId: null,
      firstDepositBlock: null,
    };
    store.state.checkedBlocks[dirName] = latest.report.blockNumber;
    out.added++;
    const beacon = beaconOf(latest.report);
    if (beacon) store.state.beacons[dirName] = beacon;
    else delete store.state.beacons[dirName];
    const implementation = implementationOf(latest.report);
    if (implementation) store.state.implementations[dirName] = implementation;
    else delete store.state.implementations[dirName];
  }
  return out;
}
