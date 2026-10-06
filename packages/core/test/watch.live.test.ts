import { createPublicClient, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { builtinSources, decodeSignal, fixtureLogReader, isNodeError, MONAD_MAINNET_SOURCE_FIXTURES, rpcTransport, verifySourceFixture } from '../src/index.js';

/**
 * The built-in Monad mainnet sources against the chain: each ADR fixture's creation block, read from the
 * factory, must hold the event naming the fixture vault, and the EVK GenericFactory's SetImplementation must
 * name the implementation EVK vaults resolve to. Read only, one eth_getLogs per fixture; runs only with
 * SPECFIRST_LIVE=1. RPC: $MONAD_MAINNET_RPC or https://rpc1.monad.xyz, then https://rpc.monad.xyz for blocks the
 * first answers with a node error (rpc1 says "Error getting block by number" for some archive blocks), as
 * `specfirst watch` reads them.
 */
const LIVE = process.env.SPECFIRST_LIVE === '1';
const RPCS = [process.env.MONAD_MAINNET_RPC ?? 'https://rpc1.monad.xyz', 'https://rpc.monad.xyz'];

describe.skipIf(!LIVE)('watch sources on Monad mainnet (SPECFIRST_LIVE=1)', { timeout: 120_000 }, () => {
  const client = createPublicClient({ transport: rpcTransport(RPCS, { rps: 5, failoverIf: isNodeError }) });
  const read = fixtureLogReader(client);
  const { sources } = builtinSources(143);

  for (const fixture of MONAD_MAINNET_SOURCE_FIXTURES) {
    it(`${fixture.source} names ${fixture.vault} at ${fixture.block}`, async () => {
      const out = await verifySourceFixture(fixture, sources, read);
      expect(out.decoded).toContain(fixture.vault);
      expect(out.ok).toBe(true);
    });
  }

  it('SetImplementation of the EVK GenericFactory at 30858657 names 0xef17750D3a162E28a302E266c474ff8989d60ECD', async () => {
    const source = sources.find((s) => s.signal === 'implementation')!;
    const logs = await read({ address: source.address!, topic0: source.topic0, block: 30858657n });
    expect(logs).toHaveLength(1);
    expect(decodeSignal(logs[0]!, sources)).toMatchObject({ subject: source.address, source: { signal: 'implementation' } });
    expect(getAddress(`0x${logs[0]!.topics[1]!.slice(26)}`)).toBe('0xef17750D3a162E28a302E266c474ff8989d60ECD');
  });
});
