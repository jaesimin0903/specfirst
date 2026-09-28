import { decodeAbiParameters, encodeAbiParameters, type Address, type Hex } from 'viem';
import type { SpecfirstPublicClient } from '../chain/client.js';

export interface ProbeResult {
  inv1: boolean;
  inv2: boolean;
  inv6: boolean;
  block: bigint;
}

/**
 * Fallback path (plan 3.6 item 6, ADR 0001): run SpecfirstProbe's creation code with a `to`-less
 * eth_call at the latest block. The constructor evaluates SpecfirstProps inv1, inv2, inv6 against the
 * live vault and returns abi.encode(bool, bool, bool).
 */
export async function runProbe(
  client: SpecfirstPublicClient,
  probeBytecode: Hex,
  vault: Address,
  depositors: readonly Address[],
): Promise<ProbeResult> {
  const block = await client.getBlockNumber();
  const args = encodeAbiParameters([{ type: 'address' }, { type: 'address[]' }], [vault, [...depositors]]);
  const data = `${probeBytecode}${args.slice(2)}` as Hex;
  const res = (await client.request({ method: 'eth_call', params: [{ data }, `0x${block.toString(16)}`] })) as Hex;
  const [inv1, inv2, inv6] = decodeAbiParameters([{ type: 'bool' }, { type: 'bool' }, { type: 'bool' }], res);
  return { inv1, inv2, inv6, block };
}
