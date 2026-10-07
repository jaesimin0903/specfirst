import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  createChainClients,
  demoVaultAbi,
  identifyImplementation,
  parseCheckReport,
  parseFeed,
  registerWebhook,
  summarize,
  watchStateSchema,
  webhookMessage,
  type ChainClients,
  type FeedEvent,
  type RunStandardCheckInput,
  type StandardCheckReport,
} from '@specfirst/core';
import { parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerSubsCommand } from '../src/commands/subs.js';
import { registerWatchCommand } from '../src/commands/watch.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MORPHO = path.resolve(here, '../../core/test/fixtures/attest/morpho-143-109061472.json');
const DEMO_SOURCES = path.resolve(here, '../../../examples/watch/sources-demo.json');
/** Registry and subscriptions owner (also the demo signer and the vault's operator), the subscriber and the watcher's issuer. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const REQUESTER_KEY = ANVIL_KEYS[2] as Hex;
const WATCH_KEY = ANVIL_KEYS[4] as Hex;
const SUBSCRIBER = privateKeyToAccount(REQUESTER_KEY);
const BASE = 'https://example.org/checks';

/**
 * The share value alert end to end on anvil (ADR 0006, "Share value"): a subscribed demo vault with a deposit, its
 * operator's `watch demo loss`, and three `specfirst watch --once` runs: the reference, the fall seen once, the
 * fall confirmed at a later block. The confirmed fall is a changed event, POSTed to the subscriber's webhook as
 * kind price-drop, and queues a re-check, which finds the result unchanged: nothing is attested for the drop.
 */
