import type { Hex } from 'viem';
import type { SignalLog } from './sources.js';

/** Largest getLogs window to start from (rpc1.monad.xyz takes 10,000 blocks); range errors shrink it. */
export const DEFAULT_LOG_WINDOW = 10_000n;
/** Windows in a row without a range error before the window doubles again, up to the configured maximum. */
export const DEFAULT_WINDOW_GROW_AFTER = 20;

/**
 * JSON-RPC codes of a getLogs range above the node's limit: -32614 "eth_getLogs is limited to a 100 range"
 * (rpc.monad.xyz and the testnet RPC, with HTTP 413), -32062 "Block range is too large" (rpc3.monad.xyz).
 */
const RANGE_CODES = new Set([-32614, -32062]);
const RANGE_TEXT =
  /limited to an? \d+ (block )?range|range (is )?too (large|wide|big)|exceeds? (the )?(max(imum)? )?(block )?range|(block )?range limit|too many blocks|query returned more than|too many results|response size (is )?(too large|exceeded)/i;

interface ErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  cause?: unknown;
}

function errorChain(err: unknown): ErrorLike[] {
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

function textOf(e: ErrorLike): string {
  return [e.message, e.shortMessage, e.details].filter((x) => typeof x === 'string').join(' ');
}

/**
 * True when a getLogs failed because the block range (or the result) is too large for the node: one of the
 * RANGE_CODES, or a message that says so (-32602 "block range too large" on rpc-mainnet.monadinfra.com, HTTP
 * 413 bodies, the usual "query returned more than 10000 results").
 */
export function isRangeError(err: unknown): boolean {
  return errorChain(err).some((e) => (typeof e.code === 'number' && RANGE_CODES.has(e.code)) || RANGE_TEXT.test(textOf(e)) || /"code":\s*-32(614|062)\b/.test(textOf(e)));
}

/** The block limit a range error names ("limited to a 100 range"), or null. */
export function rangeLimitOf(err: unknown): bigint | null {
  for (const e of errorChain(err)) {
    const m = /limited to an? (\d+) (?:block )?range/i.exec(textOf(e)) ?? /max(?:imum)? (?:block )?range (?:is |of )?(\d+)/i.exec(textOf(e));
    if (m) return BigInt(m[1]!);
  }
  return null;
}

/**
 * Size of the next getLogs window, in blocks. Starts at `max`; a range error sets it to the limit the error
 * names (a window of n blocks spans n - 1, inside a limit of n) or else a tenth, never below one block;
 * `growAfter` windows in a row without one double it again up to `max`, so a fallback RPC with a small limit
 * does not keep the window small once the primary is back.
 */
export class LogWindow {
  size: bigint;
  private streak = 0;

  constructor(
    readonly max: bigint,
    private readonly growAfter: number = DEFAULT_WINDOW_GROW_AFTER,
  ) {
    if (max < 1n) throw new Error(`the log window must be at least 1 block, got ${max}`);
    this.size = max;
  }

  succeeded(): void {
    this.streak++;
    if (this.streak >= this.growAfter && this.size < this.max) {
      this.size = this.size * 2n > this.max ? this.max : this.size * 2n;
      this.streak = 0;
    }
  }

  /** Shrinks after a range error of a window of `tried` blocks. False when the window is one block already. */
  shrink(err: unknown, tried: bigint = this.size): boolean {
    this.streak = 0;
    if (tried <= 1n) return false;
    const limit = rangeLimitOf(err);
    const next = limit !== null && limit >= 1n && limit < tried ? limit : tried / 10n;
    this.size = next < 1n ? 1n : next;
    return true;
  }
}

/**
 * The node that answered getLogs is behind the requested range: its own head is `head`. The reader caps the
 * window at that head instead of taking a missing range for an empty one.
 */
export class LogsNodeBehindError extends Error {
  constructor(readonly head: bigint) {
    super(`the getLogs node is at block ${head}, behind the requested range`);
    this.name = 'LogsNodeBehindError';
  }
}

export interface ReadLogWindowsInput {
  /** eth_getLogs over [fromBlock, toBlock] for these topic0 values; may throw LogsNodeBehindError. */
  getLogs(fromBlock: bigint, toBlock: bigint, topics: Hex[]): Promise<SignalLog[]>;
  /** Asked one at a time, so a flood of one event cannot crowd another out of a node's result limit. */
  topics: Hex[];
  /** First block to read. */
  from: bigint;
  /** Last block to read (inclusive). */
  to: bigint;
  window: LogWindow;
  /** Stop after this many windows (the rest is read on a later call). */
  maxWindows?: number;
  /** Called with each window's logs before the next window is read; the caller handles them and moves its cursor. */
  onWindow(w: { fromBlock: bigint; toBlock: bigint; logs: SignalLog[] }): Promise<void>;
  onShrink?(info: { fromBlock: bigint; toBlock: bigint; size: bigint; error: unknown }): void;
  /**
   * A block whose logs of `topic` the node refuses even in a one-block window. Without this callback the
   * error is thrown; with it the block is skipped for that topic and reading goes on.
   */
  onUnreadable?(info: { block: bigint; topic: Hex; error: unknown }): Promise<void>;
}

/**
 * Reads [from, to] in windows of `window.size` blocks, one getLogs per topic, shrinking the window on range
 * errors and retrying the same start. A one-block window that still fails goes to onUnreadable and is passed
 * over. A node behind the window (LogsNodeBehindError) caps the range at its head, and reading stops there.
 * Returns the first block not read. Any other error is thrown after the windows read so far were handed to
 * onWindow, so the caller's cursor is where reading stopped.
 */
export async function readLogWindows(i: ReadLogWindowsInput): Promise<bigint> {
  let next = i.from;
  let to = i.to;
  let windows = 0;
  while (next <= to && (i.maxWindows === undefined || windows < i.maxWindows)) {
    const toBlock = next + i.window.size - 1n > to ? to : next + i.window.size - 1n;
    const logs: SignalLog[] = [];
    let retry = false;
    for (const topic of i.topics) {
      try {
        logs.push(...(await i.getLogs(next, toBlock, [topic])));
      } catch (err) {
        if (err instanceof LogsNodeBehindError || (err as { name?: unknown })?.name === 'LogsNodeBehindError') {
          const head = (err as LogsNodeBehindError).head;
          if (head < next) return next;
          to = head < to ? head : to;
          retry = true;
          break;
        }
        if (isRangeError(err) && i.window.shrink(err, toBlock - next + 1n)) {
          i.onShrink?.({ fromBlock: next, toBlock, size: i.window.size, error: err });
          retry = true;
          break;
        }
        if (isRangeError(err) && toBlock === next && i.onUnreadable) {
          await i.onUnreadable({ block: next, topic, error: err });
          continue;
        }
        throw err;
      }
    }
    if (retry) continue;
    i.window.succeeded();
    await i.onWindow({ fromBlock: next, toBlock, logs });
    next = toBlock + 1n;
    windows++;
  }
  return next;
}
