import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { hypersyncFirstEmitters, HypersyncError, hypersyncLogsReader, hypersyncWindowReader, logsWithFallback, LogsNodeBehindError, type SignalLog } from '../src/index.js';

const T0 = `0x${'dc'.repeat(32)}` as Hex;
const T1 = `0x${'bc'.repeat(32)}` as Hex;
const TX = `0x${'ab'.repeat(32)}` as Hex;
const word = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

interface Sent {
  url: string;
  auth: string | null;
  body: { from_block: number; to_block: number; logs: Array<{ topics: Hex[][] }>; field_selection: { log: string[] } };
}

/** A fetch that answers HyperSync queries from `pages` in order and records what was sent. */
function stubFetch(pages: Array<{ status?: number; body?: unknown }>): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  let i = 0;
  const f = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({ url: String(url), auth: headers.get('authorization'), body: JSON.parse(String(init?.body)) as Sent['body'] });
    const page = pages[Math.min(i++, pages.length - 1)]!;
    return new Response(JSON.stringify(page.body ?? {}), { status: page.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, sent };
}

const log = (block: number, index: number, address = '0x00000000000000000000000000000000000000a1', topic0: Hex = T0) => ({
  block_number: block,
  log_index: index,
  transaction_hash: TX,
  address,
  data: '0x',
  topic0,
  topic1: word(1),
  topic2: null,
  topic3: null,
});

