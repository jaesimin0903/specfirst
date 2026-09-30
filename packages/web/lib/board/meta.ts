import type { VaultMeta, VaultMetaEntry } from './aggregate';

/*
 * data/vault-meta.json from a discovery list such as monad-4626-all.json: an array of
 * { protocol, name, address, asset: { symbol } }. Used by scripts/build-vault-meta.mjs.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

export interface ToVaultMetaResult {
  entries: Record<string, VaultMetaEntry>;
  /** Entries left out, with why (no valid address). */
  dropped: number;
}

export function toVaultMetaEntries(list: unknown): ToVaultMetaResult {
  if (!Array.isArray(list)) throw new Error('expected a JSON array of vaults');
  const entries: Record<string, VaultMetaEntry> = {};
  let dropped = 0;
  for (const item of list) {
    const v = item as { address?: unknown; protocol?: unknown; name?: unknown; asset?: { symbol?: unknown } | null };
    const address = typeof v?.address === 'string' ? v.address : '';
    if (!ADDRESS.test(address)) {
      dropped++;
      continue;
    }
    entries[address.toLowerCase()] = { protocol: text(v.protocol), assetSymbol: text(v.asset?.symbol), name: text(v.name) };
  }
  return { entries, dropped };
}

/** Replaces one chain's entries in `existing`, keeps the others, and sorts keys so diffs stay small. */
export function mergeVaultMeta(existing: VaultMeta | null, chainId: number, entries: Record<string, VaultMetaEntry>): VaultMeta {
  const out: VaultMeta = {};
  const chains = new Set([...Object.keys(existing ?? {}), String(chainId)]);
  for (const chain of [...chains].sort((a, b) => Number(a) - Number(b))) {
    const src = chain === String(chainId) ? entries : existing![chain]!;
    out[chain] = Object.fromEntries(Object.keys(src).sort().map((k) => [k, src[k]!]));
  }
  return out;
}
