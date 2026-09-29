import { createPublicClient, http, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { identifyImplementation, MONAD_MAINNET_DEFAULT_RPC, runErc4626Control } from '../src/index.js';

/**
 * Read-only checks against Monad mainnet (chain 143). They need the network and take minutes, so they
 * run only with SPECFIRST_LIVE=1. RPC: $MONAD_MAINNET_RPC or the public default. Nothing is signed or sent.
 */
const LIVE = process.env.SPECFIRST_LIVE === '1';
const RPC = process.env.MONAD_MAINNET_RPC ?? MONAD_MAINNET_DEFAULT_RPC;
const BLOCK = 109061472n;
const USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address;
const METAMORPHO = ['0x802c91d807A8DaCA257c4708ab264B6520964e44', '0xBC03E505EE65f9fAa68a2D7e5A74452858C16D29', '0x32841A8511D5c2c5b253f45668780B99139e476D'] as Address[];

describe.skipIf(!LIVE)('standards on Monad mainnet (SPECFIRST_LIVE=1)', { timeout: 900_000 }, () => {
  const client = createPublicClient({ transport: http(RPC) });

  it('three MetaMorpho vaults with different immutables share one implementationKey', async () => {
    const block = await client.getBlockNumber();
    const ids = await Promise.all(METAMORPHO.map((a) => identifyImplementation(client, a, block)));
    expect(new Set(ids.map((i) => i.codeHash)).size).toBe(3);
    expect(new Set(ids.map((i) => i.implementationKey)).size).toBe(1);
    for (const i of ids) expect(i).toMatchObject({ proxy: null, metadataHash: null, implementationKeyKind: { of: 'self', hash: 'maskedCodeHash' } });
  });

  it('Euler EVK vault resolves through its EIP-1967 beacon', async () => {
    const id = await identifyImplementation(client, '0x4735E245271496aEDEFF224b7dcB06fA7715cfB7', await client.getBlockNumber());
    expect(id.proxy).toEqual({ kind: 'eip1967-beacon', implementation: '0xef17750D3a162E28a302E266c474ff8989d60ECD', beacon: '0xba4Dd672062dE8FeeDb665DD4410658864483f1E' });
    expect(id.implementationKeyKind).toEqual({ of: 'implementation', hash: 'metadataHash' });
  });

  it('positive control: BrokenVault over USDC fails previewDeposit and nothing else', async () => {
    const results = await runErc4626Control({ asset: USDC, rpcUrl: RPC, blockNumber: BLOCK, runs: 8 });
    expect(results.find((r) => r.id === 'previewDeposit')!.status).toBe('fail');
    expect(results.filter((r) => r.status === 'fail').map((r) => r.id)).toEqual(['previewDeposit']);
  });
});
