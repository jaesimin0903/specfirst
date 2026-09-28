import type { Chain } from 'viem';

export const MONAD_TESTNET_CHAIN_ID = 10143;
export const ANVIL_CHAIN_ID = 31337;
export const MONAD_TESTNET_DEFAULT_RPC = 'https://testnet-rpc.monad.xyz';
export const ANVIL_DEFAULT_RPC = 'http://127.0.0.1:8545';

export const monadTestnet = {
  id: MONAD_TESTNET_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [MONAD_TESTNET_DEFAULT_RPC] } },
  blockExplorers: { default: { name: 'MonadVision', url: 'https://testnet.monadvision.com' } },
  testnet: true,
} as const satisfies Chain;

export const anvilChain = {
  id: ANVIL_CHAIN_ID,
  name: 'Anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_DEFAULT_RPC] } },
  testnet: true,
} as const satisfies Chain;

export type NetworkName = 'anvil' | 'monad-testnet';

export const NETWORKS: Record<NetworkName, Chain> = {
  anvil: anvilChain,
  'monad-testnet': monadTestnet,
};

export function chainFor(network: string): Chain {
  const chain = NETWORKS[network as NetworkName];
  if (!chain) throw new Error(`unknown network "${network}" (expected ${Object.keys(NETWORKS).join(' or ')})`);
  return chain;
}

/**
 * Per-network client defaults. Monad RPCs allow about 20 to 50 rps and cap eth_getLogs at 100 blocks
 * (plan 0.2, spike); anvil has no limits but the same code paths run against it in tests.
 */
export interface NetworkDefaults {
  rps: number;
  logChunk: number;
  pollingIntervalMs: number;
}

export function networkDefaults(chainId: number): NetworkDefaults {
  if (chainId === ANVIL_CHAIN_ID) return { rps: 10, logChunk: 100, pollingIntervalMs: 100 };
  return { rps: 10, logChunk: 100, pollingIntervalMs: 500 };
}
