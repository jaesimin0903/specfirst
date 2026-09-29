import {
  createPublicClient,
  createWalletClient,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { isWriteForbidden, networkDefaults } from './chains.js';
import { rpcTransport, type RpcTransportOptions } from './transport.js';

export type SpecfirstPublicClient = PublicClient<Transport, Chain>;
export type SpecfirstWalletClient = WalletClient<Transport, Chain, Account>;

export interface ClientFactoryInput extends RpcTransportOptions {
  chain: Chain;
  /** Primary RPC first, then fallbacks. */
  rpcUrls: readonly string[];
  pollingIntervalMs?: number;
}

export interface ChainClients {
  chain: Chain;
  rpcUrls: readonly string[];
  transport: Transport;
  publicClient: SpecfirstPublicClient;
  /** Wallet client for one private key, sharing the rate-limited transport. Throws on write-forbidden chains. */
  wallet(privateKey: Hex): SpecfirstWalletClient;
}

/** Public and wallet clients over one rate-limited, failover transport. */
export function createChainClients(input: ClientFactoryInput): ChainClients {
  const { chain, rpcUrls } = input;
  const defaults = networkDefaults(chain.id);
  const transport = rpcTransport(rpcUrls, { rps: defaults.rps, ...input });
  const pollingInterval = input.pollingIntervalMs ?? defaults.pollingIntervalMs;
  const publicClient = createPublicClient({ chain, transport, pollingInterval }) as SpecfirstPublicClient;
  return {
    chain,
    rpcUrls,
    transport,
    publicClient,
    wallet: (privateKey) => {
      // Last line of defence behind the CLI's network check: no signer ever exists for mainnet.
      if (isWriteForbidden(chain.id)) {
        throw new Error(`refusing to create a wallet client for ${chain.name} (chain ${chain.id}): specfirst only reads from this chain`);
      }
      return createWalletClient({ account: privateKeyToAccount(privateKey), chain, transport, pollingInterval }) as SpecfirstWalletClient;
    },
  };
}
