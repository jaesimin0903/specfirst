import { createPublicClient, http, type Chain } from 'viem';

export const CHAIN_ID = 10143;
export const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz';
export const EXPLORER_BASE = 'https://testnet.monadvision.com';

export function getRpcUrl(): string {
  return process.env.NEXT_PUBLIC_MONAD_RPC ?? DEFAULT_RPC;
}

/** `null` when NEXT_PUBLIC_REGISTRY_10143 is unset or malformed; callers render "registry not configured". */
export function getRegistryAddress(): `0x${string}` | null {
  const v = process.env.NEXT_PUBLIC_REGISTRY_10143;
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  return v as `0x${string}`;
}

export const monadTestnet = {
  id: CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_RPC] } },
  blockExplorers: { default: { name: 'Monad Vision', url: EXPLORER_BASE } },
} as const satisfies Chain;

export function publicClient() {
  return createPublicClient({ chain: monadTestnet, transport: http(getRpcUrl()) });
}

export function explorerAddressUrl(address: string): string {
  return `${EXPLORER_BASE}/address/${address}`;
}

export function explorerTxUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}
