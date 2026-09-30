import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { DESK_CHAIN_ID } from './config';

/*
 * The testnet burner: a private key made in the browser and kept in localStorage, for demos and for people
 * without a wallet extension. It is only ever used on Monad testnet; the key is readable by any script on this
 * origin, which is acceptable for faucet MON and for nothing else. Storage is injected so the tests need no DOM.
 */

export const BURNER_STORAGE_KEY = 'specfirst:burner:v1';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StoredBurner {
  version: 1;
  chainId: typeof DESK_CHAIN_ID;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  createdAt: string;
}

const PK_RE = /^0x[0-9a-fA-F]{64}$/;

/** The stored burner when it is well formed, for this chain, and its address matches its key; else null. */
export function readBurner(storage: KeyValueStorage | null): StoredBurner | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(BURNER_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredBurner>;
    if (v.version !== 1 || v.chainId !== DESK_CHAIN_ID || typeof v.privateKey !== 'string' || !PK_RE.test(v.privateKey)) return null;
    const address = privateKeyToAccount(v.privateKey as `0x${string}`).address;
    if (typeof v.address !== 'string' || v.address.toLowerCase() !== address.toLowerCase()) return null;
    return { version: 1, chainId: DESK_CHAIN_ID, address, privateKey: v.privateKey as `0x${string}`, createdAt: typeof v.createdAt === 'string' ? v.createdAt : '' };
  } catch {
    return null;
  }
}

/**
 * Returns the stored burner, or makes and stores a new one. Never replaces a valid key, so a second tab or a
 * double click cannot lose funds already sent to the first.
 */
export function ensureBurner(
  storage: KeyValueStorage,
  o: { generate?: () => `0x${string}`; now?: () => Date } = {},
): StoredBurner {
  const existing = readBurner(storage);
  if (existing) return existing;
  const privateKey = (o.generate ?? generatePrivateKey)();
  const burner: StoredBurner = {
    version: 1,
    chainId: DESK_CHAIN_ID,
    address: privateKeyToAccount(privateKey).address,
    privateKey,
    createdAt: (o.now ?? (() => new Date()))().toISOString(),
  };
  storage.setItem(BURNER_STORAGE_KEY, JSON.stringify(burner));
  const back = readBurner(storage);
  if (!back || back.privateKey !== privateKey) throw new Error('the browser did not keep the burner key (storage full or blocked)');
  return burner;
}

export function forgetBurner(storage: KeyValueStorage | null): void {
  try {
    storage?.removeItem(BURNER_STORAGE_KEY);
  } catch {
    // Blocked storage: nothing was stored either.
  }
}

/** window.localStorage when it exists and works; null in private modes that block it and on the server. */
export function browserStorage(): KeyValueStorage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const probe = '__specfirst_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
