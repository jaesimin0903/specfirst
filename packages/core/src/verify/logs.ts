import type { AbiEvent, Address, Log } from 'viem';
import type { SpecfirstPublicClient } from '../chain/client.js';

/** Monad RPCs cap eth_getLogs at 100 blocks (plan 0.2, ADR 0001). */
export const DEFAULT_LOG_CHUNK = 100n;

export interface ChunkedLogsInput<E extends AbiEvent> {
  client: Pick<SpecfirstPublicClient, 'getLogs'>;
  address: Address;
  event: E;
  fromBlock: bigint;
  toBlock: bigint;
  chunkSize?: bigint;
  /** Called with each [from, to] range before it is fetched. */
  onChunk?: (from: bigint, to: bigint) => void;
}

/** Inclusive [from, to] ranges of at most `size` blocks covering fromBlock..toBlock with no gap or overlap. */
export function chunkRanges(fromBlock: bigint, toBlock: bigint, size: bigint): Array<[bigint, bigint]> {
  if (size <= 0n) throw new Error(`chunk size must be positive, got ${size}`);
  const out: Array<[bigint, bigint]> = [];
  for (let from = fromBlock; from <= toBlock; from += size) {
    const to = from + size - 1n < toBlock ? from + size - 1n : toBlock;
    out.push([from, to]);
  }
  return out;
}

/** eth_getLogs in `chunkSize`-block windows, in block order. */
export async function getLogsChunked<E extends AbiEvent>(input: ChunkedLogsInput<E>): Promise<Log[]> {
  const logs: Log[] = [];
  for (const [from, to] of chunkRanges(input.fromBlock, input.toBlock, input.chunkSize ?? DEFAULT_LOG_CHUNK)) {
    input.onChunk?.(from, to);
    const part = await input.client.getLogs({ address: input.address, event: input.event, fromBlock: from, toBlock: to });
    logs.push(...(part as Log[]));
  }
  return logs;
}
