import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allocationGateAbi,
  AllocationGateClient,
  anvilChain,
  createChainClients,
  identifyImplementation,
  summarize,
  type ChainClients,
  type StandardCheckReport,
} from '@specfirst/core';
import { parseEther, toFunctionSelector, type Address, type Hex } from 'viem';
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
const VERDICT_OF = toFunctionSelector(allocationGateAbi.find((x) => x.type === 'function' && x.name === 'verdictOf')!);

/** Forwards JSON-RPC to anvil but answers every eth_call of verdictOf with a JSON-RPC error. */
async function verdictReadsFail(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      const msgs = JSON.parse(body) as { id: number; method: string; params?: Array<{ data?: string; input?: string }> } | Array<never>;
      const one = Array.isArray(msgs) ? null : msgs;
      const data = one?.params?.[0]?.data ?? one?.params?.[0]?.input ?? '';
      if (one?.method === 'eth_call' && data.startsWith(VERDICT_OF)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: one.id, error: { code: -32000, message: 'verdictOf blocked by the test' } }));
        return;
      }
      const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

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
  let c: Address;
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
    c = event(await demo('vault', '--asset', token), 'watch-demo-vault').vault as Address;

    const noRegistry = await cli('watch', 'demo', 'gate', 'deploy', '--asset', token, '--network', 'anvil', '--registry-attest', '0x0000000000000000000000000000000000000001');
    expect(noRegistry.code).toBe(19);
    expect(noRegistry.err).toMatch(/WithoutCode/);
    const badSuite = await demo('gate', 'deploy', '--asset', token, '--suite-hash', '0x12');
    expect(badSuite.code).toBe(19);
    expect(badSuite.err).toMatch(/--suite-hash must be a 0x bytes32/);

    const d = await demo('gate', 'deploy', '--asset', token, '--max-age', '3600', '--fund', '100');
    expect(d.err).toBe('');
    expect(d.code).toBe(0);
    expect(d.events.map((e) => e.type)).toEqual(['watch-demo-gate-deployed', 'watch-demo-gate-funded']);
    expect(event(d, 'watch-demo-gate-deployed')).toMatchObject({ chainId: 31337, registry: process.env.SPECFIRST_ATTEST_REGISTRY_31337, asset: token, owner: DEPLOYER, standard: 'erc4626', suiteHash: `0x${'00'.repeat(32)}`, maxAttestationAge: '3600', vaultCallGas: '2000000', vaultViewGas: '300000', envName: 'SPECFIRST_GATE_31337' });
    gate = event(d, 'watch-demo-gate-deployed').gate as Address;
    process.env.SPECFIRST_GATE_31337 = gate;
    const s = await reader().summary();
    expect(s).toMatchObject({ owner: DEPLOYER, asset: token, subjectChainId: 31337n, maxAttestationAge: 3600n, vaultCallGas: 2_000_000n, vaultViewGas: 300_000n, idle: parseEther('100'), vaults: [] });
    const badGas = await demo('gate', 'deploy', '--asset', token, '--vault-call-gas', '0');
    expect(badGas.code).toBe(19);
    expect(badGas.err).toMatch(/--vault-call-gas must be a positive amount of gas/);
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
    // No --min-shares: the vault's previewDeposit less 1%.
    expect(event(r, 'watch-demo-gate-allocated')).toMatchObject({ vault: a, attestationId: idA, assets: parseEther('10').toString(), shares: parseEther('10').toString(), minShares: parseEther('9.9').toString() });
    const floor = await demo('gate', 'allocate', b, '1', '--min-shares', '2');
    expect(floor.code).toBe(19);
    expect(floor.err).toMatch(/allocation refused \(TooFewShares\)/);
    expect((await demo('gate', 'allocate', b, '20.5')).code).toBe(0);
    expect(await reader().position(a)).toMatchObject({ shares: parseEther('10'), assetsIn: parseEther('10') });

    // The deployer owns the gate: the CLI asks for --as-owner before it pulls money out of a healthy vault.
    const ex = await demo('gate', 'exit', a);
    expect(ex.code).toBe(19);
    expect(ex.err).toMatch(/exit refused: the vault is Compliant; you are the gate's owner and may exit it anyway with --as-owner/);
    process.env.DEPLOYER_PRIVATE_KEY = KEEPER_KEY;
    try {
      const stranger = await demo('gate', 'exit', a);
      expect(stranger.code).toBe(19);
      expect(stranger.err).toMatch(/exit refused: the vault is Compliant, .*; only the gate's owner may exit it now/);
    } finally {
      process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;
    }
    // A verdict that cannot be read is no reason to exit: the owner's key is refused without --as-owner.
    const proxy = await verdictReadsFail(anvil.url);
    try {
      const blind = await cli('watch', 'demo', 'gate', 'exit', a, '--network', 'anvil', '--rpc', proxy.url);
      expect(blind.code).toBe(19);
      expect(blind.err).toMatch(/exit refused: could not read the vault's verdict; you are the gate's owner and may exit it anyway with --as-owner/);
    } finally {
      await proxy.close();
    }
    expect((await reader().position(a)).shares).toBe(parseEther('10'));
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
    const nothing = await demo('gate', 'exit', a, '--as-owner');
    expect(nothing.code).toBe(19);
    expect(nothing.err).toMatch(/the gate holds no shares of/);

    // resync: owner only; books already equal the vault's balance here, so 0 to 0.
    const rs = await demo('gate', 'resync', a);
    expect(rs.err).toBe('');
    expect(event(rs, 'watch-demo-gate-resynced')).toMatchObject({ vault: a, fromShares: '0', toShares: '0' });
    process.env.DEPLOYER_PRIVATE_KEY = KEEPER_KEY;
    try {
      const stranger = await demo('gate', 'resync', a);
      expect(stranger.code).toBe(19);
      expect(stranger.err).toMatch(/NotOwner/);
    } finally {
      process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;
    }
  });

  it('the owner exits a healthy vault with --as-owner; an hour later allocate is Stale and says how to get a fresh attestation', async () => {
    await attest(c, false);
    expect((await demo('gate', 'allocate', c, '5')).code).toBe(0);
    const ex = await demo('gate', 'exit', c, '--as-owner');
    expect(ex.err).toBe('');
    expect(event(ex, 'watch-demo-gate-exit')).toMatchObject({ vault: c, exited: true, verdict: 'Compliant', assets: parseEther('5').toString() });

    await clients.publicClient.request({ method: 'evm_increaseTime' as never, params: [3601] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    const stale = await demo('gate', 'allocate', c, '1');
    expect(stale.code).toBe(19);
    expect(event(stale, 'watch-demo-gate-refused')).toMatchObject({ vault: c, verdict: 'Stale' });
    expect(stale.err).toMatch(/allocation refused \(Stale\): .*unchanged re-checks of the watcher are not attested.*specfirst cert attest/);
    // Stale opens no exit for others; the keeper leaves c alone (nothing held anyway) and the rest is exited.
    expect(event(await demo('gate', 'keep', '--once'), 'watch-demo-gate-pass')).toMatchObject({ vaults: 3, due: 0 });
  });

  it('human output names each vault, its verdict and its latest attestation', async () => {
    const r = await human('watch', 'demo', 'gate', 'status', '--network', 'anvil');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/AllocationGate 0x[0-9a-fA-F]{40}/);
    expect(r.out).toMatch(/any suite, attestations fresh for 3600 s/);
    expect(r.out).toMatch(/exit stipends 2000000 gas per vault call, 300000 per read/);
    expect(r.out).toMatch(/idle 100, 3 vaults/);
    expect(r.out).toMatch(new RegExp(`${a}\\s+NotCompliant`));
    expect(r.out).toMatch(/0 shares, 10 in, 10 out, last exit attempt block \d+/);
    expect(r.out).toMatch(/attestation \d+: Valid, 29 pass 1 fail 0 inconclusive 0 n\/a, issuer 0x[0-9a-fA-F]{40}, \d+ (s|min) ago/);
  });
});
