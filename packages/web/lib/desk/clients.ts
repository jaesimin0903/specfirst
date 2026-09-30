import { createPublicClient, http, type PublicClient } from 'viem';
import { monadMainnetChain, monadTestnetChain } from './chains';
import { mainnetRpc, testnetRpc } from './config';

/*
 * Server-side viem clients. Multicall batches the desk's many view calls into one eth_call; the retry settings
 * ride out the testnet RPC's 15 requests per second limit instead of failing a page.
 */

let testnet: PublicClient | null = null;
let mainnet: PublicClient | null = null;

export function testnetClient(): PublicClient {
  testnet ??= createPublicClient({
    chain: monadTestnetChain(testnetRpc()),
    transport: http(testnetRpc(), { timeout: 10_000, retryCount: 3, retryDelay: 700 }),
    batch: { multicall: { batchSize: 16_384 } },
  }) as PublicClient;
  return testnet;
}

export function mainnetClient(): PublicClient {
  mainnet ??= createPublicClient({
    chain: monadMainnetChain(mainnetRpc()),
    transport: http(mainnetRpc(), { timeout: 10_000, retryCount: 2, retryDelay: 500 }),
    batch: { multicall: { batchSize: 16_384 } },
  }) as PublicClient;
  return mainnet;
}
