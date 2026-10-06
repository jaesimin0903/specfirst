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
  webhookMessage,
  type ChainClients,
  type FeedEvent,
  type RunStandardCheckInput,
  type StandardCheckReport,
} from '@specfirst/core';
import type { Address, Hex } from 'viem';
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
/** Registry and subscriptions owner (also the demo signer), the test subscriber and the watcher's own issuer. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const REQUESTER_KEY = ANVIL_KEYS[2] as Hex;
const WATCH_KEY = ANVIL_KEYS[4] as Hex;
const SUBSCRIBER = privateKeyToAccount(REQUESTER_KEY);
const BASE = 'https://example.org/checks';

/**
 * `specfirst watch` with the hooks it builds itself (ADR 0006, Alerts): no SPECFIRST_SUBS_<chainId>, no alerts; with
 * one, the active subscriptions are read from CheckSubscriptions on the attest network and a change is POSTed to the
 * webhook the subscriber registered in <watch dir>/webhooks.json, here a local receiver let through with
 * --webhook-local-origin. anvil is the subject, attest and subscriptions chain; the suite is the Morpho fixture with
 * previewDeposit failing while the demo vault's bug is switched on.
 */
describe.skipIf(SKIP_ANVIL)('specfirst watch with subscriptions and webhooks from the environment', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let sourcesFile: string;
  let server: Server;
  let origin: string;
  let token: Address;
  let vault: Address;
  let subs: Address;
  const hits: Array<{ path: string; userAgent: string | undefined; body: Record<string, unknown> }> = [];
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
    // A subscribed subject is due at every pass and a confirmation at the next one, so the test needs no clock.
    registerWatchCommand(p, { runCheck, config: { subscribedMinutes: 0, confirmDelayMs: 0 }, sleep: async () => {} });
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
  const mine = () => clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-alerts-'));
    const demo = JSON.parse(await readFile(DEMO_SOURCES, 'utf8')) as { chainId: number };
    sourcesFile = path.join(dir, 'sources-anvil.json');
    await writeFile(sourcesFile, JSON.stringify({ ...demo, chainId: 31337 }));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        hits.push({ path: req.url ?? '', userAgent: req.headers['user-agent'], body: JSON.parse(body) as Record<string, unknown> });
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
    const d = await cli('watch', 'demo', 'deploy', '--token', '--network', 'anvil');
    expect(d.code).toBe(0);
    token = event(d, 'watch-demo-deployed').token as Address;
  }, 120_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await new Promise((r) => server?.close(r));
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('without a subscriptions contract there are no hooks; --webhook-local-origin alone or a contract-less address is refused', async () => {
    const r = await watch();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'watch-start')).toMatchObject({ subs: null, webhooks: null, webhookLocalOrigins: [] });

    const alone = await watch('--webhook-local-origin', origin);
    expect(alone.code).toBe(19);
    expect(alone.err).toMatch(/--webhook-local-origin needs a CheckSubscriptions contract: set SPECFIRST_SUBS_31337 or pass --subs <address>/);
    const empty = await watch('--subs', '0x00000000000000000000000000000000000000aa');
    expect(empty.code).toBe(19);
    expect(empty.err).toMatch(/no contract at the subscriptions address 0x00000000000000000000000000000000000000AA on anvil/);

    const s = await cli('subs', 'deploy', '--network', 'anvil');
    expect(s.code).toBe(0);
    subs = event(s, 'subs-deployed').address as Address;
    process.env.SPECFIRST_SUBS_31337 = subs;
    const badOrigin = await watch('--webhook-local-origin', `${origin}/`);
    expect(badOrigin.code).toBe(19);
    expect(badOrigin.err).toMatch(/--webhook-local-origin: allowed local origin ".*\/" is not an exact http\(s\) origin/);
  });

  it('with SPECFIRST_SUBS_<chainId>, a subscribed vault is checked first and its changes reach the registered webhook', async () => {
    const v = await cli('watch', 'demo', 'vault', '--asset', token, '--network', 'anvil');
    vault = event(v, 'watch-demo-vault').vault as Address;
    const sub = await cli('subs', 'subscribe', vault, '--days', '1', '--subject-chain', '31337', '--network', 'anvil');
    expect(sub.code).toBe(0);
    expect(event(sub, 'subs-subscribed')).toMatchObject({ id: '0', subscriber: SUBSCRIBER.address, subject: vault });
    // What the web's POST /api/v1/watch/webhooks does: verify the signed registration and store it in <watch dir>/webhooks.json.
    const url = `${origin}/hook`;
    const issued = Math.floor(Date.now() / 1000);
    const signature = await SUBSCRIBER.signMessage({ message: webhookMessage({ subscriber: SUBSCRIBER.address, url, issued }) });
    const stored = await registerWebhook(path.join(dir, '.specfirst/watch/webhooks.json'), { subscriber: SUBSCRIBER.address, url, issued, signature }, { allowedLocalOrigins: [origin] });
    expect(stored).toMatchObject({ ok: true, stored: true });
    await mine();

    const r = await watch('--webhook-local-origin', origin);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'watch-start')).toMatchObject({ subs, webhooks: '.specfirst/watch/webhooks.json', webhookLocalOrigins: [origin] });
    const feed = fed(r);
    // Known as subscribed when it is found: queued at the subscribed priority and attested as subscribed.
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'attested:factory', 'changed:factory', 'alerted:']);
    expect(feed[2]!.reason).toBe('attesting [subscribed]: first check since a subscription started; no attestation of the subject yet');
    expect(feed[5]).toMatchObject({ seq: feed[4]!.seq + 1, subject: vault, alert: { subscriptionId: '0', subscriber: SUBSCRIBER.address, channel: 'webhook', ok: true, status: 204 } });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ path: '/hook', userAgent: 'specfirst-alerts/1' });
    expect(hits[0]!.body).toEqual({
      v: 1,
      kind: 'change',
      subscriptionId: '0',
      subscriptionIds: ['0'],
      subject: vault,
      chainId: 31337,
      change: feed[4]!.change,
      check: feed[4]!.check,
      attestation: feed[4]!.attestation,
      reportURL: `${BASE}/${feed[4]!.check!.reportPath.slice('certs/checks/'.length)}`,
    });

    // The bug switched on: the subscribed re-check finds the regression, the next one at a later block confirms
    // it; attested and alerted again. Without the origin the local webhook is refused.
    expect((await cli('watch', 'demo', 'set-broken', vault, 'on', '--network', 'anvil')).code).toBe(0);
    await mine();
    expect(kinds(fed(await watch()))).toEqual(['queued:subscribed', 'checked:subscribed', 'queued:subscribed']);
    await mine();
    const refused = fed(await watch());
    expect(kinds(refused)).toEqual(['checked:subscribed', 'attested:subscribed', 'changed:subscribed', 'alerted:']);
    expect(refused[2]!.change).toMatchObject({ kind: 'regressed', to: { failed: ['previewDeposit'] } });
    expect(refused[3]).toMatchObject({ alert: { subscriptionId: '0', ok: false }, reason: 'webhook registration refused: url' });
    expect(hits).toHaveLength(1);

    const onDisk = parseFeed(await readFile(path.join(dir, '.specfirst/watch/31337/feed.ndjson'), 'utf8'));
    expect(onDisk.invalid).toBe(0);
    expect(onDisk.events.map((e) => e.seq)).toEqual(onDisk.events.map((_, i) => i + 1));
  });
});
