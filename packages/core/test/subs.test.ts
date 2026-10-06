import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkSubscriptionsAbi,
  checkSubscriptionsBytecode,
  createSubscriptionSource,
  createWebhookAlertSink,
  deliverWebhookAlerts,
  dueAt,
  isActiveAt,
  readWebhooks,
  refundAt,
  registerWebhook,
  reportUrlOf,
  saveWebhookRegistration,
  settleableAt,
  standardIdOf,
  startedDaysAt,
  SubscriptionsClient,
  verifyWebhookRegistration,
  webhookMessage,
  webhookUrlProblem,
  WebhookStoreError,
  type ActiveSubscription,
  type FeedEvent,
  type Subscription,
  type WebhookRegistration,
} from '../src/index.js';
import * as browserSubs from '../src/subs/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ERC4626 = standardIdOf('erc4626');
const SUBS = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
const VAULT = getAddress('0x802c91d807A8DaCA257c4708ab264B6520964e44');
const OTHER = getAddress('0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E');
const DAY = 86_400n;
const T0 = 1_700_000_000n;
const FEE = 50_000_000_000_000_000n;
/** anvil accounts 2 and 3: a subscriber and someone else. Test keys only. */
const ALICE_KEY: Hex = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const MALLORY_KEY: Hex = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6';
const alice = privateKeyToAccount(ALICE_KEY);
const mallory = privateKeyToAccount(MALLORY_KEY);
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  subscriber: alice.address,
  subjectChainId: 143n,
  subject: VAULT,
  standardId: ERC4626,
  feePerDay: FEE,
  startsAt: T0,
  endsAt: T0 + 10n * DAY,
  paid: 10n * FEE,
  settled: 0n,
  cancelled: false,
  ...over,
});

/** Every non-type import of a module, resolved to a file path or kept as a package name. */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(/^(?:import|export)(?! type)[^;]*? from '([^']+)'/gms)].map((m) => {
    const spec = m[1]!;
    return spec.startsWith('.') ? path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts')) : spec;
  });
}

describe('browser-safe @specfirst/core/subs', () => {
  it('reaches only viem, zod and pure modules: no node:, no file store, no deploy module', () => {
    const seen = new Set<string>();
    const packages = new Set<string>();
    const queue = [path.join(here, '../src/subs/index.ts')];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const dep of importsOf(file)) {
        if (dep.startsWith('/')) queue.push(dep);
        else packages.add(dep);
      }
    }
    expect([...packages].sort()).toEqual(['viem', 'zod']);
    const rel = [...seen].map((f) => path.relative(path.join(here, '../src'), f)).sort();
    expect(rel).toEqual(['chain/chains.ts', 'chain/gas.ts', 'chain/transport.ts', 'subs/alerts.ts', 'subs/artifact.ts', 'subs/client.ts', 'subs/index.ts', 'subs/subscription.ts']);
    const pkg = JSON.parse(readFileSync(path.join(here, '../package.json'), 'utf8')) as { exports: Record<string, { import: string }> };
    expect(pkg.exports['./subs']!.import).toBe('./dist/subs/index.js');
  });

  it('exports the same objects as the package root', () => {
    expect(browserSubs.checkSubscriptionsAbi).toBe(checkSubscriptionsAbi);
    expect(browserSubs.webhookMessage).toBe(webhookMessage);
    expect(browserSubs.SubscriptionsClient).toBe(SubscriptionsClient);
    expect(browserSubs).not.toHaveProperty('createWebhookAlertSink');
  });

  it('the ABI is exactly the ADR 0006 interface', () => {
    const fns = Object.fromEntries(
      checkSubscriptionsAbi.filter((x) => x.type === 'function').map((f) => [f.name, `${f.inputs.map((i) => i.type).join(',')}>${f.outputs.map((o) => o.type).join(',')}`]),
    );
    expect(fns).toEqual({
      subscribe: 'uint64,address,bytes32,uint32>uint256',
      extend: 'uint256,uint32>',
      cancel: 'uint256>',
      settle: 'uint256[]>',
      withdraw: 'address>',
      setFeePerDay: 'uint96>',
      subscriptionOf: 'uint256>tuple',
      subscriptionCount: '>uint256',
      isActive: 'uint256>bool',
      feePerDay: '>uint96',
      owner: '>address',
      earned: '>uint256',
      withdrawn: '>uint256',
      escrowed: '>uint256',
    });
    const payable = checkSubscriptionsAbi.filter((x) => x.type === 'function' && x.stateMutability === 'payable').map((f) => (f as { name: string }).name);
    expect(payable.sort()).toEqual(['extend', 'subscribe']);
    const of = checkSubscriptionsAbi.find((x) => x.type === 'function' && x.name === 'subscriptionOf')!;
    const tuple = (of as { outputs: readonly { components: readonly { name: string; type: string }[] }[] }).outputs[0]!.components;
    expect(tuple.map((c) => `${c.name}:${c.type}`)).toEqual([
      'subscriber:address',
      'subjectChainId:uint64',
      'subject:address',
      'standardId:bytes32',
      'feePerDay:uint96',
      'startsAt:uint64',
      'endsAt:uint64',
      'paid:uint96',
      'settled:uint96',
      'cancelled:bool',
    ]);
    const events = checkSubscriptionsAbi.filter((x) => x.type === 'event').map((e) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''}`).join(',')})`);
    expect(events.sort()).toEqual(
      [
        'Subscribed(uint256 indexed,address indexed,uint64,address indexed,bytes32,uint32,uint96,uint64)',
        'Extended(uint256 indexed,uint32,uint96,uint64)',
        'Cancelled(uint256 indexed,uint96)',
        'Settled(uint256 indexed,uint96)',
        'FeesWithdrawn(address indexed,uint96)',
        'FeePerDaySet(uint96)',
      ].sort(),
    );
    const ctor = checkSubscriptionsAbi.find((x) => x.type === 'constructor')!;
    expect((ctor as { inputs: readonly { type: string }[] }).inputs.map((i) => i.type)).toEqual(['address', 'uint96']);
  });
});

