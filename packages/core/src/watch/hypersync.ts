import type { Address, Hex } from 'viem';
import { LogsNodeBehindError } from './logs.js';
import type { SignalLog } from './sources.js';

/**
 * Envio HyperSync (docs/adr/0009): the watcher's logs from an indexed archive instead of eth_getLogs, so a read is
 * not cut into the node's block range limit and a backfill over the whole chain takes minutes. The subject RPC
 * stays: forge forks, prechecks, fingerprints and share values read state, which HyperSync does not serve, and
 * the logs go to it whenever HyperSync fails.
 */
export const ENVIO_API_TOKEN_ENV = 'ENVIO_API_TOKEN';

/** HyperSync's URL for a chain id, as Envio names them (https://143.hypersync.xyz for Monad mainnet). */
export function hypersyncUrlOf(chainId: number): string {
  return `https://${chainId}.hypersync.xyz`;
}

/** A refusal or a malformed answer from HyperSync; `status` is the HTTP status when there was one. */
export class HypersyncError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'HypersyncError';
  }
}

const LOG_FIELDS = ['block_number', 'log_index', 'transaction_hash', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3'] as const;

interface HypersyncLog {
  block_number?: number;
  log_index?: number;
  transaction_hash?: string;
  address?: string;
  data?: string;
  topic0?: string | null;
  topic1?: string | null;
  topic2?: string | null;
  topic3?: string | null;
}

interface HypersyncAnswer {
  data: Array<{ logs?: HypersyncLog[] }>;
  next_block: number;
  archive_height: number | null;
}

export interface HypersyncOptions {
  /** https://<chainId>.hypersync.xyz */
  url: string;
  /** The Envio API token, sent as a bearer token. */
  token: string;
  /** One HTTP request; default 30 s. */
  timeoutMs?: number;
  /** Requests of one read before it gives up; default 1,000. */
  maxPages?: number;
  fetch?: typeof fetch;
}

/**
 * POST /query, following next_block until the range is read. `fromBlock` and `toBlock` are inclusive here and
 * HyperSync's to_block is exclusive. Each page goes to `onPage`; `reachedTo` is the last block read, below toBlock
 * when HyperSync's archive ends first.
 */
async function query(
  o: HypersyncOptions,
  fromBlock: bigint,
  toBlock: bigint,
  topics: Hex[],
  fields: readonly string[],
  onPage: (logs: HypersyncLog[], nextBlock: bigint) => void,
): Promise<{ reachedTo: bigint }> {
  const doFetch = o.fetch ?? fetch;
  const maxPages = o.maxPages ?? 1_000;
  const end = toBlock + 1n;
  let cur = fromBlock;
  for (let page = 0; cur < end; page++) {
    if (page >= maxPages) throw new HypersyncError(`HyperSync did not finish blocks ${fromBlock} to ${toBlock} in ${maxPages} requests`);
    let res: Response;
    try {
      res = await doFetch(`${o.url.replace(/\/+$/, '')}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.token}` },
        body: JSON.stringify({ from_block: Number(cur), to_block: Number(end), logs: [{ topics: [topics] }], field_selection: { log: fields } }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch (err) {
      throw new HypersyncError(redact(`HyperSync request failed: ${(err as Error).message}`, o.token));
    }
    if (!res.ok) {
      const refused = res.status === 401 || res.status === 403;
      // A refusal's body may echo what was sent; it is not shown.
      const text = refused ? '' : (await res.text().catch(() => '')).slice(0, 200);
      const why = refused ? 'refused the API token' : res.status === 429 ? 'rate limited the request' : 'failed';
      throw new HypersyncError(redact(`HyperSync ${why} (HTTP ${res.status})${text ? `: ${text}` : ''}`, o.token), res.status);
    }
    const body = (await res.json().catch(() => null)) as HypersyncAnswer | null;
    if (!body || !Array.isArray(body.data) || typeof body.next_block !== 'number') throw new HypersyncError('HyperSync answered without data or next_block');
    const next = BigInt(body.next_block);
    // archive_height is the first block HyperSync does not have; nothing at or past it was read, whatever next_block says.
    const archive = typeof body.archive_height === 'number' ? BigInt(body.archive_height) : null;
    onPage(
      body.data.flatMap((d) => d.logs ?? []),
      next,
    );
    if (archive !== null && archive < end && next >= archive) return { reachedTo: (archive > cur ? archive : cur) - 1n };
    if (next <= cur) throw new HypersyncError(`HyperSync made no progress at block ${cur}`);
    cur = next;
  }
  return { reachedTo: toBlock };
}

/** The token taken out of a message; one too short to tell from ordinary words is left (an Envio token is a UUID). */
function redact(text: string, token: string): string {
  return token.length >= 8 ? text.split(token).join('[token]') : text;
}

function signalLogOf(l: HypersyncLog): SignalLog {
  if (typeof l.block_number !== 'number' || typeof l.log_index !== 'number' || !l.transaction_hash || !l.address || l.data === undefined || !l.topic0) {
    throw new HypersyncError('HyperSync returned a log without block_number, log_index, transaction_hash, address, data or topic0');
  }
  return {
    address: l.address as Address,
    topics: [l.topic0, l.topic1, l.topic2, l.topic3].filter((t): t is string => typeof t === 'string') as Hex[],
    data: l.data as Hex,
    blockNumber: BigInt(l.block_number),
    transactionHash: l.transaction_hash as Hex,
    logIndex: l.log_index,
  };
}

/**
 * The watcher's getLogs over HyperSync: the logs of [fromBlock, toBlock] whose topic0 is one of `topics`, from
 * any emitter, in block and log order, as eth_getLogs returns them. When HyperSync's archive ends below toBlock it
 * throws LogsNodeBehindError with the last block it has, as a lagging node does.
 */
export function hypersyncLogsReader(o: HypersyncOptions): (fromBlock: bigint, toBlock: bigint, topics: Hex[]) => Promise<SignalLog[]> {
  return async (fromBlock, toBlock, topics) => {
    const raw: HypersyncLog[] = [];
    const r = await query(o, fromBlock, toBlock, topics, LOG_FIELDS, (page) => raw.push(...page));
    if (r.reachedTo < toBlock) throw new LogsNodeBehindError(r.reachedTo);
    return raw.map(signalLogOf).sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  };
}

/**
 * The first block at which each address emitted a log with this topic0 in [fromBlock, toBlock], and how many such
 * logs it emitted, reading only the address and block number of each log and folding page by page (a Deposit
 * backfill over a whole chain is millions of logs). Lowercase addresses. `onPage` sees the progress.
 */
export async function hypersyncFirstEmitters(
  o: HypersyncOptions,
  fromBlock: bigint,
  toBlock: bigint,
  topic0: Hex,
  onPage?: (p: { logs: number; nextBlock: bigint; emitters: number }) => void,
): Promise<{ first: Map<string, bigint>; counts: Map<string, number>; logs: number; reachedTo: bigint }> {
  const first = new Map<string, bigint>();
  const counts = new Map<string, number>();
  let logs = 0;
  const r = await query({ ...o, maxPages: o.maxPages ?? 100_000 }, fromBlock, toBlock, [topic0], ['block_number', 'address'], (page, nextBlock) => {
    for (const l of page) {
      if (!l.address || typeof l.block_number !== 'number') continue;
      const a = l.address.toLowerCase();
      const b = BigInt(l.block_number);
      const seen = first.get(a);
      if (seen === undefined || b < seen) first.set(a, b);
      counts.set(a, (counts.get(a) ?? 0) + 1);
    }
    logs += page.length;
    onPage?.({ logs, nextBlock, emitters: first.size });
  });
  return { first, counts, logs, reachedTo: r.reachedTo };
}

export interface LogsWithFallbackOptions {
  /** After a read goes to the RPC, HyperSync is not asked for this long; it doubles while HyperSync keeps failing. Default 60 s. */
  cooldownMs?: number;
  /** The longest cooldown. Default 10 minutes. */
  maxCooldownMs?: number;
  /** A read went to the RPC, and why; `cooldownMs` is how long HyperSync is now left alone. */
  onFallback?: (err: unknown, fromBlock: bigint, toBlock: bigint, cooldownMs: number) => void;
  /** HyperSync served a read again after reads went to the RPC. */
  onRecover?: () => void;
  now?: () => number;
}

/**
 * HyperSync first, the subject RPC reader when HyperSync fails: a refused token, a rate limit, an outage, a
 * malformed answer, or an archive that ends below the range (a stuck indexer must not hold the watcher back,
 * and the RPC has every block). After a failure the reads go straight to the RPC for a cooldown, so a HyperSync
 * that hangs costs one timeout, not one per topic and window. The RPC's own errors (a range error, a node behind)
 * are the watcher's to handle, as without HyperSync.
 */
export function logsWithFallback(
  primary: (fromBlock: bigint, toBlock: bigint, topics: Hex[]) => Promise<SignalLog[]>,
  rpc: (fromBlock: bigint, toBlock: bigint, topics: Hex[]) => Promise<SignalLog[]>,
  o: LogsWithFallbackOptions = {},
): (fromBlock: bigint, toBlock: bigint, topics: Hex[]) => Promise<SignalLog[]> {
  const now = o.now ?? Date.now;
  const base = o.cooldownMs ?? 60_000;
  const max = o.maxCooldownMs ?? 10 * 60_000;
  let cooldown = 0;
  let skipUntil = 0;
  return async (fromBlock, toBlock, topics) => {
    if (now() < skipUntil) return rpc(fromBlock, toBlock, topics);
    try {
      const logs = await primary(fromBlock, toBlock, topics);
      if (cooldown > 0) {
        cooldown = 0;
        o.onRecover?.();
      }
      return logs;
    } catch (err) {
      cooldown = cooldown === 0 ? base : Math.min(max, cooldown * 2);
      skipUntil = now() + cooldown;
      o.onFallback?.(err, fromBlock, toBlock, cooldown);
      return rpc(fromBlock, toBlock, topics);
    }
  };
}
