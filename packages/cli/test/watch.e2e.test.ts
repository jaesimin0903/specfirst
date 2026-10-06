import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  attestationParamsFromReport,
  AttestationRegistryClient,
  checkAttestationRegistryAbi,
  checkReportHash,
  createChainClients,
  DEMO_FACTORY_ADDRESS,
  demoVaultAbi,
  deployDemoVault,
  identifyImplementation,
  parseCheckReport,
  parseFeed,
  setDemoVaultBroken,
  standardIdOf,
  summarize,
  watchStatusSchema,
  watchVaultsSchema,
  WatchStore,
  type ActiveSubscription,
  type AlertSink,
  type ChainClients,
  type FeedEvent,
  type RunStandardCheckInput,
  type StandardCheckReport,
} from '@specfirst/core';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerWatchCommand } from '../src/commands/watch.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MORPHO = path.resolve(here, '../../core/test/fixtures/attest/morpho-143-109061472.json');
const DEMO_SOURCES = path.resolve(here, '../../../examples/watch/sources-demo.json');
/** Registry owner (also the demo signer), desk worker issuer, another account and the watcher's own issuer. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const ISSUER_KEY = ANVIL_KEYS[1] as Hex;
const OPERATOR_KEY = ANVIL_KEYS[2] as Hex;
const WATCH_KEY = ANVIL_KEYS[4] as Hex;
const WATCH_ISSUER = privateKeyToAccount(WATCH_KEY).address;
const DEPLOYER = privateKeyToAccount(DEPLOYER_KEY).address;
const addrOf = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const BASE = 'https://example.org/checks';
const ERC4626 = standardIdOf('erc4626');

/**
 * `specfirst watch` on a local anvil that is both the subject chain and the attest chain (ADR 0006): the
 * registry, DemoVaultFactory (at its CREATE2 address, through the deployer anvil ships) and a DemoToken are
 * deployed with `watch demo`; the watcher reads the demo sources file (re-pointed at chain 31337), finds a vault deployed
 * through the factory, checks and attests it; a first deposit re-checks it without a transaction; the
 * operator switching the vault's deliberate bug on (BrokenSet, an upgrade signal in the demo sources)
 * changes the outcome, which is attested and handed to the alert sink with the vault's subscription. The suite is replaced by the Morpho fixture re-pointed at the vault
 * with previewDeposit failing while `broken()` is true at the check block, so no forge and no public RPC.
 */