describe('day accounting (mirrors the contract)', () => {
  it('a started day counts: one day at startsAt, the next exactly at the boundary, capped at the run', () => {
    const s = sub();
    expect(startedDaysAt(s, T0)).toBe(1n);
    expect(startedDaysAt(s, T0 + DAY - 1n)).toBe(1n);
    expect(startedDaysAt(s, T0 + DAY)).toBe(2n);
    expect(startedDaysAt(s, T0 + 10n * DAY - 1n)).toBe(10n);
    expect(startedDaysAt(s, T0 + 50n * DAY)).toBe(10n);
    expect(dueAt(s, T0 + DAY)).toBe(2n * FEE);
    expect(settleableAt({ ...s, settled: FEE }, T0 + DAY)).toBe(FEE);
    expect(refundAt(s, T0 + DAY)).toBe(8n * FEE);
    expect(refundAt(s, T0 + 10n * DAY)).toBe(0n);
  });

  it('earlier runs count as started; cancelled subscriptions settle and refund nothing more', () => {
    // 2 days bought, expired, then 3 days bought in a new run starting at T1.
    const T1 = T0 + 5n * DAY;
    const restarted = sub({ startsAt: T1, endsAt: T1 + 3n * DAY, paid: 5n * FEE, settled: FEE });
    expect(dueAt(restarted, T1)).toBe(3n * FEE);
    expect(settleableAt(restarted, T1)).toBe(2n * FEE);
    expect(refundAt(restarted, T1)).toBe(2n * FEE);
    const cancelled = sub({ cancelled: true, settled: 3n * FEE });
    expect(settleableAt(cancelled, T0 + 9n * DAY)).toBe(0n);
    expect(refundAt(cancelled, T0)).toBe(0n);
  });

  it('isActiveAt is !cancelled && now < endsAt', () => {
    expect(isActiveAt(sub(), T0 + 10n * DAY - 1n)).toBe(true);
    expect(isActiveAt(sub(), T0 + 10n * DAY)).toBe(false);
    expect(isActiveAt(sub({ cancelled: true }), T0)).toBe(false);
  });
});

