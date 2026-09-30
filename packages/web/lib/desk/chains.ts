import { defineChain } from 'viem';
import { DEFAULT_MAINNET_RPC, DEFAULT_TESTNET_RPC, TESTNET_EXPLORER } from './config';

/*
 * Monad mainnet and testnet for the desk, with Multicall3 so view calls made together travel as one eth_call.
 * Defined here rather than imported from "viem/chains", whose index pulls every chain (and warnings) into the build.
 */

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export function monadTestnetChain(rpc: string = DEFAULT_TESTNET_RPC) {
  return defineChain({
    id: 10143,
    name: 'Monad Testnet',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'Monadscan', url: TESTNET_EXPLORER } },
    contracts: { multicall3: { address: MULTICALL3, blockCreated: 251449 } },
    testnet: true,
  });
}

export function monadMainnetChain(rpc: string = DEFAULT_MAINNET_RPC) {
  return defineChain({
    id: 143,
    name: 'Monad',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: 'Monadscan', url: 'https://monadscan.com' } },
    contracts: { multicall3: { address: MULTICALL3, blockCreated: 9248132 } },
  });
}
