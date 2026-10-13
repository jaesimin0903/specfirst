import type { Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { hypersyncFirstEmitters, HypersyncError, hypersyncLogsReader, logsWithFallback, LogsNodeBehindError, type SignalLog } from '../src/index.js';

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

  it('H4: logsWithFallback asks the RPC when HyperSync fails or is far behind, and says when HyperSync serves again', async () => {
    const events: string[] = [];
    let primary: () => Promise<SignalLog[]> = async () => {
      throw new HypersyncError('HyperSync failed (HTTP 502)', 502);
    };
    const rpcLogs: SignalLog[] = [{ address: '0x00000000000000000000000000000000000000a1', topics: [T0], data: '0x', blockNumber: 5n, transactionHash: TX, logIndex: 0 }];
    const read = logsWithFallback(
      () => primary(),
      async (f, t) => {
        events.push(`rpc ${f}-${t}`);
        return rpcLogs;
      },
      { maxBehindBlocks: 10n, onFallback: (e) => events.push(`fallback ${(e as Error).message}`), onRecover: () => events.push('recovered') },
    );
    expect(await read(1n, 20n, [T0])).toBe(rpcLogs);
    primary = async () => [];
    expect(await read(21n, 30n, [T0])).toEqual([]);
    expect(await read(31n, 40n, [T0])).toEqual([]);
    primary = async () => {
      throw new LogsNodeBehindError(45n);
    };
    await expect(read(41n, 50n, [T0])).rejects.toEqual(new LogsNodeBehindError(45n));
    primary = async () => {
      throw new LogsNodeBehindError(30n);
    };
    expect(await read(41n, 50n, [T0])).toBe(rpcLogs);
    expect(events).toEqual(['fallback HyperSync failed (HTTP 502)', 'rpc 1-20', 'recovered', 'fallback the getLogs node is at block 30, behind the requested range', 'rpc 41-50']);
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
    expect([r.logs, r.reachedTo, pages]).toEqual([4, 20n, [2, 3]]);
    expect(s.sent[0]!.body.field_selection).toEqual({ log: ['block_number', 'address'] });
  });
});