describe('SubscriptionsClient (mocks, no RPC)', () => {
  const DECOY = getAddress('0x00000000000000000000000000000000000000d1');
  const event = (name: string) => checkSubscriptionsAbi.find((x) => x.type === 'event' && x.name === name) as { inputs: readonly { indexed?: boolean }[] };
  const log = (address: Address, eventName: string, args: Record<string, unknown>, data: unknown[]) => ({
    address: address.toLowerCase(),
    topics: encodeEventTopics({ abi: checkSubscriptionsAbi, eventName, args } as never),
    data: encodeAbiParameters(event(eventName).inputs.filter((i) => !i.indexed) as never, data as never),
    blockNumber: 5n,
    logIndex: 0,
    transactionHash: hash(9),
  });
  const subscribedLog = (address: Address, id: bigint) => log(address, 'Subscribed', { id, subscriber: alice.address, subject: VAULT }, [143n, ERC4626, 3, 3n * FEE, T0 + 3n * DAY]);
  const make = (logs: unknown[], read: (fn: string, args: unknown[]) => unknown = () => FEE) => {
    const simulate = vi.fn(async (_call: unknown) => ({ request: {}, result: 999n }));
    const write = vi.fn(async () => hash(9));
    const c = new SubscriptionsClient(
      SUBS,
      {
        readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => read(functionName, args)),
        simulateContract: simulate,
        estimateContractGas: vi.fn(async () => 100_000n),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 5n, gasUsed: 21_000n, effectiveGasPrice: 2n, logs })),
      } as never,
      { account: { address: alice.address }, writeContract: write } as never,
    );
    return { c, simulate, write };
  };

  it('subscribe pays feePerDay x days read first and takes the id from its own Subscribed log', async () => {
    const { c, simulate, write } = make([subscribedLog(DECOY, 7n), subscribedLog(SUBS, 3n)]);
    const out = await c.subscribe({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626, days: 3 });
    expect(out).toMatchObject({ id: 3n, paid: 3n * FEE, endsAt: T0 + 3n * DAY, gasCostWei: 42_000n });
    const call = simulate.mock.calls[0]![0] as { value: bigint; args: unknown[] };
    expect(call.value).toBe(3n * FEE);
    expect(call.args).toEqual([143n, VAULT, ERC4626, 3]);
    expect((write.mock.calls[0] as unknown as [{ gas: bigint }])[0].gas).toBe(120_000n);
    await expect(make([subscribedLog(DECOY, 7n)]).c.subscribe({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626, days: 3 }, 1n)).rejects.toThrow(
      /expected one Subscribed event .* found 0/,
    );
    await expect(c.subscribe({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626, days: 366 })).rejects.toMatchObject({ errorName: 'BadDays' });
    await expect(c.subscribe({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626, days: 1.5 })).rejects.toThrow(/days must be an integer from 1 to 365/);
  });

  it('extend pays at the subscription own fee; cancel and settle read their amounts from the logs', async () => {
    const own = 7n;
    const { c, simulate } = make(
      [log(SUBS, 'Extended', { id: 2n }, [4, 4n * own, T0 + 9n * DAY]), log(SUBS, 'Settled', { id: 2n }, [own]), log(SUBS, 'Cancelled', { id: 2n }, [3n * own])],
      (fn) => (fn === 'subscriptionOf' ? sub({ feePerDay: own }) : FEE),
    );
    expect(await c.extend(2n, 4)).toMatchObject({ paid: 28n, endsAt: T0 + 9n * DAY });
    expect((simulate.mock.calls[0]![0] as { value: bigint }).value).toBe(28n);
    expect(await c.cancel(2n)).toMatchObject({ refund: 21n, settled: 7n });
    expect((await c.settle([2n, 4n])).settled).toEqual([{ id: 2n, amount: 7n }]);
  });

  it('custom errors come back by name; subscriptionOf maps UnknownSubscription', async () => {
    const failing = new SubscriptionsClient(
      SUBS,
      {
        simulateContract: vi.fn(async () => {
          throw Object.assign(new Error('reverted'), { shortMessage: 'reverted', cause: { data: { errorName: 'NotSubscriber' } } });
        }),
        readContract: vi.fn(async () => {
          throw { data: { errorName: 'UnknownSubscription' } };
        }),
      } as never,
      { account: { address: alice.address } } as never,
    );
    await expect(failing.cancel(1n)).rejects.toMatchObject({ name: 'SubscriptionsError', errorName: 'NotSubscriber', message: 'cancel failed (NotSubscriber): reverted' });
    await expect(failing.subscriptionOf(9n)).rejects.toThrow(/no subscription with id 9 \(UnknownSubscription\)/);
    await expect(new SubscriptionsClient(SUBS, {} as never).withdraw(alice.address)).rejects.toThrow(/withdraw needs a wallet client/);
  });
});