describe.skipIf(SKIP_ANVIL)('specfirst watch on anvil', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let sourcesFile: string;
  let registry: Address;
  let token: Address;
  let vault: Address;
  /** The broken vault --no-attest checked: its last check is a report nobody attested. */
  let unattested: Address;
  const checks: Array<{ address: Address; block: bigint }> = [];
  const subscriptions: ActiveSubscription[] = [];
  const delivered: Array<{ event: FeedEvent; subs: string[] }> = [];
  const savedEnv = { ...process.env };

  const runCheck = async (input: RunStandardCheckInput): Promise<StandardCheckReport> => {
    checks.push({ address: input.address, block: input.blockNumber! });
    const base = JSON.parse(await readFile(MORPHO, 'utf8')) as StandardCheckReport;
    const broken = await clients.publicClient.readContract({ address: input.address, abi: demoVaultAbi, functionName: 'broken', blockNumber: input.blockNumber! });
    const results = base.results.map((r) => (broken && r.id === 'previewDeposit' ? { ...r, status: 'fail' as const, reason: 'previewDeposit promised more shares than deposit minted' } : r));
    const identity = await identifyImplementation(clients.publicClient, input.address, input.blockNumber!);
    return parseCheckReport(JSON.stringify({ ...base, chainId: 31337, address: input.address, blockNumber: input.blockNumber!.toString(), identity, results, summary: summarize(results), startedAt: new Date().toISOString() }));
  };
  const alerts: AlertSink = {
    deliver: async (event, subs) => {
      delivered.push({ event, subs: subs.map((s) => s.id.toString()) });
      return subs.map((s) => ({ ...event, v: 1 as const, seq: 0, kind: 'alerted' as const, alert: { subscriptionId: s.id.toString(), subscriber: s.subscriber, channel: 'inbox' as const, ok: true } }));
    },
  };
  const register = (p: import('commander').Command) => {
    registerAttestRegistryCommand(p);
    // A subscribed subject is due at every pass and a confirmation at the next one, so the test needs no clock.
    registerWatchCommand(p, { runCheck, hooks: { subscriptions: { active: async () => subscriptions }, alerts }, config: { subscribedMinutes: 0, confirmDelayMs: 0 }, sleep: async () => {} });
  };
  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;
  const fed = (r: { events: Array<Record<string, unknown>> }) => r.events.filter((e) => e.type === 'watch-feed').map((e) => e.event as FeedEvent);
  const kinds = (events: FeedEvent[]) => events.map((e) => `${e.kind}:${e.source ?? ''}`);
  const watchDir = () => path.join(dir, '.specfirst/watch/31337');
  const watch = (...extra: string[]) =>
    cli('watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', anvil.url, '--sources', sourcesFile, '--once', '--block-lag', '0', '--sweep-per-hour', '0', '--report-base-url', BASE, ...extra);
  const mine = () => clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-'));
    const demo = JSON.parse(await readFile(DEMO_SOURCES, 'utf8')) as { chainId: number };
    sourcesFile = path.join(dir, 'sources-anvil.json');
    await writeFile(sourcesFile, JSON.stringify({ ...demo, chainId: 31337 }));
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY, ISSUER_PRIVATE_KEY: ISSUER_KEY, WATCH_ISSUER_PRIVATE_KEY: WATCH_KEY, SPECFIRST_LOCK_DIR: path.join(dir, 'locks') });
    for (const k of ['SPECFIRST_ATTEST_REGISTRY_31337', 'SPECFIRST_REPORT_BASE_URL']) delete process.env[k];
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses monad-mainnet for attesting before any key or RPC, a watcher key that is not an issuer, a subject RPC that is down or of another chain', async () => {
    for (const args of [['--once'], ['demo', 'deploy'], ['demo', 'vault', '--asset', addrOf(1)], ['demo', 'set-broken', addrOf(1), 'on']]) {
      const r = await cli('watch', ...args, '--network', 'monad-mainnet', '--rpc', 'http://127.0.0.1:1');
      expect(r.code, args.join(' ')).toBe(19);
      expect(r.err).toMatch(/--network monad-mainnet is read-only/);
    }

    delete process.env.WATCH_ISSUER_PRIVATE_KEY;
    const noKey = await cli('watch', '--network', 'monad-testnet', '--rpc', 'http://127.0.0.1:1', '--once');
    expect(noKey.code).toBe(19);
    expect(noKey.err).toMatch(/WATCH_ISSUER_PRIVATE_KEY is not set .*; --share-issuer-key signs with ISSUER_PRIVATE_KEY instead, or --no-attest sends nothing/);
    process.env.WATCH_ISSUER_PRIVATE_KEY = WATCH_KEY;

    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil');
    expect(reg.code).toBe(0);
    registry = event(reg, 'attest-registry-deployed').address as Address;
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = registry;
    const notIssuer = await watch();
    expect(notIssuer.code).toBe(19);
    expect(notIssuer.err).toMatch(new RegExp(`${WATCH_ISSUER} is not an issuer of ${registry}`));
    // --share-issuer-key does not apply while WATCH_ISSUER_PRIVATE_KEY is set.
    expect((await watch('--share-issuer-key')).code).toBe(19);
    const set = await cli('attest-registry', 'set-issuer', WATCH_ISSUER, '--network', 'anvil');
    expect(set.code).toBe(0);
    const down = await cli('watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', 'http://127.0.0.1:1', '--once');
    expect(down.code).toBe(19);
    expect(down.err).toMatch(/the subject RPC http:\/\/127\.0\.0\.1:1 did not answer eth_chainId/);
    const otherChain = await cli('watch', '--network', 'anvil', '--subject-chain', '10143', '--subject-rpc', anvil.url, '--once');
    expect(otherChain.code).toBe(19);
    expect(otherChain.err).toMatch(/serves chain 31337, not --subject-chain 10143/);
  });

  it('starts at the head without a cursor; a vault deployed through the factory is detected, probed, checked and attested', async () => {
    const d = await cli('watch', 'demo', 'deploy', '--token', '--network', 'anvil');
    expect(d.err).toBe('');
    expect(event(d, 'watch-demo-deployed')).toMatchObject({ chainId: 31337, factory: DEMO_FACTORY_ADDRESS, factoryTx: expect.stringMatching(/^0x[0-9a-f]{64}$/), token: expect.stringMatching(/^0x/) });
    token = event(d, 'watch-demo-deployed').token as Address;
    expect(event(await cli('watch', 'demo', 'deploy', '--network', 'anvil'), 'watch-demo-deployed')).toMatchObject({ factory: DEMO_FACTORY_ADDRESS, factoryTx: null, token: null });

    const first = await watch();
    expect(first.err).toBe('');
    expect(first.code).toBe(0);
    expect(event(first, 'watch-start')).toMatchObject({ subjectChainId: 31337, sources: ['Specfirst DemoVaultFactory', 'ERC-4626 Deposit', 'EIP-1967 Upgraded', 'EIP-1967 BeaconUpgraded'], known: 0, attest: true, registry, issuer: WATCH_ISSUER });
    expect(fed(first)).toEqual([]);

    const v = await cli('watch', 'demo', 'vault', '--asset', token, '--network', 'anvil');
    expect(event(v, 'watch-demo-vault')).toMatchObject({ asset: token, broken: false, operator: DEPLOYER });
    vault = event(v, 'watch-demo-vault').vault as Address;
    await mine();
    const r = await watch();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const feed = fed(r);
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'attested:factory', 'changed:factory']);
    expect(feed[0]).toMatchObject({ subject: vault, factory: { address: DEMO_FACTORY_ADDRESS, name: 'Specfirst DemoVaultFactory' } });
    expect(checks.map((c) => c.address)).toEqual([vault]);

    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const latest = (await reg.latest(31337n, vault, ERC4626))!;
    expect(latest.attestation).toMatchObject({ subject: vault, issuer: WATCH_ISSUER, blockNumber: checks[0]!.block, passCount: 30, failCount: 0, status: 1 });
    expect(feed[3]!.attestation).toEqual({ id: latest.id.toString(), txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/), supersedes: null });
    const copy = path.join(dir, 'certs/checks', latest.attestation.reportURI.slice(BASE.length + 1));
    expect(existsSync(copy)).toBe(true);
    expect(checkReportHash(parseCheckReport(await readFile(copy, 'utf8')))).toBe(latest.attestation.reportHash);
    expect(feed[2]!.check!.reportPath).toBe(path.relative(dir, copy));

    const onDisk = parseFeed(await readFile(path.join(watchDir(), 'feed.ndjson'), 'utf8'));
    expect(onDisk.invalid).toBe(0);
    expect(onDisk.events).toEqual(feed);
    const status = watchStatusSchema.parse(JSON.parse(await readFile(path.join(watchDir(), 'status.json'), 'utf8')));
    expect(status).toMatchObject({
      chainId: 31337,
      lagBlocks: 0,
      running: null,
      queue: [],
      counts: { known: 1, detected24h: 1, checked24h: 1, attested24h: 1, changed24h: 1 },
      attestBudget: { perDay: 15, usedToday: 1, unsolicitedPerDay: 10, unsolicitedUsedToday: 1, perSubjectPerDay: 2, minBalanceWei: '300000000000000000', paused: null },
    });
    expect(BigInt(status.attestBudget.balanceWei!)).toBeGreaterThan(10n ** 18n);
    expect(BigInt(status.gasCostWei!)).toBeGreaterThan(0n);
    expect(status.sources[0]).toMatchObject({ name: 'Specfirst DemoVaultFactory', address: DEMO_FACTORY_ADDRESS, seen: 1 });
    const vaults = watchVaultsSchema.parse(JSON.parse(await readFile(path.join(watchDir(), 'vaults.json'), 'utf8')));
    expect(vaults.vaults[vault.toLowerCase()]).toMatchObject({ firstSeen: { source: 'factory' }, lastAttestationId: latest.id.toString(), firstDepositBlock: null });
  });

  it('a first deposit re-checks the vault; the unchanged outcome is recorded without a transaction', async () => {
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const count = await reg.attestationCount();
    const dep = await cli('watch', 'demo', 'deposit', vault, '--asset', token, '--amount', '5', '--network', 'anvil');
    expect(event(dep, 'watch-demo-deposit')).toMatchObject({ vault, amount: parseEther('5').toString() });
    await mine();
    const r = await watch();
    expect(r.code).toBe(0);
    const feed = fed(r);
    expect(kinds(feed)).toEqual(['queued:first-deposit', 'checked:first-deposit']);
    expect(feed[1]!.reason).toMatch(/^not attested \[unchanged\]: unchanged since attestation \d+$/);
    expect(await reg.attestationCount()).toBe(count);
    expect(checks).toHaveLength(2);
  });

  it("a subscription gets its first check; the bug switched on is a change confirmed at the next block, then attested and alerted", async () => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    subscriptions.push({ id: 4n, subscriber: privateKeyToAccount(ANVIL_KEYS[3] as Hex).address, subjectChainId: 31337n, subject: vault, standardId: ERC4626, startsAt: now - 60n, endsAt: now + 86_400n });
    const first = await watch();
    expect(kinds(fed(first))).toEqual(['queued:subscribed', 'checked:subscribed', 'alerted:subscribed']);
    expect(fed(first)[1]!.reason).toMatch(/^not attested \[unchanged\]: unchanged since attestation \d+$/);
    expect(delivered.map((d) => [d.event.kind, d.subs])).toEqual([['checked', ['4']]]);

    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const before = (await reg.latest(31337n, vault, ERC4626))!;
    // Only the vault's operator (the deployer) may switch the bug.
    const notOperator = await setDemoVaultBroken({ client: clients.publicClient, wallet: clients.wallet(OPERATOR_KEY), vault, broken: true }).catch((e: Error) => e);
    expect(String(notOperator)).toMatch(/NotOperator|reverted/);
    expect(event(await cli('watch', 'demo', 'set-broken', vault, 'on', '--network', 'anvil'), 'watch-demo-set-broken')).toMatchObject({ vault, broken: true });
    await mine();
    const pending = await watch();
    expect(kinds(fed(pending))).toEqual(['queued:subscribed', 'checked:subscribed', 'queued:subscribed']);
    expect(fed(pending)[1]!.reason).toBe('pending confirmation [confirm]: regressed against the last check; nothing follows until a second check at a later block agrees');
    expect((await reg.latest(31337n, vault, ERC4626))!.id).toBe(before.id);
    expect(delivered).toHaveLength(1);

    await mine();
    const r = await watch();
    expect(r.code).toBe(0);
    const feed = fed(r);
    expect(kinds(feed)).toEqual(['checked:subscribed', 'attested:subscribed', 'changed:subscribed', 'alerted:subscribed']);
    expect(feed[0]!.reason).toMatch(new RegExp(`^confirmed by a second check at block \\d+ after block \\d+; attesting \\[subscribed\\]: confirmed change of a subscribed subject; counts, failed differ from attestation ${before.id}$`));
    const after = (await reg.latest(31337n, vault, ERC4626))!;
    expect(after.attestation).toMatchObject({ failCount: 1, passCount: 29, issuer: WATCH_ISSUER });
    expect(feed[1]!.attestation).toMatchObject({ id: after.id.toString(), supersedes: before.id.toString() });
    expect(feed[2]).toMatchObject({ change: { kind: 'regressed', from: { failed: [] }, to: { failed: ['previewDeposit'] } }, attestation: { id: after.id.toString() } });
    expect(feed[3]).toMatchObject({ subject: vault, alert: { subscriptionId: '4', channel: 'inbox', ok: true } });
    expect(delivered.map((d) => [d.event.kind, d.subs])).toEqual([
      ['checked', ['4']],
      ['changed', ['4']],
    ]);
    expect((await reg.attestationOf(before.id)).status).toBe(2);
    subscriptions.splice(0);
  });

  it('--no-attest decides from the registry and sends nothing; no watcher key is needed', async () => {
    delete process.env.WATCH_ISSUER_PRIVATE_KEY;
    const wallet = clients.wallet(OPERATOR_KEY);
    const second = (await deployDemoVault({ client: clients.publicClient, wallet, asset: token, broken: true })).vault;
    await mine();
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const count = await reg.attestationCount();
    const r = await watch('--no-attest');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'watch-start')).toMatchObject({ attest: false, registry, issuer: null });
    // A first check with a failed property waits for a second check at a later block.
    expect(kinds(fed(r))).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'queued:factory']);
    expect(fed(r)[2]).toMatchObject({ subject: second, reason: 'pending confirmation [confirm]: a failed property in a first check; nothing follows until a second check at a later block agrees' });
    await mine();
    const confirmed = await watch('--no-attest');
    expect(kinds(fed(confirmed))).toEqual(['checked:factory', 'changed:factory']);
    expect(fed(confirmed)[0]).toMatchObject({
      subject: second,
      reason: expect.stringMatching(/; not attested \[no-attest\]: would attest as factory \(first check of a vault a factory announced\); no attestation of the subject yet$/),
      check: { failed: ['previewDeposit'] },
    });
    expect(await reg.attestationCount()).toBe(count);
    unattested = second;
    process.env.WATCH_ISSUER_PRIVATE_KEY = WATCH_KEY;
  });

  it('a second watcher on the same chain directory, or on the same key anywhere, is refused while the first is alive; --issuer-key-env picks another key', async () => {
    const lock = path.join(watchDir(), 'watch.lock');
    await writeFile(lock, `${process.ppid}\n`);
    const r = await watch();
    expect(r.code).toBe(19);
    expect(r.err).toMatch(new RegExp(`another watcher \\(pid ${process.ppid}\\) is running`));
    await rm(lock);

    // The key is locked for the user, not for the project: another project directory on the same key is refused.
    const keyLock = path.join(dir, 'locks', `issuer-${WATCH_ISSUER.toLowerCase()}.lock`);
    await mkdir(path.dirname(keyLock), { recursive: true });
    await writeFile(keyLock, `${process.ppid}\n`);
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-other-'));
    process.exitCode = undefined;
    const other = await capture(() =>
      buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', elsewhere, 'watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', anvil.url, '--once']),
    );
    expect(process.exitCode).toBe(19);
    expect(other.err.join('\n')).toMatch(new RegExp(`another watcher signing as ${WATCH_ISSUER} \\(pid ${process.ppid}\\) is running`));
    await rm(keyLock);
    await rm(elsewhere, { recursive: true, force: true });

    // A demo watcher signs with its own key, named by --issuer-key-env; it must be an issuer like any other.
    const demoKey = ANVIL_KEYS[5] as Hex;
    process.env.WATCH_DEMO_ISSUER_PRIVATE_KEY = demoKey;
    const demo = await watch('--issuer-key-env', 'WATCH_DEMO_ISSUER_PRIVATE_KEY');
    expect(demo.code).toBe(19);
    expect(demo.err).toMatch(new RegExp(`${privateKeyToAccount(demoKey).address} is not an issuer of ${registry}`));
    expect((await watch('--issuer-key-env', 'not a name')).err).toMatch(/--issuer-key-env must name an environment variable/);
    delete process.env.WATCH_DEMO_ISSUER_PRIVATE_KEY;
  });

  it('human output names each step', async () => {
    await deployDemoVault({ client: clients.publicClient, wallet: clients.wallet(OPERATOR_KEY), asset: token, broken: false });
    await mine();
    process.exitCode = undefined;
    const r = await capture(() =>
      buildProgram(register).parseAsync([
        'node',
        'specfirst',
        '--project',
        dir,
        'watch',
        '--network',
        'anvil',
        '--subject-chain',
        '31337',
        '--subject-rpc',
        anvil.url,
        '--sources',
        sourcesFile,
        '--once',
        '--block-lag',
        '0',
        '--sweep-per-hour',
        '0',
        '--report-base-url',
        BASE,
      ]),
    );
    expect(process.exitCode ?? 0).toBe(0);
    const out = r.out.join('\n');
    expect(out).toMatch(/^watch +chain 31337 {2}4 sources \(.*sources-anvil\.json\) {2}2 known vaults/m);
    // The banner names the RPC host only: a provider URL's path often carries an API key.
    expect(out).toContain(`subject RPC 127.0.0.1:${anvil.port}  lag 0`);
    expect(out).not.toContain(anvil.url);
    expect(out).toMatch(/detected {2}0x\S+ {2}factory Specfirst DemoVaultFactory {2}block \d+/);
    expect(out).toMatch(/checked {2}0x\S+ {2}factory {2}block \d+ {2}30 pass {2}attesting \[factory\]: first check of a vault a factory announced; no attestation of the subject yet/);
    expect(out).toMatch(/attested {2}0x\S+ {2}attestation \d+/);
  });

  it('an attest recorded in state.json is looked up first: pending, nothing is sent; dropped, it goes out again with its nonce, once', async () => {
    const rpc = (method: string, params: unknown[]) => clients.publicClient.request({ method: method as never, params: params as never });
    const third = (await deployDemoVault({ client: clients.publicClient, wallet: clients.wallet(OPERATOR_KEY), asset: token, broken: false })).vault;
    await mine();
    // What a watcher that stopped right after sending leaves behind: the journal of an attest of the unattested vault's last check.
    const lower = unattested.toLowerCase();
    const store = await WatchStore.load(dir, 31337);
    const last = store.vaults.vaults[lower]!.lastCheck!;
    const report = parseCheckReport(await readFile(path.join(dir, last.reportPath), 'utf8'));
    const reportURI = `${BASE}/${last.reportPath.replace(/^certs\/checks\//, '')}`;
    const data = encodeFunctionData({ abi: checkAttestationRegistryAbi, functionName: 'attest', args: [attestationParamsFromReport(report, { reportURI })] as never });
    const nonce = await clients.publicClient.getTransactionCount({ address: WATCH_ISSUER, blockTag: 'pending' });
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const before = await reg.attestationCount();
    await rpc('evm_setAutomine', [false]);
    let first: Hex;
    try {
      first = await clients.wallet(WATCH_KEY).sendTransaction({ to: registry, data, nonce, gas: 2_000_000n });
      store.state.attesting[lower] = { hash: first, nonce, at: new Date().toISOString(), reportPath: last.reportPath, reportURI, block: report.blockNumber, source: 'factory', cls: 'factory', replaced: [], bumps: 0 };
      await store.save();
      // Pending in the mempool: the new vault is checked, its attestation waits behind the transaction.
      const waiting = await watch();
      expect(waiting.code).toBe(0);
      expect(kinds(fed(waiting))).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'changed:factory']);
      expect(fed(waiting)[2]).toMatchObject({ subject: third, reason: expect.stringMatching(new RegExp(`^attestation deferred \\[factory\\]: attest tx ${first} sent earlier is not mined yet; `)) });
      expect(await clients.publicClient.getTransactionCount({ address: WATCH_ISSUER, blockTag: 'pending' })).toBe(nonce + 1);
      // Dropped before it was mined, nonce unused: sent again with that nonce.
      await rpc('anvil_dropTransaction', [first]);
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    const resumed = await watch();
    expect(resumed.code).toBe(0);
    const attested = fed(resumed).filter((e) => e.kind === 'attested');
    expect(attested).toEqual([expect.objectContaining({ subject: unattested, reason: '[factory]' })]);
    expect(await reg.attestationCount()).toBe(before + 1n);
    const again = attested[0]!.attestation!.txHash as Hex;
    expect(again).not.toBe(first!);
    expect((await clients.publicClient.getTransaction({ hash: again })).nonce).toBe(nonce);
    expect((await reg.attestationOf(BigInt(attested[0]!.attestation!.id))).subject).toBe(unattested);
    expect(JSON.parse(await readFile(path.join(watchDir(), 'state.json'), 'utf8')).attesting).toEqual({});
  });

  it('a stuck attest is sent again with its nonce and a higher fee; only one of the two is mined', async () => {
    const rpc = (method: string, params: unknown[]) => clients.publicClient.request({ method: method as never, params: params as never });
    const store = await WatchStore.load(dir, 31337);
    const [lower, deferred] = Object.entries(store.state.deferred)[0]!;
    const report = parseCheckReport(await readFile(path.join(dir, deferred.reportPath), 'utf8'));
    const reg = new AttestationRegistryClient(registry, clients.publicClient, clients.wallet(WATCH_KEY));
    const before = await reg.attestationCount();
    await rpc('evm_setAutomine', [false]);
    let first: { hash: Hex; nonce: number };
    let second: { hash: Hex; nonce: number };
    let firstFee: bigint;
    try {
      first = await reg.sendAttest(attestationParamsFromReport(report, { reportURI: deferred.reportURI }));
      firstFee = (await clients.publicClient.getTransaction({ hash: first.hash })).maxFeePerGas!;
      second = await reg.replaceTransaction(first.hash);
      await mine();
    } finally {
      await rpc('evm_setAutomine', [true]);
    }
    expect(second.nonce).toBe(first.nonce);
    const [a, b] = await Promise.all([clients.publicClient.getTransaction({ hash: first.hash }).catch(() => null), clients.publicClient.getTransaction({ hash: second.hash })]);
    expect(a).toBeNull();
    expect(b.maxFeePerGas).toBe((firstFee! * 125n) / 100n + 1n);
    expect(await reg.attestTx(second.hash)).toMatchObject({ state: 'mined' });
    expect(await reg.attestTx(first.hash)).toEqual({ state: 'unknown' });
    expect(await reg.attestationCount()).toBe(before + 1n);
    expect((await reg.latest(31337n, lower as Address, ERC4626))!.attestation.subject.toLowerCase()).toBe(lower);
  });
});