describe.skipIf(SKIP_ANVIL)('specfirst watch: a share value drop of a subscribed vault', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let sourcesFile: string;
  let server: Server;
  let origin: string;
  let token: Address;
  const hits: Array<{ path: string; body: Record<string, unknown> }> = [];
  const savedEnv = { ...process.env };

  const runCheck = async (input: RunStandardCheckInput): Promise<StandardCheckReport> => {
    const base = JSON.parse(await readFile(MORPHO, 'utf8')) as StandardCheckReport;
    const broken = await clients.publicClient.readContract({ address: input.address, abi: demoVaultAbi, functionName: 'broken', blockNumber: input.blockNumber! });
    const results = base.results.map((r) => (broken && r.id === 'previewDeposit' ? { ...r, status: 'fail' as const, reason: 'previewDeposit promised more shares than deposit minted' } : r));
    const identity = await identifyImplementation(clients.publicClient, input.address, input.blockNumber!);
    return parseCheckReport(JSON.stringify({ ...base, chainId: 31337, address: input.address, blockNumber: input.blockNumber!.toString(), identity, results, summary: summarize(results), startedAt: new Date().toISOString() }));
  };
  const register = (p: import('commander').Command) => {
    registerAttestRegistryCommand(p);
    registerSubsCommand(p);
    // No subscribed cadence in this test: a check runs only when a signal or the drop queues one. The runs follow each
    // other within seconds, so the 30 s between reads of a subscribed vault and the 2 min before a confirmation are off;
    // the 10 blocks of a confirmation are mined.
    registerWatchCommand(p, { runCheck, config: { subscribedMinutes: 600, confirmDelayMs: 0, priceUrgentSec: 0 }, sleep: async () => {} });
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
  const watch = (...extra: string[]) =>
    cli('watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', anvil.url, '--sources', sourcesFile, '--once', '--block-lag', '0', '--sweep-per-hour', '0', '--report-base-url', BASE, ...extra);
  const mine = (blocks = 1) => clients.publicClient.request({ method: 'anvil_mine' as never, params: [`0x${blocks.toString(16)}`] as never });
  const state = async () => watchStateSchema.parse(JSON.parse(await readFile(path.join(dir, '.specfirst/watch/31337/state.json'), 'utf8')));

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-price-'));
    const demo = JSON.parse(await readFile(DEMO_SOURCES, 'utf8')) as { chainId: number };
    sourcesFile = path.join(dir, 'sources-anvil.json');
    await writeFile(sourcesFile, JSON.stringify({ ...demo, chainId: 31337 }));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', body: JSON.parse(body) as Record<string, unknown> });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY, REQUESTER_PRIVATE_KEY: REQUESTER_KEY, WATCH_ISSUER_PRIVATE_KEY: WATCH_KEY, SPECFIRST_LOCK_DIR: path.join(dir, 'locks') });
    for (const k of ['SPECFIRST_ATTEST_REGISTRY_31337', 'SPECFIRST_SUBS_31337', 'SPECFIRST_REPORT_BASE_URL']) delete process.env[k];

    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil');
    expect(reg.code).toBe(0);
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = event(reg, 'attest-registry-deployed').address as string;
    expect((await cli('attest-registry', 'set-issuer', privateKeyToAccount(WATCH_KEY).address, '--network', 'anvil')).code).toBe(0);
    const s = await cli('subs', 'deploy', '--network', 'anvil');
    expect(s.code).toBe(0);
    process.env.SPECFIRST_SUBS_31337 = event(s, 'subs-deployed').address as string;
    const d = await cli('watch', 'demo', 'deploy', '--token', '--network', 'anvil');
    expect(d.code).toBe(0);
    token = event(d, 'watch-demo-deployed').token as Address;
    // The first run sets the cursor, so the next one reads the factory event of the vault below.
    expect((await watch()).code).toBe(0);
  }, 120_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await new Promise((r) => server?.close(r));
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('the flags and the demo command refuse what they cannot use', async () => {
    const zero = await watch('--price-drop-bps', '0');
    expect(zero.code).toBe(19);
    expect(zero.err).toMatch(/--price-drop-bps must be at least 1, got "0"/);
    const bps = await cli('watch', 'demo', 'loss', token, '10000', '--network', 'anvil');
    expect(bps.code).toBe(19);
    expect(bps.err).toMatch(/<bps> must be a whole number of basis points from 1 to 9999, got "10000"/);
    // The token has no setLoss, as a vault of the factory before setLoss has none: said before anything is sent.
    const none = await cli('watch', 'demo', 'loss', token, '42', '--network', 'anvil');
    expect(none.code).toBe(19);
    expect(none.err).toMatch(/has no setLoss: a DemoVault from the factory before setLoss \(0x27eFcf4d95B8AB853b31b65EFB3Adb1cAd93D432\)/);
  });

  it('a loss is a price-drop confirmed at a later block: one changed event, the webhook, a re-check, no attestation', async () => {
    const v = await cli('watch', 'demo', 'vault', '--asset', token, '--network', 'anvil');
    const vault = event(v, 'watch-demo-vault').vault as Address;
    expect((await cli('watch', 'demo', 'deposit', vault, '--asset', token, '--amount', '1', '--network', 'anvil')).code).toBe(0);
    expect((await cli('subs', 'subscribe', vault, '--days', '1', '--subject-chain', '31337', '--network', 'anvil')).code).toBe(0);
    const url = `${origin}/hook`;
    const issued = Math.floor(Date.now() / 1000);
    const signature = await SUBSCRIBER.signMessage({ message: webhookMessage({ subscriber: SUBSCRIBER.address, url, issued }) });
    expect(await registerWebhook(path.join(dir, '.specfirst/watch/webhooks.json'), { subscriber: SUBSCRIBER.address, url, issued, signature }, { allowedLocalOrigins: [origin] })).toMatchObject({ ok: true });
    await mine();

    // First run: found, checked, attested for the subscription; the share value read is the reference.
    const first = await watch('--webhook-local-origin', origin);
    expect(first.err).toBe('');
    expect(event(first, 'watch-start')).toMatchObject({ priceMinutes: 5, priceDropBps: 10, priceAll: false, maxPriceReadsPerMinute: 60, maxPriceDropsPerDay: 4 });
    expect(kinds(fed(first))).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'attested:factory', 'changed:factory', 'alerted:']);
    const reference = (await state()).prices[vault.toLowerCase()]!;
    expect(reference).toMatchObject({ decimals: 18, assetsPerShare: parseEther('1').toString() });
    expect(hits.map((h) => h.body.kind)).toEqual(['change']);

    const loss = await cli('watch', 'demo', 'loss', vault, '42', '--network', 'anvil');
    expect(loss.code).toBe(0);
    expect(event(loss, 'watch-demo-loss')).toMatchObject({ vault, bps: 42, assets: (42n * 10n ** 14n).toString(), changed: true });
    await mine();

    // Second run: the fall is seen once and waits; nothing in the feed, nothing delivered.
    const seen = await watch('--webhook-local-origin', origin);
    expect(seen.err).toBe('');
    expect(fed(seen)).toEqual([]);
    expect(event(seen, 'watch-price')).toMatchObject({ subject: vault, step: 'pending', assetsPerShare: '995800000000000000', referenceAssetsPerShare: parseEther('1').toString(), dropBps: 42 });
    const pendingBlock = (await state()).prices[vault.toLowerCase()]!.drop!.block;
    expect(hits).toHaveLength(1);
    // One block later is not enough to confirm it (review L1): it waits.
    await mine();
    const early = await watch('--webhook-local-origin', origin);
    expect(fed(early)).toEqual([]);
    await mine(10);

    // Third run, 10 blocks after it was seen: confirmed. Delivered as price-drop, re-checked, the re-check attests nothing.
    const confirmed = await watch('--webhook-local-origin', origin);
    expect(confirmed.err).toBe('');
    const feed = fed(confirmed);
    expect(kinds(feed)).toEqual(['changed:price-drop', 'alerted:', 'queued:price-drop', 'checked:price-drop']);
    const toBlock = (await state()).prices[vault.toLowerCase()]!.block;
    expect(BigInt(toBlock)).toBeGreaterThan(BigInt(pendingBlock));
    const change = { kind: 'price-drop', fromAssetsPerShare: parseEther('1').toString(), toAssetsPerShare: '995800000000000000', dropBps: 42, fromBlock: reference.block, toBlock };
    expect(feed[0]).toMatchObject({ subject: vault, block: toBlock, change, reason: `confirmed by a second read at block ${toBlock} after block ${pendingBlock}` });
    expect(feed[1]).toMatchObject({ seq: feed[0]!.seq + 1, alert: { subscriptionId: '0', subscriber: SUBSCRIBER.address, channel: 'webhook', ok: true, status: 204 } });
    expect(feed[2]).toMatchObject({ reason: `share value fell 0.42% between block ${reference.block} and block ${toBlock}` });
    expect(feed[3]!.reason).toBe('not attested [unchanged]: unchanged since attestation 0');
    expect(hits).toHaveLength(2);
    expect(hits[1]!.body).toEqual({
      v: 1,
      kind: 'price-drop',
      key: `price-drop:31337:${vault.toLowerCase()}:${reference.block}`,
      subscriptionId: '0',
      subscriptionIds: ['0'],
      subject: vault,
      chainId: 31337,
      change,
      check: null,
      attestation: null,
      reportURL: null,
    });

    const onDisk = parseFeed(await readFile(path.join(dir, '.specfirst/watch/31337/feed.ndjson'), 'utf8'));
    expect(onDisk.invalid).toBe(0);
    expect(onDisk.events.filter((e) => e.kind === 'attested')).toHaveLength(1);
    expect(onDisk.events.map((e) => e.seq)).toEqual(onDisk.events.map((_, i) => i + 1));
    expect((await state()).attestDay.used).toBe(1);
  });

  it('review L7: a loss that rounds to 0 base units sends nothing, and the output says nothing changed', async () => {
    const empty = event(await cli('watch', 'demo', 'vault', '--asset', token, '--network', 'anvil'), 'watch-demo-vault').vault as Address;
    const nothing = await cli('watch', 'demo', 'loss', empty, '42', '--network', 'anvil');
    expect(nothing.code).toBe(0);
    expect(event(nothing, 'watch-demo-loss')).toMatchObject({ vault: empty, bps: 42, assets: '0', changed: false, totalAssets: '0', txHash: null });
    process.exitCode = undefined;
    const human = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--project', dir, 'watch', 'demo', 'loss', empty, '42', '--network', 'anvil']));
    expect(human.out.join('\n')).toMatch(/nothing changed: 0\.42% of its 0 base units of assets rounds to 0, so the share value stays; nothing sent/);
  });
});
