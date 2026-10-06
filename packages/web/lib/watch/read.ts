import { open, readdir, readFile, stat } from 'node:fs/promises';
import { feedEventSchema, watchStatusSchema, watchVaultSchema, type FeedEvent, type WatchStatus, type WatchVault } from './core';
import { isChainId, watchDir, watchFile } from './paths';

/*
 * Reads the watcher's files. Another process writes them while we read, so nothing here throws: a missing
 * directory is "watcher not running", a bad feed line is skipped and counted, a torn or odd status.json is
 * "unavailable" with a reason. The feed is append only, so it is read incrementally: each call reads only the
 * bytes added since the last one.
 */

export type FileProblem = 'missing' | 'unreadable' | 'invalid JSON' | 'unexpected shape';

/* Feed */

export interface ParsedFeed {
  events: FeedEvent[];
  /** Lines that were not JSON or did not match the schema. */
  skipped: number;
}

/** Parses complete ndjson lines. Blank lines are ignored; every other line is an event or counted as skipped. */
export function parseFeedLines(lines: readonly string[]): ParsedFeed {
  const events: FeedEvent[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const e = feedEventSchema.safeParse(raw);
    if (e.success) events.push(e.data);
    else skipped++;
  }
  return { events, skipped };
}

export function parseFeedText(text: string): ParsedFeed {
  return parseFeedLines(text.split('\n'));
}

export interface FeedSnapshot {
  available: boolean;
  problem: FileProblem | null;
  /** In file order (the watcher appends in seq order). */
  events: readonly FeedEvent[];
  skipped: number;
  /** Events dropped from memory because the feed outgrew MAX_FEED_EVENTS (the oldest go first). */
  dropped: number;
}

interface FeedState {
  ino: number;
  offset: number;
  events: FeedEvent[];
  skipped: number;
  dropped: number;
}

/** Enough for months of a busy watcher; past it the oldest events leave memory, never the file. */
export const MAX_FEED_EVENTS = 200_000;
const MAX_CHUNK = 64 * 1024 * 1024;

const feeds = new Map<string, FeedState>();
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

/**
 * Splits new bytes into complete lines plus the unfinished tail, counting in bytes so a multi-byte character never
 * shifts the offset. A tail that is already a whole JSON object is taken too: a writer that ends its last line
 * without a newline would otherwise never be read, and a torn line is never valid JSON.
 */
export function splitChunk(chunk: Buffer | string): { lines: string[]; consumed: number } {
  const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
  const last = buf.lastIndexOf(0x0a);
  const lines = last >= 0 ? buf.subarray(0, last).toString('utf8').split('\n') : [];
  let consumed = last + 1;
  const tail = buf.subarray(last + 1).toString('utf8');
  if (/^\s*\{[\s\S]*\}\s*$/.test(tail)) {
    try {
      JSON.parse(tail);
      lines.push(tail);
      consumed = buf.length;
    } catch {
      // Still being written.
    }
  }
  return { lines, consumed };
}

