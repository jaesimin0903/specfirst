import { custom, http, type EIP1193RequestFn, type Transport } from 'viem';
import { isWriteForbidden } from './chains.js';

/** Simple token bucket: `rps` tokens per second, burst of `rps`. acquire() waits for a token. */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly rps: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!(rps > 0)) throw new Error(`rps must be positive, got ${rps}`);
    this.tokens = rps;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    this.tokens = Math.min(this.rps, this.tokens + ((t - this.last) / 1000) * this.rps);
    this.last = t;
  }

  /** Resolves once a token is taken. Calls are served in order. */
  acquire(): Promise<void> {
    const next = this.queue.then(async () => {
      this.refill();
      while (this.tokens < 1) {
        await this.sleep(Math.ceil(((1 - this.tokens) / this.rps) * 1000));
        this.refill();
      }
      this.tokens -= 1;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

export interface RpcTransportOptions {
  /** Requests per second across all URLs (plan 3.6: token bucket 10 rps). */
  rps?: number;
  /** Retries of one URL after HTTP 429 before moving on. Backoff doubles from baseDelayMs. */
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /**
   * Chain id every URL must report (eth_chainId) before it is sent a transaction. Checked once per URL,
   * right before its first eth_sendRawTransaction or eth_sendTransaction. Without it, sends are still
   * refused on a URL that reports a write-forbidden chain.
   */
  writeChainId?: number;
  /**
   * Also move on to the next URL after an error this returns true for (the watcher passes isNodeError, so an
   * archive read one node cannot serve goes to the next). Off by default: a JSON-RPC error is an answer.
   */
  failoverIf?: (err: unknown) => boolean;
  /** Called on every retry or failover, for logs and tests. */
  onRetry?: (info: { url: string; attempt: number; delayMs: number; reason: string }) => void;
  sleep?: (ms: number) => Promise<void>;
}

interface ErrorLike {
  status?: number;
  code?: number;
  message?: string;
  shortMessage?: string;
  details?: string;
  name?: string;
  cause?: unknown;
}

function chain(err: unknown): ErrorLike[] {
  const out: ErrorLike[] = [];
  const seen = new Set<unknown>();
  let cur = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur as ErrorLike);
    cur = (cur as ErrorLike).cause;
  }
  return out;
}

/** HTTP 429, JSON-RPC 429, or a "rate limit" / "too many requests" message anywhere in the cause chain. */
export function isRateLimited(err: unknown): boolean {
  return chain(err).some(
    (e) =>
      e.status === 429 ||
      e.code === 429 ||
      /\b429\b|rate.?limit|too many requests|request limit/i.test(`${e.message ?? ''} ${e.details ?? ''}`),
  );
}

/**
 * Transport-level failure that another RPC could serve: HTTP errors other than 429, timeouts, refused
 * connections. A JSON-RPC error response (a revert, a nonce error) is an answer, not a failure, and is
 * never retried on another URL.
 */
export function isTransportFailure(err: unknown): boolean {
  return chain(err).some(
    (e) =>
      e.name === 'HttpRequestError' ||
      e.name === 'TimeoutError' ||
      (typeof e.status === 'number' && e.status >= 500) ||
      /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|network/i.test(e.message ?? ''),
  ) && !chain(err).some((e) => e.name === 'RpcRequestError');
}

/**
 * A JSON-RPC answer that reports a failure of the node rather than of the request: -32603 "Internal error"
 * (rpc1.monad.xyz answers "Error getting block by number" for some archive blocks), "missing trie node",
 * "header not found". Another node may serve the same request.
 */
export function isNodeError(err: unknown): boolean {
  return chain(err).some(
    (e) => e.code === -32603 || /internal error|missing trie node|header not found|error getting block/i.test(`${e.message ?? ''} ${e.details ?? ''}`),
  );
}

/**
 * A JSON-RPC error answer in the server range: -32603 (internal error) or -32000 to -32099 (implementation
 * defined, such as "header not found" or "resource unavailable"). It says the node could not serve the call,
 * so the desk worker never counts it toward a reject; a revert reported with such a code ("execution
 * reverted") is excluded, since it is the contract's answer.
 */
export function isRpcServerError(err: unknown): boolean {
  return chain(err).some(
    (e) => typeof e.code === 'number' && (e.code === -32603 || (e.code <= -32000 && e.code >= -32099)) && !/revert/i.test(`${e.message ?? ''} ${e.details ?? ''}`),
  );
}

const CONTRACT_ANSWER_ERRORS = new Set([
  'ContractFunctionRevertedError',
  'ContractFunctionZeroDataError',
  'AbiDecodingZeroDataError',
  'AbiDecodingDataSizeTooSmallError',
  'InvalidAddressError',
]);

/**
 * True when a read failed because of what the contract returned (a revert, no data, data that does not
 * decode), not because of the RPC or the node. viem 2 files a JSON-RPC -32603 under
 * ContractFunctionRevertedError whatever its message, so rpc1's "Error getting block by number" arrives
 * looking like a revert: an error whose chain holds a transport failure, a rate limit or a node error is
 * never the contract's answer, unless viem recognized the node's message as a revert (ExecutionRevertedError,
 * as for "execution reverted" sent with -32603).
 */
export function isContractAnswer(err: unknown): boolean {
  if (isTransportFailure(err) || isRateLimited(err)) return false;
  if (isNodeError(err) && !chain(err).some((e) => e.name === 'ExecutionRevertedError')) return false;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const name = (cur as { name?: unknown }).name;
    if (typeof name === 'string' && CONTRACT_ANSWER_ERRORS.has(name)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

const SEND_METHODS = new Set(['eth_sendRawTransaction', 'eth_sendTransaction']);

/** A transaction was about to reach an RPC on the wrong or a write-forbidden chain. Never retried. */
export class WriteTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WriteTargetError';
  }
}

/**
 * viem transport over a list of RPC URLs: one shared token bucket, exponential backoff on 429 per URL,
 * failover to the next URL on transport failures or exhausted retries (plan 3.6 item 4).
 */
export function rpcTransport(urls: readonly string[], opts: RpcTransportOptions = {}): Transport {
  if (urls.length === 0) throw new Error('rpcTransport needs at least one RPC URL');
  const bucket = new TokenBucket(opts.rps ?? 10);
  const maxRetries = opts.maxRetries ?? 5;
  const base = opts.baseDelayMs ?? 250;
  const maxDelay = opts.maxDelayMs ?? 8_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const inner = urls.map((url) => ({
    url,
    request: http(url, { retryCount: 0, timeout: opts.timeoutMs ?? 30_000 })({ retryCount: 0 }).request as EIP1193RequestFn,
  }));

  const verified = new Set<string>();
  /** Refuses to send a transaction to a URL that serves another chain than the wallet's, or mainnet. */
  const verifyWriteTarget = async (url: string, send: EIP1193RequestFn): Promise<void> => {
    if (verified.has(url)) return;
    await bucket.acquire();
    const reported = Number(await send({ method: 'eth_chainId' } as Parameters<EIP1193RequestFn>[0]));
    if (opts.writeChainId !== undefined && reported !== opts.writeChainId) {
      throw new WriteTargetError(`refusing to send a transaction: the RPC reports chain ${reported}, the wallet is for chain ${opts.writeChainId}`);
    }
    if (isWriteForbidden(reported)) throw new WriteTargetError(`refusing to send a transaction: the RPC reports chain ${reported}, which specfirst only reads`);
    verified.add(url);
  };

  const request = async (args: { method: string; params?: unknown }): Promise<unknown> => {
    let lastErr: unknown;
    const isSend = SEND_METHODS.has(args.method);
    for (const { url, request: send } of inner) {
      if (isSend) {
        try {
          await verifyWriteTarget(url, send);
        } catch (err) {
          if (err instanceof WriteTargetError) throw err;
          lastErr = err;
          // An unreachable or rate-limited URL is skipped like any other failover.
          if (isRateLimited(err) || isTransportFailure(err)) continue;
          throw err;
        }
      }
      for (let attempt = 0; ; attempt++) {
        await bucket.acquire();
        try {
          return await send(args as Parameters<EIP1193RequestFn>[0]);
        } catch (err) {
          lastErr = err;
          if (isRateLimited(err) && attempt < maxRetries) {
            const delayMs = Math.min(maxDelay, base * 2 ** attempt);
            opts.onRetry?.({ url, attempt: attempt + 1, delayMs, reason: '429' });
            await sleep(delayMs);
            continue;
          }
          if (isRateLimited(err) || isTransportFailure(err) || opts.failoverIf?.(err)) {
            opts.onRetry?.({ url, attempt: attempt + 1, delayMs: 0, reason: 'failover' });
            break;
          }
          throw err;
        }
      }
    }
    throw lastErr;
  };

  return custom({ request }, { retryCount: 0 });
}
