import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearWatchCaches, parseFeedText, readFeed, readStatus, readVaults, splitChunk, watchedChains } from '../lib/watch/read';
import { resolveReportPath } from '../lib/watch/paths';

/*
 * The watcher writes these files while the web reads them. Nothing may throw: a missing directory reads as "not
 * running", a bad line is skipped and counted, a half-written line waits for the next read.
 */

const line = (seq: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ v: 1, seq, at: '2026-10-06T09:00:00.000Z', kind: 'queued', chainId: 143, subject: '0xFEeD000000000000000000000000000000000001', ...extra });

let dir: string;
const env = { ...process.env };

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sf-watch-read-'));
});
afterAll(async () => {
  process.env = env;
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => clearWatchCaches());

describe('lenient feed parsing', () => {
  it('skips and counts lines that are not JSON or not events; blank lines are not counted', () => {
    const p = parseFeedText([line(0), '', '{"v":1,', 'hello', line(1, { kind: 'nonsense' }), line(2), ''].join('\n'));
    expect(p.events.map((e) => e.seq)).toEqual([0, 2]);
    expect(p.skipped).toBe(3);
  });

  it('splitChunk leaves a torn last line for later, takes a whole one, and counts bytes not characters', () => {
    const torn = `${line(0)}\n${line(1).slice(0, 40)}`;
    expect(splitChunk(torn)).toEqual({ lines: [line(0)], consumed: Buffer.byteLength(`${line(0)}\n`) });
    const whole = `${line(0)}\n${line(1)}`;
    expect(splitChunk(whole).lines).toHaveLength(2);
    expect(splitChunk(whole).consumed).toBe(Buffer.byteLength(whole));
    const wide = `${line(0, { reason: 'naïve ünïcödé' })}\n`;
    expect(splitChunk(wide).consumed).toBe(Buffer.byteLength(wide));
    expect(splitChunk('').consumed).toBe(0);
  });
});

describe('readFeed', () => {
  it('reads incrementally: a torn line is picked up once it is finished, and only new bytes are parsed', async () => {
    const file = path.join(dir, 'inc.ndjson');
    await writeFile(file, `${line(0)}\n${line(1).slice(0, 30)}`);
    let s = await readFeed(file);
    expect(s.available).toBe(true);
    expect(s.events.map((e) => e.seq)).toEqual([0]);
    await appendFile(file, `${line(1).slice(30)}\nnot json\n${line(2)}\n`);
    s = await readFeed(file);
    expect(s.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(s.skipped).toBe(1);
    s = await readFeed(file);
    expect(s.events).toHaveLength(3);
  });

  it('starts over when the file is replaced or shrinks', async () => {
    const file = path.join(dir, 'rot.ndjson');
    await writeFile(file, `${line(0)}\n${line(1)}\n${line(2)}\n`);
    expect((await readFeed(file)).events).toHaveLength(3);
    await writeFile(file, `${line(9)}\n`);
    const s = await readFeed(file);
    expect(s.events.map((e) => e.seq)).toEqual([9]);
  });

  it('a missing feed is unavailable, not an error', async () => {
    const s = await readFeed(path.join(dir, 'nope', 'feed.ndjson'));
    expect(s).toMatchObject({ available: false, problem: 'missing', events: [] });
  });
});

describe('status.json and vaults.json', () => {
  it('a missing watch dir means no chains and nothing running', async () => {
    process.env.SPECFIRST_WATCH_DIR = path.join(dir, 'absent');
    expect(await watchedChains()).toEqual([]);
    expect(await readStatus(143)).toMatchObject({ available: false, problem: 'missing', status: null });
    expect(await readVaults(143)).toMatchObject({ available: false, problem: 'missing', vaults: {} });
  });

  it('a torn status.json is "invalid JSON", a wrong shape names the field', async () => {
    process.env.SPECFIRST_WATCH_DIR = path.join(dir, 'w');
    await mkdir(path.join(dir, 'w', '143'), { recursive: true });
    await writeFile(path.join(dir, 'w', '143', 'status.json'), '{"v":1,"chainId":14');
    expect(await readStatus(143)).toMatchObject({ available: false, problem: 'invalid JSON' });
    await writeFile(path.join(dir, 'w', '143', 'status.json'), JSON.stringify({ v: 1, chainId: 143 }));
    const s = await readStatus(143);
    expect(s).toMatchObject({ available: false, problem: 'unexpected shape' });
    expect(s.detail).toMatch(/^head:/);
    expect(await watchedChains()).toEqual([143]);
  });
});

describe('report paths from the feed', () => {
  it('certs/checks/... maps onto the checks directory; anything leaving it is refused', () => {
    const e = { SPECFIRST_REPO_ROOT: '/repo', SPECFIRST_CHECKS_DIR: '/data/checks' };
    const a = '0xfeed000000000000000000000000000000000001';
    expect(resolveReportPath(`certs/checks/143/${a}/1-ab.json`, e)).toEqual({ abs: `/data/checks/143/${a}/1-ab.json`, rel: `143/${a}/1-ab.json` });
    expect(resolveReportPath(`/data/checks/143/${a}/1-ab.json`, e)?.rel).toBe(`143/${a}/1-ab.json`);
    expect(resolveReportPath(`certs/checks/../../etc/passwd.json`, e)).toBeNull();
    expect(resolveReportPath(`certs/checks/143/${a}/1-ab.forge.json`, e)).toBeNull();
    expect(resolveReportPath(`certs/checks/143/${a}/x.txt`, e)).toBeNull();
    expect(resolveReportPath(`packages/web/data/board.json`, e)).toBeNull();
  });
});
