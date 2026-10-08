import { getAddress, isAddress, type Address } from 'viem';

/*
 * Where the server reads from. Everything comes from the environment the MCP host passes; nothing here is a key, and
 * the server never reads one (test/no-keys.test.ts).
 */

/** Monad mainnet: the chain whose vaults the board and the watcher cover. */
export const SUBJECT_CHAIN_ID = 143;
/** Monad testnet: where CheckAttestationRegistry and CheckSubscriptions live. */
export const ATTEST_CHAIN_ID = 10143;
export const DEFAULT_API_BASE = 'http://localhost:3417';
export const DEFAULT_TESTNET_RPC = 'https://testnet-rpc.monad.xyz';
/** CheckAttestationRegistry on Monad testnet (ADR 0004). */
export const DEFAULT_REGISTRY = '0x3754918bBB8481D046D80718a9efe434e353daF7';
/** CheckSubscriptions on Monad testnet (ADR 0006). */
export const DEFAULT_SUBSCRIPTIONS = '0xA1A205C1eF2Ecd2354DE900276C74Fb34b7119a4';
export const TESTNET_EXPLORER = 'https://testnet.monadscan.com';
/** Twice the watcher's 24 hour sweep: a report older than this is stale. */
export const DEFAULT_STALE_HOURS = 48;
/** Per request. The chain read gets twice this in all, so an answer comes well inside a host's 60 s tool timeout. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface McpConfig {
  /** The Specfirst web, without a trailing slash. */
  apiBase: string;
  /** RPC of Monad testnet, for the registry and subscription reads. */
  rpcUrl: string;
  registry: Address;
  subscriptions: Address;
  staleHours: number;
  timeoutMs: number;
}

export class ConfigError extends Error {}

function addressOr(value: string | undefined, fallback: string, name: string): Address {
  const v = value?.trim();
  if (!v) return getAddress(fallback);
  if (!isAddress(v, { strict: false })) throw new ConfigError(`${name} is not an address: ${v}`);
  return getAddress(v);
}

function positive(value: string | undefined, fallback: number, name: string): number {
  const v = value?.trim();
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got ${v}`);
  return n;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * An https URL, or plain http to this machine (the local web, anvil). For the API an origin, no credentials, query or fragment:
 * what is configured is a place, and the links the API returns are resolved on it. An RPC (`asGiven`) may carry a
 * provider's key in its credentials or query; it is used as given and only its origin is ever shown.
 */
function httpUrl(value: string | undefined, fallback: string, name: string, asGiven = false): string {
  const v = value?.trim() || fallback;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new ConfigError(`${name} is not a URL: ${v}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError(`${name} must be http or https, got ${u.protocol}`);
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) throw new ConfigError(`${name} must be https unless it is on this machine, got ${u.origin}`);
  if (asGiven) return v;
  if (u.username || u.password) throw new ConfigError(`${name} must not carry credentials`);
  if (u.hash || u.search) throw new ConfigError(`${name} must not carry a ${u.hash ? 'fragment' : 'query'}`);
  // The web builds its links from its origin, so the API is an origin too: a path would be doubled in every link.
  if (u.pathname !== '/') throw new ConfigError(`${name} must be an origin such as https://specfirst.example, without a path`);
  return u.origin;
}

/**
 * SPECFIRST_API_BASE (default http://localhost:3417), MONAD_TESTNET_RPC (default https://testnet-rpc.monad.xyz),
 * SPECFIRST_ATTEST_REGISTRY_10143 and SPECFIRST_SUBS_10143 (default the deployed contracts), SPECFIRST_MCP_STALE_HOURS
 * (48) and SPECFIRST_MCP_TIMEOUT_MS (10000).
 */
export function configFromEnv(env: Record<string, string | undefined> = process.env): McpConfig {
  return {
    apiBase: httpUrl(env.SPECFIRST_API_BASE, DEFAULT_API_BASE, 'SPECFIRST_API_BASE'),
    rpcUrl: httpUrl(env.MONAD_TESTNET_RPC, DEFAULT_TESTNET_RPC, 'MONAD_TESTNET_RPC', true),
    registry: addressOr(env.SPECFIRST_ATTEST_REGISTRY_10143, DEFAULT_REGISTRY, 'SPECFIRST_ATTEST_REGISTRY_10143'),
    subscriptions: addressOr(env.SPECFIRST_SUBS_10143, DEFAULT_SUBSCRIPTIONS, 'SPECFIRST_SUBS_10143'),
    staleHours: positive(env.SPECFIRST_MCP_STALE_HOURS, DEFAULT_STALE_HOURS, 'SPECFIRST_MCP_STALE_HOURS'),
    timeoutMs: positive(env.SPECFIRST_MCP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'SPECFIRST_MCP_TIMEOUT_MS'),
  };
}

/** The origin of a URL only, so an RPC key in its path or query never reaches a tool result. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '<rpc>';
  }
}