describe('HyperSync logs (docs/adr/0009)', () => {
  it('H1: reads an inclusive range as HyperSync exclusive to_block, follows next_block, and returns eth_getLogs order', async () => {
    const s = stubFetch([
      { body: { data: [{ logs: [log(105, 3), log(101, 7)] }], next_block: 106, archive_height: 500 } },
      { body: { data: [{ logs: [log(110, 0, '0x00000000000000000000000000000000000000b2', T1), log(105, 1)] }], next_block: 121, archive_height: 500 } },
    ]);
    const read = hypersyncLogsReader({ url: 'https://143.hypersync.xyz/', token: 'tok', fetch: s.fetch });
    const out = await read(100n, 120n, [T0, T1]);
    expect(s.sent.map((x) => [x.url, x.auth, x.body.from_block, x.body.to_block])).toEqual([
      ['https://143.hypersync.xyz/query', 'Bearer tok', 100, 121],
      ['https://143.hypersync.xyz/query', 'Bearer tok', 106, 121],
    ]);
    expect(s.sent[0]!.body.logs).toEqual([{ topics: [[T0, T1]] }]);
    expect(out.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(['101:7', '105:1', '105:3', '110:0']);
    expect(out[0]).toEqual<SignalLog>({ address: '0x00000000000000000000000000000000000000a1', topics: [T0, word(1) as Hex], data: '0x', blockNumber: 101n, transactionHash: TX, logIndex: 7 });
  });

  it('H2: an archive that ends below toBlock is a node behind, with the last block it has', async () => {
    const s = stubFetch([
      { body: { data: [{ logs: [log(100, 0)] }], next_block: 150, archive_height: 150 } },
      { body: { data: [], next_block: 150, archive_height: 150 } },
    ]);
    const read = hypersyncLogsReader({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: s.fetch });
    await expect(read(100n, 200n, [T0])).rejects.toEqual(new LogsNodeBehindError(149n));
  });

  it('H3: a refused token, a rate limit and an answer without next_block are HyperSync errors', async () => {
    const at = async (page: { status?: number; body?: unknown }) => {
      const read = hypersyncLogsReader({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: stubFetch([page]).fetch });
      return read(1n, 2n, [T0]).then(
        () => null,
        (e: unknown) => e,
      );
    };
    const refused = await at({ status: 401, body: { error: 'bad token' } });
    expect(refused).toBeInstanceOf(HypersyncError);
    expect(refused).toMatchObject({ status: 401, message: expect.stringMatching(/^HyperSync refused the API token \(HTTP 401\)/) });
    expect(await at({ status: 429 })).toMatchObject({ status: 429, message: expect.stringMatching(/rate limited/) });
    expect(await at({ body: { data: [] } })).toMatchObject({ message: 'HyperSync answered without data or next_block' });
  });

  it('H4: logsWithFallback reads from the RPC when HyperSync fails or is behind, leaves HyperSync alone for a doubling cooldown, and says when it serves again', async () => {
    const events: string[] = [];
    let t = 0;
    let primary: () => Promise<SignalLog[]> = async () => {
      throw new HypersyncError('HyperSync failed (HTTP 502)', 502);
    };
    const rpcLogs: SignalLog[] = [{ address: '0x00000000000000000000000000000000000000a1', topics: [T0], data: '0x', blockNumber: 5n, transactionHash: TX, logIndex: 0 }];
    const read = logsWithFallback(
      () => {
        events.push('hypersync');
        return primary();
      },
      async (f, to) => {
        events.push(`rpc ${f}-${to}`);
        return rpcLogs;
      },
      { now: () => t, onFallback: (e, _f, _t, cd) => events.push(`fallback ${cd / 1000}s: ${(e as Error).message}`), onRecover: () => events.push('recovered') },
    );
    expect(await read(1n, 20n, [T0])).toBe(rpcLogs);
    t = 59_000;
    expect(await read(21n, 30n, [T0])).toBe(rpcLogs);
    t = 61_000;
    expect(await read(21n, 30n, [T0])).toBe(rpcLogs);
    t = 190_000;
    primary = async () => [];
    expect(await read(31n, 40n, [T0])).toEqual([]);
    primary = async () => {
      throw new LogsNodeBehindError(45n);
    };
    expect(await read(41n, 50n, [T0])).toBe(rpcLogs);
    expect(events).toEqual([
      'hypersync',
      'fallback 60s: HyperSync failed (HTTP 502)',
      'rpc 1-20',
      'rpc 21-30',
      'hypersync',
      'fallback 120s: HyperSync failed (HTTP 502)',
      'rpc 21-30',
      'hypersync',
      'recovered',
      'hypersync',
      'fallback 60s: the getLogs node is at block 45, behind the requested range',
      'rpc 41-50',
    ]);
  });

  it('H7: a whole-chain read waits out HTTP 429s and carries on from the same block; the watcher reader does not wait', async () => {
    const s = stubFetch([
      { body: { data: [{ logs: [{ block_number: 4, address: '0x00000000000000000000000000000000000000bb' }] }], next_block: 10, archive_height: 99 } },
      { status: 429 },
      { status: 429 },
      { body: { data: [{ logs: [{ block_number: 12, address: '0x00000000000000000000000000000000000000cc' }] }], next_block: 21, archive_height: 99 } },
    ]);
    const waits: number[] = [];
    const r = await hypersyncFirstEmitters({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: s.fetch, sleep: async (ms) => void waits.push(ms) }, 0n, 20n, T0);
    expect(r.first.size).toBe(2);
    expect(waits).toEqual([5_000, 10_000]);
    expect(s.sent.map((x) => x.body.from_block)).toEqual([0, 10, 10, 10]);
    const once = stubFetch([{ status: 429 }]);
    await expect(hypersyncLogsReader({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: once.fetch })(1n, 2n, [T0])).rejects.toMatchObject({ status: 429 });
    expect(once.sent).toHaveLength(1);
  });

  it('H8: the watcher reader asks HyperSync once per window for every topic, serves each topic from it, and asks again after a failure', async () => {
    const s = stubFetch([
      { status: 502 },
      { body: { data: [{ logs: [log(101, 0, undefined, T1), log(100, 2)] }], next_block: 111, archive_height: 500 } },
      { body: { data: [{ logs: [] }], next_block: 121, archive_height: 500 } },
    ]);
    const read = hypersyncWindowReader({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: s.fetch }, [T0, T1]);
    await expect(read(100n, 110n, [T0])).rejects.toMatchObject({ status: 502 });
    expect((await read(100n, 110n, [T0])).map((l) => l.logIndex)).toEqual([2]);
    expect((await read(100n, 110n, [T1])).map((l) => l.blockNumber)).toEqual([101n]);
    expect(await read(111n, 120n, [T0])).toEqual([]);
    expect(s.sent.map((x) => [x.body.from_block, x.body.logs[0]!.topics])).toEqual([
      [100, [[T0, T1]]],
      [100, [[T0, T1]]],
      [111, [[T0, T1]]],
    ]);
  });

  it('H6: an archive that ends inside the range stops the read there even when next_block says more, and a refusal never shows the token', async () => {
    const s = stubFetch([{ body: { data: [{ logs: [log(100, 0)] }], next_block: 201, archive_height: 150 } }]);
    const read = hypersyncLogsReader({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: s.fetch });
    await expect(read(100n, 200n, [T0])).rejects.toEqual(new LogsNodeBehindError(149n));
    expect(s.sent).toHaveLength(1);
    const echo = stubFetch([{ status: 500, body: { error: 'bad bearer tok-secret-1' } }]);
    const err = await hypersyncLogsReader({ url: 'https://143.hypersync.xyz', token: 'tok-secret-1', fetch: echo.fetch })(1n, 2n, [T0]).catch((e: unknown) => e as Error);
    expect(err.message).toBe('HyperSync failed (HTTP 500): {"error":"bad bearer [token]"}');
  });

  it('H5: hypersyncFirstEmitters keeps the first block of each emitter across pages and asks only for address and block', async () => {
    const s = stubFetch([
      { body: { data: [{ logs: [{ block_number: 9, address: '0x00000000000000000000000000000000000000AA' }, { block_number: 4, address: '0x00000000000000000000000000000000000000bb' }] }], next_block: 10, archive_height: 99 } },
      { body: { data: [{ logs: [{ block_number: 3, address: '0x00000000000000000000000000000000000000aa' }, { block_number: 12, address: '0x00000000000000000000000000000000000000cc' }] }], next_block: 21, archive_height: 99 } },
    ]);
    const pages: number[] = [];
    const r = await hypersyncFirstEmitters({ url: 'https://143.hypersync.xyz', token: 'tok', fetch: s.fetch }, 0n, 20n, T0, (p) => pages.push(p.emitters));
    expect(Object.fromEntries(r.first)).toEqual({
      '0x00000000000000000000000000000000000000aa': 3n,
      '0x00000000000000000000000000000000000000bb': 4n,
      '0x00000000000000000000000000000000000000cc': 12n,
    });
    expect(Object.fromEntries(r.counts)).toEqual({
      '0x00000000000000000000000000000000000000aa': 2,
      '0x00000000000000000000000000000000000000bb': 1,
      '0x00000000000000000000000000000000000000cc': 1,
    });
    expect([r.logs, r.reachedTo, pages]).toEqual([4, 20n, [2, 3]]);
    expect(s.sent[0]!.body.field_selection).toEqual({ log: ['block_number', 'address'] });
  });
});