describe('listActive and createSubscriptionSource (mock reads)', () => {
  const rows: Subscription[] = [
    sub(), // 0 active
    sub({ cancelled: true }), // 1 cancelled
    sub({ endsAt: T0 + 2n * DAY }), // 2 ends exactly at now: inactive
    sub({ subjectChainId: 10143n }), // 3 another subject chain
    sub({ subject: OTHER, subscriber: mallory.address }), // 4 active
  ];
  const NOW = T0 + 2n * DAY;
  const fake = () => {
    const reads: bigint[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
      readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: [bigint] }) => {
        if (functionName === 'subscriptionCount') return BigInt(rows.length);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        reads.push(args[0]);
        return rows[Number(args[0])];
      }),
      getBlock: vi.fn(async () => ({ timestamp: NOW })),
    };
    return { c: new SubscriptionsClient(SUBS, client as never), reads, max: () => maxInFlight };
  };

  it('keeps the subscriptions of the subject chain that are active at the latest block, in id order', async () => {
    const { c, reads, max } = fake();
    const active = await c.listActive(143, { batchSize: 2, rps: 1000 });
    expect(active.map((a) => a.id)).toEqual([0n, 4n]);
    expect(active[1]).toEqual({ id: 4n, subscriber: mallory.address, subjectChainId: 143n, subject: OTHER, standardId: ERC4626, startsAt: T0, endsAt: T0 + 10n * DAY });
    expect(reads.sort()).toEqual([0n, 1n, 2n, 3n, 4n]);
    expect(max()).toBe(2);
    expect((await c.listActive(10143n, { rps: 1000 })).map((a) => a.id)).toEqual([3n]);
  });

  it('reads at most rps per second, the count and the block included', async () => {
    const { c } = fake();
    const t = Date.now();
    await c.listActive(143, { rps: 4, batchSize: 10 });
    // 7 reads at 4 per second with a burst of 4: the last three wait about 250 ms each.
    expect(Date.now() - t).toBeGreaterThanOrEqual(600);
  });

  it('the source does not read a subscription again once it has seen it cancelled', async () => {
    const { c, reads } = fake();
    const source = createSubscriptionSource(c, { rps: 1000 });
    expect((await source.active(143)).map((a) => a.id)).toEqual([0n, 4n]);
    reads.length = 0;
    expect((await source.active(143)).map((a) => a.id)).toEqual([0n, 4n]);
    expect(reads.sort()).toEqual([0n, 2n, 3n, 4n]);
  });
});

