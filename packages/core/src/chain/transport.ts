import { custom, http, type EIP1193RequestFn, type Transport } from 'viem';

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

  const request = async (args: { method: string; params?: unknown }): Promise<unknown> => {
    let lastErr: unknown;
    for (const { url, request: send } of inner) {
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
          if (isRateLimited(err) || isTransportFailure(err)) {
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
