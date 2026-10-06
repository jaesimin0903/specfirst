import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  AttestationRegistryClient,
  createChainClients,
  DEMO_FACTORY_ADDRESS,
  deployAttestationRegistry,
  deployDemoFactory,
  deployDemoToken,
  deployDemoVault,
  MONAD_TESTNET_DEFAULT_RPC,
  monadTestnet,
  standardIdOf,
  type ChainClients,
  type FeedEvent,
} from '@specfirst/core';
import type { Address, Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerWatchCommand } from '../src/commands/watch.js';
import { ANVIL_KEYS, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEMO_SOURCES = path.resolve(here, '../../../examples/watch/sources-demo.json');
const LIVE = process.env.SPECFIRST_LIVE === '1';
const TESTNET_RPC = process.env.MONAD_TESTNET_RPC ?? MONAD_TESTNET_DEFAULT_RPC;
const WATCH_KEY = ANVIL_KEYS[4] as Hex;

/**
 * The demo topology against Monad testnet without writing to it: the subject chain is a local anvil fork of
 * testnet (chain id 10143, the deterministic CREATE2 deployer included, so DemoVaultFactory lands at the
 * address examples/watch/sources-demo.json names), the registry is on a second, plain anvil. The watcher
 * reads the demo sources as they are, forge forks the testnet fork, and both demo vaults are attested for
 * chain 10143. Needs the network, forge and the suite's git pins, and takes minutes, so it runs only with
 * SPECFIRST_LIVE=1. RPC: $MONAD_TESTNET_RPC or the public default. Nothing is sent to Monad testnet.
 */
describe.skipIf(!LIVE)('specfirst watch on a fork of Monad testnet (SPECFIRST_LIVE=1)', { timeout: 1_500_000 }, () => {
  let fork: Anvil;
  let plain: Anvil;
  let subject: ChainClients;
  let attest: ChainClients;
  let dir: string;
  const savedEnv = { ...process.env };

  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram((p) => registerWatchCommand(p, { config: { confirmDelayMs: 0 } })).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };

  beforeAll(async () => {
    fork = await startAnvil(['--fork-url', TESTNET_RPC, '--compute-units-per-second', '50']);
    plain = await startAnvil();
    subject = createChainClients({ chain: monadTestnet, rpcUrls: [fork.url], rps: 50 });
    attest = createChainClients({ chain: anvilChain, rpcUrls: [plain.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-live-'));
    process.env.WATCH_ISSUER_PRIVATE_KEY = WATCH_KEY;
    process.env.SPECFIRST_LOCK_DIR = path.join(dir, 'locks');
    delete process.env.SPECFIRST_ATTEST_REGISTRY_31337;
  }, 120_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await fork?.stop();
    await plain?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('finds, checks with forge and attests the demo vaults of a testnet fork with the demo sources file as it is', async () => {
    expect(await subject.publicClient.getChainId()).toBe(10143);
    const wallet = subject.wallet(ANVIL_KEYS[0] as Hex);
    expect((await deployDemoFactory({ client: subject.publicClient, wallet })).address).toBe(DEMO_FACTORY_ADDRESS);
    const token = (await deployDemoToken({ client: subject.publicClient, wallet })).address;
    const from = await subject.publicClient.getBlockNumber();
    const sound = (await deployDemoVault({ client: subject.publicClient, wallet, asset: token, broken: false })).vault;
    const broken = (await deployDemoVault({ client: subject.publicClient, wallet, asset: token, broken: true })).vault;
    await subject.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    const reg = await deployAttestationRegistry({ client: attest.publicClient, wallet: attest.wallet(ANVIL_KEYS[0] as Hex), issuer: privateKeyToAccount(WATCH_KEY).address });

    const watch = (...extra: string[]) =>
      cli(
        'watch',
        '--subject-chain',
        '10143',
        '--subject-rpc',
        fork.url,
        '--sources',
        DEMO_SOURCES,
        '--network',
        'anvil',
        '--rpc',
        plain.url,
        '--registry-attest',
        reg.address,
        '--once',
        '--block-lag',
        '0',
        '--sweep-per-hour',
        '0',
        '--runs',
        '4',
        ...extra,
      );
    const r = await watch('--from-block', from.toString());
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const checked = r.events
      .filter((e) => e.type === 'watch-feed')
      .map((e) => e.event as FeedEvent)
      .filter((e) => e.kind === 'checked');
    expect(checked.map((e) => [e.subject, e.check!.summary.pass, e.check!.failed])).toEqual([
      [sound, 30, []],
      [broken, 29, ['previewDeposit']],
    ]);
    // The broken vault's failure is confirmed at the next block before it is attested.
    await subject.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    expect((await watch()).code).toBe(0);
    const registry = new AttestationRegistryClient(reg.address, attest.publicClient);
    for (const [vault, fail] of [
      [sound, 0],
      [broken, 1],
    ] as Array<[Address, number]>) {
      expect((await registry.latest(10143n, vault, standardIdOf('erc4626')))!.attestation).toMatchObject({ subjectChainId: 10143n, failCount: fail });
    }
  });
});
