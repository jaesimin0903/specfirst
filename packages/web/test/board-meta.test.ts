// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mergeVaultMeta, toVaultMetaEntries } from '../lib/board/meta';

describe('vault metadata from a discovery list', () => {
  it('keeps protocol, asset symbol and name per lowercase address, and drops entries without an address', () => {
    const { entries, dropped } = toVaultMetaEntries([
      { protocol: 'Upshift', name: 'earnAUSD', address: '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E', asset: { symbol: 'AUSD', decimals: 6 }, tvl_usd: 1 },
      { protocol: 'Morpho Vault V2', name: '  ', address: '0x024C304307cd4Aa63C28C082512c87c0452C9614', asset: null },
      { protocol: 'x', address: 'not an address' },
    ]);
    expect(dropped).toBe(1);
    expect(entries).toEqual({
      '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e': { protocol: 'Upshift', assetSymbol: 'AUSD', name: 'earnAUSD' },
      '0x024c304307cd4aa63c28c082512c87c0452c9614': { protocol: 'Morpho Vault V2', assetSymbol: null, name: null },
    });
    expect(() => toVaultMetaEntries({ vaults: [] })).toThrow(/array/);
  });

  it('replaces one chain and keeps the others, with sorted keys', () => {
    const merged = mergeVaultMeta(
      { '10143': { '0xb': { protocol: 'T', assetSymbol: null, name: null } }, '143': { '0xold': { protocol: 'Old', assetSymbol: null, name: null } } },
      143,
      { '0xz': { protocol: 'Z', assetSymbol: null, name: null }, '0xa': { protocol: 'A', assetSymbol: null, name: null } },
    );
    expect(Object.keys(merged)).toEqual(['143', '10143']);
    expect(Object.keys(merged['143']!)).toEqual(['0xa', '0xz']);
    expect(merged['10143']).toEqual({ '0xb': { protocol: 'T', assetSymbol: null, name: null } });
  });
});
