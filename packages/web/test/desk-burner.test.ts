import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { BURNER_STORAGE_KEY, ensureBurner, forgetBurner, readBurner, type KeyValueStorage } from '../lib/desk/burner';

function memoryStorage(): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const KEY_A = `0x${'11'.repeat(32)}` as const;
const KEY_B = `0x${'22'.repeat(32)}` as const;

describe('testnet burner storage', () => {
  it('creates a key once, stores it for Monad testnet, and returns the same key after that', () => {
    const s = memoryStorage();
    const now = () => new Date('2026-10-01T00:00:00Z');
    const first = ensureBurner(s, { generate: () => KEY_A, now });
    expect(first).toEqual({ version: 1, chainId: 10143, address: privateKeyToAccount(KEY_A).address, privateKey: KEY_A, createdAt: '2026-10-01T00:00:00.000Z' });
    expect(JSON.parse(s.data.get(BURNER_STORAGE_KEY)!)).toEqual(first);
    // A second click, or a second tab, must not replace a key that may already hold faucet MON.
    const again = ensureBurner(s, { generate: () => KEY_B, now });
    expect(again.privateKey).toBe(KEY_A);
    expect(readBurner(s)).toEqual(first);
  });

  it('ignores stored values that are malformed, for another chain, or whose address does not match the key', () => {
    const s = memoryStorage();
    const good = { version: 1, chainId: 10143, address: privateKeyToAccount(KEY_A).address, privateKey: KEY_A, createdAt: '' };
    for (const bad of [
      'not json',
      JSON.stringify({ ...good, version: 2 }),
      JSON.stringify({ ...good, chainId: 143 }),
      JSON.stringify({ ...good, privateKey: '0x1234' }),
      JSON.stringify({ ...good, address: privateKeyToAccount(KEY_B).address }),
    ]) {
      s.setItem(BURNER_STORAGE_KEY, bad);
      expect(readBurner(s)).toBeNull();
    }
    // ensureBurner then replaces the broken value with a fresh key.
    expect(ensureBurner(s, { generate: () => KEY_B }).privateKey).toBe(KEY_B);
  });

  it('forget removes the key; a missing or throwing storage reads as no burner', () => {
    const s = memoryStorage();
    ensureBurner(s, { generate: () => KEY_A });
    forgetBurner(s);
    expect(readBurner(s)).toBeNull();
    expect(readBurner(null)).toBeNull();
    const throwing: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(readBurner(throwing)).toBeNull();
    expect(() => forgetBurner(throwing)).not.toThrow();
    expect(() => ensureBurner(throwing, { generate: () => KEY_A })).toThrow();
  });

  it('refuses to report success when the browser silently drops the write', () => {
    const dropping: KeyValueStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    expect(() => ensureBurner(dropping, { generate: () => KEY_A })).toThrow(/did not keep the burner key/);
  });
});
