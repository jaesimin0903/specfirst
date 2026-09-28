import {
  ANVIL_CHAIN_ID,
  ANVIL_DEFAULT_RPC,
  chainFor,
  createChainClients,
  MONAD_TESTNET_DEFAULT_RPC,
  type ChainClients,
} from '@specfirst/core';
import type { Address, Hex } from 'viem';

/** anvil account 0. Used only on --network anvil when DEPLOYER_PRIVATE_KEY / ISSUER_PRIVATE_KEY are unset. */
export const ANVIL_DEFAULT_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const DEPLOYER_KEY_ENV = 'DEPLOYER_PRIVATE_KEY';
export const ISSUER_KEY_ENV = 'ISSUER_PRIVATE_KEY';
export const MONAD_RPC_ENV = 'MONAD_TESTNET_RPC';
export const MONAD_RPC_FALLBACKS_ENV = 'MONAD_TESTNET_RPC_FALLBACKS';
export const ANVIL_RPC_ENV = 'ANVIL_RPC';

export function registryEnvVar(chainId: number): string {
  return `SPECFIRST_REGISTRY_${chainId}`;
}

export interface NetworkOptions {
  network?: string;
  rpc?: string;
  registry?: string;
}

export interface ResolvedNetwork {
  name: string;
  clients: ChainClients;
  /** RPC forge forks from (the primary URL). */
  forkUrl: string;
  notices: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** --network anvil|monad-testnet with RPC from --rpc, then env, then the public default; fallbacks after it. */
export function resolveNetwork(opts: NetworkOptions, env: NodeJS.ProcessEnv = process.env): ResolvedNetwork {
  const name = opts.network ?? 'monad-testnet';
  const chain = chainFor(name);
  let urls: string[];
  if (chain.id === ANVIL_CHAIN_ID) {
    urls = [opts.rpc ?? env[ANVIL_RPC_ENV] ?? ANVIL_DEFAULT_RPC];
  } else {
    urls = [opts.rpc ?? env[MONAD_RPC_ENV] ?? MONAD_TESTNET_DEFAULT_RPC, ...list(env[MONAD_RPC_FALLBACKS_ENV])];
  }
  urls = [...new Set(urls)];
  return { name, clients: createChainClients({ chain, rpcUrls: urls }), forkUrl: urls[0]!, notices: [] };
}

function isKey(v: string | undefined): v is Hex {
  return !!v && /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** Private key from env. On anvil an unset key falls back to anvil account 0 with a notice. */
export function resolveKey(net: ResolvedNetwork, envName: string, env: NodeJS.ProcessEnv = process.env): Hex {
  const v = env[envName];
  if (isKey(v)) return v;
  if (v) throw new ConfigError(`${envName} is not a 0x-prefixed 32-byte hex private key`);
  if (net.clients.chain.id === ANVIL_CHAIN_ID) {
    net.notices.push(`${envName} unset, using anvil account 0`);
    return ANVIL_DEFAULT_KEY;
  }
  throw new ConfigError(`${envName} is not set (a fresh testnet-only key; never commit it)`);
}

export function resolveRegistry(net: ResolvedNetwork, opts: NetworkOptions, env: NodeJS.ProcessEnv = process.env): Address {
  const envName = registryEnvVar(net.clients.chain.id);
  const v = opts.registry ?? env[envName];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ConfigError(`no CertificateRegistry address: set ${envName} or pass --registry <address>`);
  }
  return v as Address;
}