export async function readFeed(file: string): Promise<FeedSnapshot> {
  return withLock(file, async () => {
    let st;
    try {
      st = await stat(file);
    } catch (err) {
      feeds.delete(file);
      return { available: false, problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', events: [], skipped: 0, dropped: 0 } as FeedSnapshot;
    }
    let s = feeds.get(file);
    if (!s || s.ino !== st.ino || st.size < s.offset) {
      s = { ino: st.ino, offset: 0, events: [], skipped: 0, dropped: 0 };
      feeds.set(file, s);
    }
    if (st.size > s.offset) {
      try {
        const fh = await open(file, 'r');
        try {
          const len = Math.min(st.size - s.offset, MAX_CHUNK);
          const buf = Buffer.alloc(len);
          const { bytesRead } = await fh.read(buf, 0, len, s.offset);
          const { lines, consumed } = splitChunk(buf.subarray(0, bytesRead));
          const parsed = parseFeedLines(lines);
          s.events.push(...parsed.events);
          s.skipped += parsed.skipped;
          s.offset += consumed;
          if (s.events.length > MAX_FEED_EVENTS) {
            const extra = s.events.length - MAX_FEED_EVENTS;
            s.events.splice(0, extra);
            s.dropped += extra;
          }
        } finally {
          await fh.close();
        }
      } catch {
        return { available: true, problem: 'unreadable', events: s.events, skipped: s.skipped, dropped: s.dropped } as FeedSnapshot;
      }
    }
    return { available: true, problem: null, events: s.events, skipped: s.skipped, dropped: s.dropped } as FeedSnapshot;
  });
}

/* JSON files, cached by size and mtime */

const jsonCache = new Map<string, { key: string; value: unknown }>();

async function readJsonFile<T>(file: string, parse: (raw: unknown) => T): Promise<{ problem: FileProblem | null; value: T | null }> {
  let st;
  try {
    st = await stat(file);
  } catch (err) {
    return { problem: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable', value: null };
  }
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = jsonCache.get(file);
  if (hit?.key === key) return { problem: null, value: hit.value as T };
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { problem: 'unreadable', value: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: 'invalid JSON', value: null };
  }
  const value = parse(raw);
  if (value === null) return { problem: 'unexpected shape', value: null };
  jsonCache.set(file, { key, value });
  return { problem: null, value };
}

/* status.json */

export interface StatusSnapshot {
  available: boolean;
  problem: FileProblem | null;
  /** The first schema problem, "queue.0.subject: Invalid", when the shape is off. */
  detail: string | null;
  status: WatchStatus | null;
  /** Optional top-level gasCostWei, if the watcher reports what it spent on attestations. */
  gasCostWei: bigint | null;
}

export function parseWatchStatus(raw: unknown): { status: WatchStatus | null; detail: string | null; gasCostWei: bigint | null } {
  const r = watchStatusSchema.safeParse(raw);
  const gas = (raw as { gasCostWei?: unknown } | null)?.gasCostWei;
  const gasCostWei = typeof gas === 'string' && /^\d+$/.test(gas) ? BigInt(gas) : typeof gas === 'number' && Number.isSafeInteger(gas) && gas >= 0 ? BigInt(gas) : null;
  if (r.success) return { status: r.data, detail: null, gasCostWei };
  const issue = r.error.issues[0];
  return { status: null, detail: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'invalid', gasCostWei };
}

export async function readStatus(chainId: number | string): Promise<StatusSnapshot> {
  const { problem, value } = await readJsonFile(watchFile.status(chainId), (raw) => parseWatchStatus(raw));
  if (!value) return { available: false, problem, detail: null, status: null, gasCostWei: null };
  if (!value.status) return { available: false, problem: 'unexpected shape', detail: value.detail, status: null, gasCostWei: value.gasCostWei };
  return { available: true, problem: null, detail: null, status: value.status, gasCostWei: value.gasCostWei };
}

/* vaults.json */

export interface VaultsSnapshot {
  available: boolean;
  problem: FileProblem | null;
  /** Keyed by lowercase address. */
  vaults: Record<string, WatchVault>;
  /** Entries that did not match the schema. */
  skipped: number;
}

/** Keeps every good entry when one is bad; null when the file is not a v1 vaults object at all. */
export function parseWatchVaults(raw: unknown): { vaults: Record<string, WatchVault>; skipped: number } | null {
  const r = raw as { v?: unknown; vaults?: unknown } | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || !r.vaults || typeof r.vaults !== 'object' || Array.isArray(r.vaults)) return null;
  const vaults: Record<string, WatchVault> = {};
  let skipped = 0;
  for (const [key, value] of Object.entries(r.vaults as Record<string, unknown>)) {
    const v = watchVaultSchema.safeParse(value);
    if (/^0x[0-9a-fA-F]{40}$/.test(key) && v.success) vaults[key.toLowerCase()] = v.data;
    else skipped++;
  }
  return { vaults, skipped };
}

export async function readVaults(chainId: number | string): Promise<VaultsSnapshot> {
  const { problem, value } = await readJsonFile(watchFile.vaults(chainId), parseWatchVaults);
  if (!value) return { available: false, problem, vaults: {}, skipped: 0 };
  return { available: true, problem: null, vaults: value.vaults, skipped: value.skipped };
}

/** Subject chains that have a directory under the watch dir, ascending. [] when the watch dir does not exist. */
export async function watchedChains(dir: string = watchDir()): Promise<number[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && isChainId(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** For tests. */
export function clearWatchCaches(): void {
  feeds.clear();
  jsonCache.clear();
}

