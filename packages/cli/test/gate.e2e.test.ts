import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AllocationGateClient,
  anvilChain,
  createChainClients,
  identifyImplementation,
  summarize,
  type ChainClients,
  type StandardCheckReport,
} from '@specfirst/core';
import { parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerCertCommand } from '../src/commands/cert.js';
import { registerWatchCommand } from '../src/commands/watch.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MORPHO = path.resolve(here, '../../core/test/fixtures/attest/morpho-143-109061472.json');
/** Registry owner, demo operator and gate owner; the registry's issuer; a keeper with no role at all. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const ISSUER_KEY = ANVIL_KEYS[1] as Hex;
const KEEPER_KEY = ANVIL_KEYS[3] as Hex;
const DEPLOYER = privateKeyToAccount(DEPLOYER_KEY).address;
const KEEPER = privateKeyToAccount(KEEPER_KEY).address;
const NOWHERE = 'http://127.0.0.1:1';

/**
 * The allocation gate of ADR 0007 on a local anvil, through the CLI: deploy the registry, a DemoToken, the factory
 * and two DemoVaults, then the gate; attest both vaults compliant with `cert attest`; allocate (refused before the
 * attestation); switch the bug on in both and attest the failing reports; allocation refused; one vault exited with
 * `gate exit`, the other by `gate keep --once` signed by a key with no role. The reports are the Morpho fixture
 * re-pointed at the vaults, with previewDeposit failing for the broken ones, so no forge and no public RPC.
 */