describe('webhook registration', () => {
  const NOW = 1_759_750_000;
  const URL_ = 'https://hooks.example.org/specfirst?token=abc';
  const register = async (over: Partial<{ url: string; issued: number; signer: typeof alice; subscriber: string }> = {}) => {
    const signer = over.signer ?? alice;
    const url = over.url ?? URL_;
    const issued = over.issued ?? NOW;
    const subscriber = over.subscriber ?? alice.address;
    return { subscriber, url, issued, signature: await signer.signMessage({ message: webhookMessage({ subscriber, url, issued }) }) };
  };

  it('the message is exactly the ADR text, with the checksummed address', () => {
    expect(webhookMessage({ subscriber: alice.address.toLowerCase(), url: URL_, issued: NOW })).toBe(
      `Specfirst alerts webhook\nsubscriber: ${alice.address}\nurl: ${URL_}\nissued: ${NOW}`,
    );
    expect(() => webhookMessage({ subscriber: alice.address, url: URL_, issued: -1 })).toThrow(/unix seconds/);
  });

  it('accepts the subscriber signature, in any address case, at most 600 s old and 60 s ahead', async () => {
    const good = await verifyWebhookRegistration(await register(), { now: NOW });
    expect(good).toEqual({ ok: true, registration: await register() });
    const lower = await verifyWebhookRegistration({ ...(await register()), subscriber: alice.address.toLowerCase() }, { now: NOW });
    expect(lower.ok && lower.registration.subscriber).toBe(alice.address);
    expect((await verifyWebhookRegistration(await register(), { now: NOW + 600 })).ok).toBe(true);
    expect((await verifyWebhookRegistration(await register(), { now: NOW - 60 })).ok).toBe(true);
  });

  it('refuses a wrong signer, a stale or future issued, a broken signature and a bad shape', async () => {
    expect(await verifyWebhookRegistration(await register({ signer: mallory }), { now: NOW })).toMatchObject({ ok: false, reason: 'signature' });
    // Signed for another url: the signature does not cover the stored one.
    expect(await verifyWebhookRegistration({ ...(await register()), url: 'https://evil.example.org/' }, { now: NOW })).toMatchObject({ ok: false, reason: 'signature' });
    expect(await verifyWebhookRegistration(await register(), { now: NOW + 601 })).toMatchObject({ ok: false, reason: 'stale', message: 'issued 601 s ago, more than 600 s' });
    expect(await verifyWebhookRegistration(await register(), { now: NOW - 61 })).toMatchObject({ ok: false, reason: 'future' });
    expect(await verifyWebhookRegistration({ ...(await register()), signature: '0x1234' }, { now: NOW })).toMatchObject({ ok: false, reason: 'signature' });
    expect(await verifyWebhookRegistration({ ...(await register()), issued: '1' }, { now: NOW })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWebhookRegistration({ ...(await register()), extra: 1 }, { now: NOW })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWebhookRegistration(null)).toMatchObject({ ok: false, reason: 'invalid' });
    // The age is not checked for registrations read back from the store.
    expect((await verifyWebhookRegistration(await register(), { now: NOW + 86_400, ignoreAge: true })).ok).toBe(true);
  });

  it('only https to a public host; http and https to localhost and 127.0.0.1 only with allowLocalHttp', async () => {
    expect(await verifyWebhookRegistration(await register({ url: 'http://hooks.example.org/x' }), { now: NOW })).toMatchObject({ ok: false, reason: 'url', message: 'url not https' });
    expect(webhookUrlProblem('ftp://hooks.example.org/')).toBe('not https');
    expect(webhookUrlProblem('http://localhost:8080/hook')).toBe('not https');
    expect(webhookUrlProblem('http://localhost:8080/hook', { allowLocalHttp: true })).toBeNull();
    expect(webhookUrlProblem('http://127.0.0.1:8080/hook', { allowLocalHttp: true })).toBeNull();
    expect(webhookUrlProblem('http://10.0.0.1/hook', { allowLocalHttp: true })).toBe('not https');
    for (const u of ['https://127.0.0.1/', 'https://localhost/', 'https://10.1.2.3/', 'https://192.168.1.1/', 'https://172.20.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://[fd00::1]/', 'https://2130706433/', 'https://a.localhost/']) {
      expect(webhookUrlProblem(u), u).toBe('points at a private or loopback address');
    }
    expect(webhookUrlProblem('https://172.32.0.1/')).toBeNull();
    expect(webhookUrlProblem('https://user:pw@hooks.example.org/')).toBe('carries credentials');
    expect(webhookUrlProblem('https://hooks.example.org/\nissued: 1')).toBe('contains whitespace or control characters');
    expect(webhookUrlProblem('https://hooks.example.org/a b')).toBe('contains whitespace or control characters');
    expect(webhookUrlProblem(`https://hooks.example.org/${'a'.repeat(2048)}`)).toBe('longer than 2048 characters');
    expect(webhookUrlProblem('not a url')).toBe('contains whitespace or control characters');
    expect(webhookUrlProblem('hooks.example.org')).toBe('not a URL');
  });
});

