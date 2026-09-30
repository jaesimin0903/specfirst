import {
  ANVIL_CHAIN_ID,
  ANVIL_DEFAULT_RPC,
  chainFor,
  createChainClients,
  isWriteForbidden,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_MAINNET_DEFAULT_RPC,
  MONAD_TESTNET_CHAIN_ID,
  MONAD_TESTNET_DEFAULT_RPC,
  type ChainClients,
} from '@specfirst/core';
import type { Address, Hex } from 'viem';

/** anvil account 0. Used only on --network anvil when DEPLOYER_PRIVATE_KEY / ISSUER_PRIVATE_KEY are unset. */
export const ANVIL_DEFAULT_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

export const DEPLOYER_KEY_ENV = 'DEPLOYER_PRIVATE_KEY';
export const ISSUER_KEY_ENV = 'ISSUER_PRIVATE_KEY';
/** Pays the fee of `specfirst desk request`. Never falls back to an anvil key. */
export const REQUESTER_KEY_ENV = 'REQUESTER_PRIVATE_KEY';
export const MONAD_RPC_ENV = 'MONAD_TESTNET_RPC';
export const MONAD_RPC_FALLBACKS_ENV = 'MONAD_TESTNET_RPC_FALLBACKS';
export const MONAD_MAINNET_RPC_ENV = 'MONAD_MAINNET_RPC';
export const ANVIL_RPC_ENV = 'ANVIL_RPC';

export function registryEnvVar(chainId: number): string {
  return `SPECFIRST_REGISTRY_${chainId}`;
}

/** CheckAttestationRegistry address for the chain the registry lives on. */
export function attestRegistryEnvVar(chainId: number): string {
  return `SPECFIRST_ATTEST_REGISTRY_${chainId}`;
}

/** CheckRequestDesk address for the chain the desk lives on. */
export function deskEnvVar(chainId: number): string {
  return `SPECFIRST_DESK_${chainId}`;
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

export interface ResolveMode {
  /** Only commands that never send a transaction (check, cert attestation) pass true; it unlocks monad-mainnet. */
  readOnly?: boolean;
}

/**
 * --network anvil|monad-testnet|monad-mainnet with RPC from --rpc, then env, then the public default;
 * fallbacks after it. monad-mainnet is refused unless the caller is read-only: deploy, rehearse (inside
 * verify and run), cert issue and cert revoke send transactions and must never reach mainnet.
 */
export function resolveNetwork(opts: NetworkOptions, env: NodeJS.ProcessEnv = process.env, mode: ResolveMode = {}): ResolvedNetwork {
  const name = opts.network ?? 'monad-testnet';
  const chain = chainFor(name);
  if (isWriteForbidden(chain.id) && !mode.readOnly) {
    throw new ConfigError(`--network ${name} is read-only: this command sends transactions; only read-only commands (check, cert attestation) may use ${name}`);
  }
  let urls: string[];
  if (chain.id === ANVIL_CHAIN_ID) {
    urls = [opts.rpc ?? env[ANVIL_RPC_ENV] ?? ANVIL_DEFAULT_RPC];
  } else if (chain.id === MONAD_MAINNET_CHAIN_ID) {
    urls = [opts.rpc ?? env[MONAD_MAINNET_RPC_ENV] ?? MONAD_MAINNET_DEFAULT_RPC];
  } else {
    urls = [opts.rpc ?? env[MONAD_RPC_ENV] ?? MONAD_TESTNET_DEFAULT_RPC, ...list(env[MONAD_RPC_FALLBACKS_ENV])];
  }
  urls = [...new Set(urls)];
  return { name, clients: createChainClients({ chain, rpcUrls: urls }), forkUrl: urls[0]!, notices: [] };
}

function isKey(v: string | undefined): v is Hex {
  return !!v && /^0x[0-9a-fA-F]{64}$/.test(v);
}

/** Private key from env when set (validated), else undefined. No anvil fallback. */
export function optionalKey(envName: string, env: NodeJS.ProcessEnv = process.env): Hex | undefined {
  const v = env[envName];
  if (!v) return undefined;
  if (!isKey(v)) throw new ConfigError(`${envName} is not a 0x-prefixed 32-byte hex private key`);
  return v;
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

export function resolveAttestRegistry(net: ResolvedNetwork, opts: { registryAttest?: string }, env: NodeJS.ProcessEnv = process.env): Address {
  const envName = attestRegistryEnvVar(net.clients.chain.id);
  const v = opts.registryAttest ?? env[envName];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ConfigError(`no CheckAttestationRegistry address: set ${envName} or pass --registry-attest <address>`);
  }
  return v as Address;
}

export function resolveDesk(net: ResolvedNetwork, opts: { desk?: string }, env: NodeJS.ProcessEnv = process.env): Address {
  const envName = deskEnvVar(net.clients.chain.id);
  const v = opts.desk ?? env[envName];
  if (!v || !/^0x[0-9a-fA-F]{40}$/.test(v)) {
    throw new ConfigError(`no CheckRequestDesk address: set ${envName} or pass --desk <address>`);
  }
  return v as Address;
}

/**
 * Read-only RPC for the chain a check report is about: --subject-rpc, else the usual env variable and
 * public default of that chain. The subject chain is never written to, so monad-mainnet is fine here.
 */
export function subjectRpcFor(chainId: number, subjectRpc: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  if (subjectRpc) return subjectRpc;
  if (chainId === MONAD_MAINNET_CHAIN_ID) return env[MONAD_MAINNET_RPC_ENV] ?? MONAD_MAINNET_DEFAULT_RPC;
  if (chainId === MONAD_TESTNET_CHAIN_ID) return env[MONAD_RPC_ENV] ?? MONAD_TESTNET_DEFAULT_RPC;
  if (chainId === ANVIL_CHAIN_ID) return env[ANVIL_RPC_ENV] ?? ANVIL_DEFAULT_RPC;
  throw new ConfigError(`no default RPC for chain ${chainId}; pass --subject-rpc <url>`);
}