describe.skipIf(SKIP_ANVIL)('specfirst watch demo gate on anvil', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let token: Address;
  let a: Address;
  let b: Address;
  let gate: Address;
  const savedEnv = { ...process.env };

  const register = (p: import('commander').Command) => {
    registerAttestRegistryCommand(p);
    registerCertCommand(p);
    registerWatchCommand(p);
  };
  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const human = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--project', dir, ...args]));
    return { code: process.exitCode ?? 0, out: r.out.join('\n'), err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;
  const demo = (...args: string[]) => cli('watch', 'demo', ...args, '--network', 'anvil');
  const reader = () => new AllocationGateClient(gate, clients.publicClient);

  /** The Morpho fixture re-pointed at `vault` at the current block, previewDeposit failing when `broken`. */
  async function attest(vault: Address, broken: boolean): Promise<string> {
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    const block = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    const base = JSON.parse(await readFile(MORPHO, 'utf8')) as StandardCheckReport;
    const results = base.results.map((r) => (broken && r.id === 'previewDeposit' ? { ...r, status: 'fail' as const, reason: 'previewDeposit promised more shares than deposit minted' } : r));
    const identity = await identifyImplementation(clients.publicClient, vault, block);
    const report = { ...base, chainId: 31337, address: vault, blockNumber: block.toString(), identity, results, summary: summarize(results) };
    const rel = `.specfirst/checks/31337/${vault.toLowerCase()}/${block}.json`;
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), `${JSON.stringify(report, null, 2)}\n`);
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.err).toBe('');
    expect(event(r, 'check-attested')).toMatchObject({ subject: vault, compliant: !broken });
    return event(r, 'check-attested').id as string;
  }

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-gate-'));
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY, ISSUER_PRIVATE_KEY: ISSUER_KEY });
    for (const k of ['SPECFIRST_ATTEST_REGISTRY_31337', 'SPECFIRST_GATE_31337', 'SPECFIRST_REPORT_BASE_URL']) delete process.env[k];
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses monad-mainnet before any key or RPC, and asks for a gate address', async () => {
    for (const args of [['deploy', '--asset', DEPLOYER], ['allocate', DEPLOYER, '1'], ['exit', DEPLOYER], ['keep', '--once'], ['status']]) {
      const r = await cli('watch', 'demo', 'gate', ...args, '--network', 'monad-mainnet', '--rpc', NOWHERE, '--gate', DEPLOYER);
      expect(r.code, args.join(' ')).toBe(19);
      expect(r.err).toMatch(/--network monad-mainnet is read-only/);
    }
    const none = await demo('gate', 'status');
    expect(none.code).toBe(19);
    expect(none.err).toMatch(/no AllocationGate address: set SPECFIRST_GATE_31337 or pass --gate <address>/);
  });

  it('deploys the registry, a token, two vaults and the gate; the deployer owns it and it holds the funded tokens', async () => {
    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil');
    expect(reg.code).toBe(0);
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = event(reg, 'attest-registry-deployed').address as string;
    token = event(await demo('deploy', '--token'), 'watch-demo-deployed').token as Address;
    a = event(await demo('vault', '--asset', token), 'watch-demo-vault').vault as Address;
    b = event(await demo('vault', '--asset', token), 'watch-demo-vault').vault as Address;

    const noRegistry = await cli('watch', 'demo', 'gate', 'deploy', '--asset', token, '--network', 'anvil', '--registry-attest', '0x0000000000000000000000000000000000000001');
    expect(noRegistry.code).toBe(19);
    expect(noRegistry.err).toMatch(/WithoutCode/);

    const d = await demo('gate', 'deploy', '--asset', token, '--max-age', '3600', '--fund', '100');
    expect(d.err).toBe('');
    expect(d.code).toBe(0);
    expect(d.events.map((e) => e.type)).toEqual(['watch-demo-gate-deployed', 'watch-demo-gate-funded']);
    expect(event(d, 'watch-demo-gate-deployed')).toMatchObject({ chainId: 31337, registry: process.env.SPECFIRST_ATTEST_REGISTRY_31337, asset: token, owner: DEPLOYER, standard: 'erc4626', maxAttestationAge: '3600', envName: 'SPECFIRST_GATE_31337' });
    gate = event(d, 'watch-demo-gate-deployed').gate as Address;
    process.env.SPECFIRST_GATE_31337 = gate;
    const s = await reader().summary();
    expect(s).toMatchObject({ owner: DEPLOYER, asset: token, subjectChainId: 31337n, maxAttestationAge: 3600n, idle: parseEther('100'), vaults: [] });
  });

  it('refuses to allocate into a vault nobody attested', async () => {
    const r = await demo('gate', 'allocate', a, '10');
    expect(r.code).toBe(19);
    expect(event(r, 'watch-demo-gate-refused')).toMatchObject({ vault: a, verdict: 'NoAttestation', error: 'NoAttestation' });
    expect(r.err).toMatch(/allocation refused \(NoAttestation\): the registry has no attestation of this vault/);
  });

  it('allocates into both vaults once they are attested compliant; exit is refused while they are', async () => {
    const idA = await attest(a, false);
    await attest(b, false);
    const r = await demo('gate', 'allocate', a, '10');
    expect(r.err).toBe('');
    expect(event(r, 'watch-demo-gate-allocated')).toMatchObject({ vault: a, attestationId: idA, assets: parseEther('10').toString(), shares: parseEther('10').toString() });
    expect((await demo('gate', 'allocate', b, '20.5')).code).toBe(0);
    expect(await reader().position(a)).toMatchObject({ shares: parseEther('10'), assetsIn: parseEther('10') });

    const ex = await demo('gate', 'exit', a);
    expect(ex.code).toBe(19);
    expect(ex.err).toMatch(/exit refused: the vault is Compliant/);
    const keep = await demo('gate', 'keep', '--once');
    expect(keep.code).toBe(0);
    expect(event(keep, 'watch-demo-gate-pass')).toMatchObject({ vaults: 2, due: 0, exited: 0 });
  });

  it('the bug switched on and attested: new money is refused, exit pulls the shares back, the keeper takes the other vault', async () => {
    for (const v of [a, b]) expect((await demo('set-broken', v, 'on')).code).toBe(0);
    const failA = await attest(a, true);
    await attest(b, true);

    const refused = await demo('gate', 'allocate', a, '1');
    expect(refused.code).toBe(19);
    expect(event(refused, 'watch-demo-gate-refused')).toMatchObject({ verdict: 'NotCompliant' });

    const ex = await demo('gate', 'exit', a);
    expect(ex.err).toBe('');
    expect(event(ex, 'watch-demo-gate-exit')).toMatchObject({ vault: a, exited: true, path: 'Redeem', verdict: 'NotCompliant', attestationId: failA, shares: parseEther('10').toString(), assets: parseEther('10').toString() });

    // The keeper signs with a key that is neither the owner nor an issuer.
    process.env.DEPLOYER_PRIVATE_KEY = KEEPER_KEY;
    try {
      const keep = await demo('gate', 'keep', '--once');
      expect(keep.err).toBe('');
      expect(keep.code).toBe(0);
      const exits = keep.events.filter((e) => e.type === 'watch-demo-gate-exit');
      expect(exits).toHaveLength(1);
      expect(exits[0]).toMatchObject({ vault: b, exited: true, assets: parseEther('20.5').toString() });
      expect(event(keep, 'watch-demo-gate-pass')).toMatchObject({ vaults: 2, due: 1, exited: 1 });
    } finally {
      process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;
    }
    const logs = await clients.publicClient.getLogs({ address: gate, fromBlock: 0n });
    expect(logs.length).toBeGreaterThan(0);
    const keeperTx = (await clients.publicClient.getTransaction({ hash: logs[logs.length - 1]!.transactionHash! })).from;
    expect(keeperTx.toLowerCase()).toBe(KEEPER.toLowerCase());

    const st = await demo('gate', 'status');
    expect(st.code).toBe(0);
    const s = event(st, 'watch-demo-gate-status');
    expect(s).toMatchObject({ gate, idle: parseEther('100').toString() });
    expect(s.vaults).toEqual([
      expect.objectContaining({ vault: a, verdict: 'NotCompliant', canExit: false, attestation: expect.objectContaining({ id: failA, status: 'Valid', failCount: 1, issuerAllowed: true }) }),
      expect.objectContaining({ vault: b, verdict: 'NotCompliant', canExit: false }),
    ]);
    const nothing = await demo('gate', 'exit', a);
    expect(nothing.code).toBe(19);
    expect(nothing.err).toMatch(/the gate holds no shares of/);
  });

  it('human output names each vault, its verdict and its latest attestation', async () => {
    const r = await human('watch', 'demo', 'gate', 'status', '--network', 'anvil');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/AllocationGate 0x[0-9a-fA-F]{40}/);
    expect(r.out).toMatch(/idle 100, 2 vaults/);
    expect(r.out).toMatch(new RegExp(`${a}\\s+NotCompliant`));
    expect(r.out).toMatch(/0 shares, 10 in, 10 out, last exit attempt block \d+/);
    expect(r.out).toMatch(/attestation \d+: Valid, 29 pass 1 fail 0 inconclusive 0 n\/a, issuer 0x[0-9a-fA-F]{40}, \d+ s ago/);
  });
});