describe('webhooks.json store', () => {
  let dir: string;
  let file: string;
  const NOW = 1_759_750_000;
  const reg = async (signer: typeof alice, issued: number, url = 'https://hooks.example.org/a'): Promise<WebhookRegistration> => ({
    subscriber: signer.address,
    url,
    issued,
    signature: await signer.signMessage({ message: webhookMessage({ subscriber: signer.address, url, issued }) }),
  });
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-webhooks-'));
    file = path.join(dir, 'watch', '143', 'webhooks.json');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a missing file is empty; register verifies and stores, keyed by the lowercase subscriber', async () => {
    expect(await readWebhooks(file)).toEqual({ v: 1, webhooks: {} });
    const r = await reg(alice, NOW);
    expect(await registerWebhook(file, { ...r, subscriber: alice.address.toLowerCase() }, { now: NOW })).toEqual({ ok: true, registration: r, stored: true, previous: null });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ v: 1, webhooks: { [alice.address.toLowerCase()]: r } });
    expect(await registerWebhook(file, await reg(mallory, NOW).then((m) => ({ ...m, subscriber: alice.address })), { now: NOW })).toMatchObject({ ok: false, reason: 'signature' });
    expect(await registerWebhook(file, r, { now: NOW + 601 })).toMatchObject({ ok: false, reason: 'stale' });
    expect(await readdir(path.dirname(file))).toEqual(['webhooks.json']);
  });

  it('the latest registration per subscriber wins; an older one replayed is not stored', async () => {
    const first = await reg(alice, NOW, 'https://hooks.example.org/first');
    const second = await reg(alice, NOW + 30, 'https://hooks.example.org/second');
    await saveWebhookRegistration(file, first);
    expect(await saveWebhookRegistration(file, second)).toEqual({ stored: true, previous: first });
    expect(await saveWebhookRegistration(file, first)).toEqual({ stored: false, current: second });
    expect((await readWebhooks(file)).webhooks[alice.address.toLowerCase()]).toEqual(second);
  });

  it('concurrent registrations of two subscribers are both kept', async () => {
    const [a, m] = await Promise.all([reg(alice, NOW), reg(mallory, NOW)]);
    await Promise.all([saveWebhookRegistration(file, a), saveWebhookRegistration(file, m)]);
    expect(Object.keys((await readWebhooks(file)).webhooks).sort()).toEqual([alice.address.toLowerCase(), mallory.address.toLowerCase()].sort());
  });

  it('refuses a broken file instead of overwriting it', async () => {
    await saveWebhookRegistration(file, await reg(alice, NOW));
    await writeFile(file, '{"v":1,"webhooks":{"0xabc":{}}}');
    await expect(readWebhooks(file)).rejects.toBeInstanceOf(WebhookStoreError);
    await expect(saveWebhookRegistration(file, await reg(mallory, NOW))).rejects.toThrow(/webhooks .* is invalid/);
    await writeFile(file, 'nope');
    await expect(readWebhooks(file)).rejects.toThrow(/is not readable JSON/);
  });
});

describe('webhook delivery against a local HTTP server', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  const hits: Array<{ path: string; headers: IncomingMessage['headers']; body: string }> = [];
  const NOW = Math.floor(Date.now() / 1000);
  const changed: FeedEvent = {
    v: 1,
    seq: 41,
    at: '2026-10-06T10:00:00.000Z',
    kind: 'changed',
    chainId: 143,
    subject: VAULT,
    source: 'sweep',
    check: {
      block: '110977300',
      summary: { pass: 28, fail: 1, inconclusive: 1, notApplicable: 0 },
      failed: ['erc4626-redeem-rounding'],
      implementationKey: hash(7),
      reportPath: `certs/checks/143/${VAULT.toLowerCase()}/110977300-0011223344556677.json`,
      reportHash: hash(8),
      durationMs: 91_000,
    },
    attestation: { id: '20', txHash: hash(9), supersedes: '18' },
    change: {
      kind: 'regressed',
      from: { summary: { pass: 29, fail: 0, inconclusive: 1, notApplicable: 0 }, failed: [] },
      to: { summary: { pass: 28, fail: 1, inconclusive: 1, notApplicable: 0 }, failed: ['erc4626-redeem-rounding'] },
    },
  };
  const active = (id: bigint, subscriber: Address, subject: Address = VAULT): ActiveSubscription => ({
    id,
    subscriber,
    subjectChainId: 143n,
    subject,
    standardId: ERC4626,
    startsAt: T0,
    endsAt: T0 + 30n * DAY,
  });
  const reg = async (signer: typeof alice, url: string): Promise<WebhookRegistration> => ({
    subscriber: signer.address,
    url,
    issued: NOW,
    signature: await signer.signMessage({ message: webhookMessage({ subscriber: signer.address, url, issued: NOW }) }),
  });
  const delays: number[] = [];
  const opts = { fetch: globalThis.fetch as never, allowLocalHttp: true, reportBaseUrl: 'https://raw.example.org/certs/checks/', sleep: async (ms: number) => void delays.push(ms), now: () => new Date('2026-10-06T10:00:05.000Z') };

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        hits.push({ path: req.url!, headers: req.headers, body });
        handler(req, res, body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-alerts-'));
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    hits.length = 0;
    delays.length = 0;
    handler = (_req, res) => res.writeHead(204).end();
  });

  it('POSTs the ADR payload as JSON to each registered subscriber of the subject and returns alerted events', async () => {
    const regs = { [alice.address.toLowerCase()]: await reg(alice, `${base}/alice`), [mallory.address.toLowerCase()]: await reg(mallory, `${base}/mallory`) };
    const subs = [active(3n, alice.address), active(5n, mallory.address), active(6n, alice.address, OTHER), active(7n, getAddress('0x00000000000000000000000000000000000000e1'))];
    const out = await deliverWebhookAlerts(changed, subs, regs, opts);
    expect(hits.map((h) => h.path).sort()).toEqual(['/alice', '/mallory']);
    const body = JSON.parse(hits.find((h) => h.path === '/alice')!.body);
    expect(body).toEqual({
      v: 1,
      subscriptionId: '3',
      subject: VAULT,
      chainId: 143,
      change: changed.change,
      check: changed.check,
      attestation: changed.attestation,
      reportURL: `https://raw.example.org/certs/checks/143/${VAULT.toLowerCase()}/110977300-0011223344556677.json`,
    });
    expect(hits[0]!.headers['content-type']).toBe('application/json');
    expect(hits[0]!.headers['user-agent']).toBe('specfirst-alerts/1');
    expect(out).toEqual([
      { v: 1, seq: 41, at: '2026-10-06T10:00:05.000Z', kind: 'alerted', chainId: 143, subject: VAULT, alert: { subscriptionId: '3', subscriber: alice.address, channel: 'webhook', ok: true, status: 204 } },
      { v: 1, seq: 41, at: '2026-10-06T10:00:05.000Z', kind: 'alerted', chainId: 143, subject: VAULT, alert: { subscriptionId: '5', subscriber: mallory.address, channel: 'webhook', ok: true, status: 204 } },
    ]);
    expect(delays).toEqual([]);
  });

  it('retries server errors with backoff and gives up after 3 attempts; the reason never carries the URL', async () => {
    const regs = { [alice.address.toLowerCase()]: await reg(alice, `${base}/secret-token-123`) };
    let n = 0;
    handler = (_req, res) => res.writeHead(++n < 3 ? 500 : 200).end();
    const [ok] = await deliverWebhookAlerts(changed, [active(3n, alice.address)], regs, opts);
    expect(ok!.alert).toMatchObject({ ok: true, status: 200 });
    expect(hits).toHaveLength(3);
    expect(delays).toEqual([1_000, 4_000]);

    hits.length = 0;
    handler = (_req, res) => res.writeHead(503).end();
    const [failed] = await deliverWebhookAlerts(changed, [active(3n, alice.address)], regs, opts);
    expect(failed).toMatchObject({ kind: 'alerted', alert: { ok: false, status: 503 }, reason: 'HTTP 503 after 3 attempts' });
    expect(hits).toHaveLength(3);
    expect(JSON.stringify(failed)).not.toMatch(/secret-token|127\.0\.0\.1/);
  });

  it('does not retry a 4xx and does not follow a redirect', async () => {
    const regs = { [alice.address.toLowerCase()]: await reg(alice, `${base}/gone`) };
    handler = (_req, res) => res.writeHead(404).end();
    const [gone] = await deliverWebhookAlerts(changed, [active(3n, alice.address)], regs, opts);
    expect(gone).toMatchObject({ alert: { ok: false, status: 404 }, reason: 'HTTP 404 after 1 attempt' });
    expect(hits).toHaveLength(1);

    hits.length = 0;
    handler = (req, res) => (req.url === '/gone' ? res.writeHead(302, { location: `${base}/elsewhere` }).end() : res.writeHead(200).end());
    const [moved] = await deliverWebhookAlerts(changed, [active(3n, alice.address)], regs, opts);
    expect(moved).toMatchObject({ alert: { ok: false, status: 302 } });
    expect(hits.map((h) => h.path)).toEqual(['/gone']);
  });

  it('a webhook that never answers times out on every attempt', async () => {
    const regs = { [alice.address.toLowerCase()]: await reg(alice, `${base}/slow`) };
    handler = () => {};
    const [slow] = await deliverWebhookAlerts(changed, [active(3n, alice.address)], regs, { ...opts, timeoutMs: 100 });
    expect(slow).toMatchObject({ alert: { ok: false }, reason: 'no answer within 100 ms after 3 attempts' });
    expect(slow!.alert).not.toHaveProperty('status');
    expect(hits).toHaveLength(3);
  });

  it('delivers only changed events, and not to a registration that no longer verifies or URL policy refuses', async () => {
    const tampered = { ...(await reg(alice, `${base}/alice`)), url: `${base}/other` };
    const regs = { [alice.address.toLowerCase()]: tampered, [mallory.address.toLowerCase()]: await reg(mallory, `${base}/mallory`) };
    expect(await deliverWebhookAlerts({ ...changed, kind: 'checked' }, [active(3n, alice.address)], regs, opts)).toEqual([]);
    const both = [active(3n, alice.address), active(5n, mallory.address)];
    const out = await deliverWebhookAlerts(changed, both, regs, opts);
    expect(out.map((e) => [e.alert!.subscriptionId, e.alert!.ok, e.reason])).toEqual([
      ['3', false, 'webhook registration refused: signature'],
      ['5', true, undefined],
    ]);
    // The same http://127.0.0.1 registration is refused once local http is not allowed.
    const strict = await deliverWebhookAlerts(changed, both, regs, { ...opts, allowLocalHttp: false });
    expect(strict[1]).toMatchObject({ alert: { subscriptionId: '5', ok: false }, reason: 'webhook registration refused: url' });
    expect(hits.map((h) => h.path)).toEqual(['/mallory']);
  });

  it('createWebhookAlertSink reads webhooks.json for every event; no file, no alerts', async () => {
    const file = path.join(dir, 'webhooks.json');
    const sink = createWebhookAlertSink({ webhooksFile: file, allowLocalHttp: true, reportBaseUrl: 'https://raw.example.org/certs/checks', sleep: async () => {} });
    expect(await sink.deliver(changed, [active(3n, alice.address)])).toEqual([]);
    await saveWebhookRegistration(file, await reg(alice, `${base}/alice`));
    const out = await sink.deliver(changed, [active(3n, alice.address)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.alert).toMatchObject({ subscriptionId: '3', ok: true, status: 204 });
    expect(hits.map((h) => h.path)).toEqual(['/alice']);
  });

  it('reportUrlOf maps certs/checks paths under the base and nothing else', () => {
    expect(reportUrlOf('certs/checks/143/0xab/1-00.json', 'https://x.org/certs/checks/')).toBe('https://x.org/certs/checks/143/0xab/1-00.json');
    expect(reportUrlOf('.specfirst/checks/143/0xab/1.json', 'https://x.org')).toBeNull();
    expect(reportUrlOf('certs/checks/../../etc/passwd', 'https://x.org')).toBeNull();
    expect(reportUrlOf(undefined, 'https://x.org')).toBeNull();
    expect(reportUrlOf('certs/checks/143/a.json', undefined)).toBeNull();
  });
});

describe('bundled CheckSubscriptions artifact', () => {
  const contracts = path.resolve(here, '../../contracts');
  const built = path.join(contracts, 'out/CheckSubscriptions.sol/CheckSubscriptions.json');
  // Skipped only when forge is not installed; with forge the build runs here, so a stale artifact fails.
  const hasForge = spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasForge)('matches a fresh forge build (regenerate with scripts/gen-subs-artifact.mjs)', () => {
    const build = spawnSync('forge', ['build'], { cwd: contracts, encoding: 'utf8', timeout: 240_000 });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const art = JSON.parse(readFileSync(built, 'utf8')) as { abi: unknown; bytecode: { object: string } };
    expect(checkSubscriptionsAbi).toEqual(art.abi);
    expect(checkSubscriptionsBytecode).toBe(art.bytecode.object);
  }, 300_000);
});
