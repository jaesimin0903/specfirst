import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ContractReader } from '../lib/desk/read';

/*
 * The watch API routes end to end on the synthetic fixtures: the watcher's files copied into a temp watch dir
 * (the routes write webhooks.json and demo-hook.json there), the fixture reports as the checks directory, an empty
 * board build, and a mocked Monad testnet that answers CheckSubscriptions and has no attestation for anything.
 */

const reader = vi.hoisted(() => ({ current: null as unknown as ContractReader }));
vi.mock('../lib/desk/clients', () => ({ testnetClient: () => reader.current, mainnetClient: () => reader.current }));

import { clearMemo } from '../lib/desk/cache';
import { clearWatchCaches } from '../lib/watch/read';
import { clearReportCache } from '../lib/watch/reports';
import { webhookMessage, webhookPayload } from '../lib/subs/core';
import type { FeedPageJson, VaultWatchJson, WatchStatusJson } from '../lib/watch/types';
import type { InboxJson, SubscriberJson, SubsSummaryJson } from '../lib/subs/types';
import type { ExplorerRow } from '../lib/board/view';
import { GET as statusRoute } from '../app/api/v1/watch/status/route';
import { GET as feedRoute } from '../app/api/v1/watch/feed/route';
import { GET as vaultRoute } from '../app/api/v1/watch/vaults/[chainId]/[address]/route';
import { GET as overlayRoute } from '../app/api/v1/watch/overlay/route';
import { GET as inboxRoute } from '../app/api/v1/watch/inbox/route';
import { GET as webhookGet, POST as webhookPost } from '../app/api/v1/watch/webhooks/route';
import { GET as demoGet, POST as demoPost } from '../app/api/v1/watch/demo-hook/route';
import { GET as subsRoute } from '../app/api/v1/watch/subs/route';
import { GET as subscriberRoute } from '../app/api/v1/watch/subs/[subscriber]/route';
import { revenueView } from '../lib/subs/revenue';
import type { DeskViewJson } from '../lib/desk/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures/watch');
const MORPHO = '0xfeed000000000000000000000000000000000001';
const UPGRADED = '0xfeed000000000000000000000000000000000003';
const SUBS = '0x0000000000000000000000000000000000005005';
const burner = privateKeyToAccount(keccak256(toHex('watch-web api test burner')));
const OTHER = '0x0000000000000000000000000000000000000abc';
const FEE = 10n ** 16n;
const NOW = Math.floor(Date.now() / 1000);
const fixtureSec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

let root: string;
const env = { ...process.env };

function subscription(subscriber: string, subject: string, startsAt: number, over: Record<string, unknown> = {}) {
  return {
    subscriber,
    subjectChainId: 143n,
    subject,
    standardId: keccak256(toHex('erc4626')),
    feePerDay: FEE,
    startsAt: BigInt(startsAt),
    endsAt: BigInt(NOW + 30 * 86_400),
    paid: FEE * 30n,
    settled: 0n,
    cancelled: false,
    ...over,
  };
}

function noAttestation() {
  const err = new Error('reverted') as Error & { data: { errorName: string } };
  err.data = { errorName: 'NoAttestation' };
  return err;
}

const get = (url: string) => new Request(`http://localhost${url}`);
const json = async <T>(r: Response) => (await r.json()) as T;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sf-watch-api-'));
  await mkdir(path.join(root, 'watch'), { recursive: true });
  await cp(path.join(FIXTURES, '143'), path.join(root, 'watch', '143'), { recursive: true });
  await mkdir(path.join(root, 'board'), { recursive: true });
  await writeFile(
    path.join(root, 'board', 'vault-meta.json'),
    JSON.stringify({ '143': { [UPGRADED]: { name: 'Listed upgraded vault', protocol: 'Curvance', assetSymbol: 'USDC' } } }),
  );
  const feed = (await readFile(path.join(FIXTURES, '143', 'feed.ndjson'), 'utf8')).split('\n').filter((l) => l.startsWith('{"v":1,"seq":'));
  const started = fixtureSec(JSON.parse(feed[10]!).at);
  const subs = [
    subscription(OTHER, MORPHO, started),
    subscription(burner.address, UPGRADED, started, { cancelled: true }),
    subscription(burner.address, MORPHO, started),
    subscription(burner.address, UPGRADED, fixtureSec(JSON.parse(feed[0]!).at)),
  ];
  reader.current = {
    async readContract({ functionName, args }) {
      switch (functionName) {
        case 'feePerDay':
          return FEE;
        case 'subscriptionCount':
          return BigInt(subs.length);
        case 'earned':
          return 3n * FEE;
        case 'withdrawn':
          return 0n;
        case 'escrowed':
          return 90n * FEE;
        case 'owner':
          return OTHER;
        case 'subscriptionOf':
          return subs[Number(args![0])];
        case 'latest':
          throw noAttestation();
        case 'isCompliant':
          return false;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    },
  };
  Object.assign(process.env, {
    SPECFIRST_WATCH_DIR: path.join(root, 'watch'),
    SPECFIRST_CHECKS_DIR: path.join(FIXTURES, 'checks'),
    SPECFIRST_BOARD_DATA: path.join(root, 'board'),
    NEXT_PUBLIC_SPECFIRST_SUBS_10143: SUBS,
  });
});

afterAll(async () => {
  process.env = env;
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  clearMemo();
  clearWatchCaches();
  clearReportCache();
});

describe('GET /api/v1/watch/status', () => {
  it('reports the head, how far behind, what runs, the queue, sources and the headline count', async () => {
    const s = await json<WatchStatusJson>(await statusRoute(get('/api/v1/watch/status')));
    expect(s).toMatchObject({
      chainId: 143,
      chains: [143],
      running: true,
      problem: null,
      head: '110977320',
      behindBlocks: 30,
      behindSeconds: 12,
      queueLength: 2,
      gasCostWei: '208000000000000000',
    });
    expect(s.now).toMatchObject({ stage: 'checking', label: { protocol: 'Morpho MetaMorpho V1.1', onList: false } });
    expect(s.sources).toHaveLength(8);
    expect(s.found).toEqual({ watched: 6, notOnList: 5, notOnBoard: 6, listSize: 1 });
    expect(s.feed).toMatchObject({ available: true, events: 33, latestSeq: 33, skipped: 2 });
  });

  it('a chain the watcher does not watch is "not running", not an error', async () => {
    const s = await json<WatchStatusJson>(await statusRoute(get('/api/v1/watch/status?chainId=10143')));
    expect(s).toMatchObject({ chainId: 10143, running: false, problem: 'not running', found: { watched: 0 } });
  });
});

describe('GET /api/v1/watch/feed', () => {
  it('newest first, with the 30 results of each check read from its report and the hash checked', async () => {
    const p = await json<FeedPageJson>(await feedRoute(get('/api/v1/watch/feed?limit=40')));
    expect(p.events).toHaveLength(33);
    expect(p.events[0]!.seq).toBe(33);
    expect(p).toMatchObject({ latestSeq: 33, hasOlder: false, skipped: 2 });
    const checks = p.events.filter((e) => e.kind === 'checked');
    expect(checks).toHaveLength(6);
    for (const c of checks) {
      expect(c.check!.cells).toHaveLength(30);
      expect(c.check!.reportMatches).toBe(true);
      expect(c.check!.reportUrl).toMatch(/^\/api\/v1\/reports\/143\/0xfeed0+\d\/\d+-[0-9a-f]{16}\.json$/);
    }
    const factoryCheck = checks.find((c) => c.found?.source === 'factory')!;
    expect(factoryCheck.found).toMatchObject({ deployBlock: '110930586', factory: { name: 'Morpho VaultV2Factory' } });
  });

  it('pages with before and polls with after', async () => {
    const older = await json<FeedPageJson>(await feedRoute(get('/api/v1/watch/feed?before=10&limit=4')));
    expect(older.events.map((e) => e.seq)).toEqual([9, 8, 7, 6]);
    expect(older.hasOlder).toBe(true);
    const newer = await json<FeedPageJson>(await feedRoute(get('/api/v1/watch/feed?after=31')));
    expect(newer.events.map((e) => e.seq)).toEqual([33, 32]);
    expect(newer.gap).toBe(false);
  });
});

describe('GET /api/v1/watch/vaults/<chainId>/<address>', () => {
  it("a vault's record and history, newest first", async () => {
    const v = await json<VaultWatchJson>(await vaultRoute(get('/x'), { params: Promise.resolve({ chainId: '143', address: MORPHO }) }));
    expect(v).toMatchObject({
      watched: true,
      lastAttestationId: '44',
      found: { source: 'factory', deployBlock: '110930586', firstDepositBlock: '110962000' },
      lastCheck: { status: 'complete' },
    });
    expect(v.history.map((e) => e.kind)).toEqual([
      'checked',
      'alerted',
      'changed',
      'attested',
      'checked',
      'queued',
      'changed',
      'attested',
      'checked',
      'queued',
      'detected',
    ]);
  });

  it('404 for a vault the watcher never saw, 400 for junk', async () => {
    expect((await vaultRoute(get('/x'), { params: Promise.resolve({ chainId: '143', address: OTHER }) })).status).toBe(404);
    expect((await vaultRoute(get('/x'), { params: Promise.resolve({ chainId: 'main', address: OTHER }) })).status).toBe(400);
  });
});

describe('GET /api/v1/watch/overlay', () => {
  it('board rows for the found vaults that have a report, marked with how they were found', async () => {
    const { rows } = await json<{ rows: ExplorerRow[] }>(await overlayRoute());
    expect(rows.map((r) => r.id).sort()).toEqual([`143/${MORPHO}`, `143/0xfeed000000000000000000000000000000000002`, `143/${UPGRADED}`]);
    const morpho = rows.find((r) => r.id === `143/${MORPHO}`)!;
    expect(morpho).toMatchObject({
      status: 'complete',
      protocol: 'Morpho Vault V2',
      attestation: { kind: 'none' },
      found: { sourceText: 'from Morpho VaultV2Factory', block: '110930586' },
    });
    expect(morpho.cells).toBe('p'.repeat(30));
    expect(rows.find((r) => r.id === `143/${UPGRADED}`)).toMatchObject({
      name: 'Listed upgraded vault',
      status: 'mismatch',
      found: { sourceText: 'backfill scan' },
    });
  });
});

describe('subscriptions and the inbox', () => {
  it('the summary reads the contract; a subscriber sees only their own, with a refund estimate', async () => {
    const s = await json<SubsSummaryJson>(await subsRoute());
    expect(s).toMatchObject({ deployed: true, address: SUBS, feePerDayWei: FEE.toString(), count: '4', escrowedWei: (90n * FEE).toString() });
    const mine = await json<SubscriberJson>(await subscriberRoute(get('/x'), { params: Promise.resolve({ subscriber: burner.address.toLowerCase() }) }));
    expect(mine.subscriptions.map((x) => [x.id, x.active])).toEqual([
      ['3', true],
      ['2', true],
      ['1', false],
    ]);
    expect(BigInt(mine.subscriptions[0]!.refundEstimateWei)).toBeGreaterThan(0n);
    expect(mine.subscriptions[0]!.label).toMatchObject({ name: 'Listed upgraded vault', onList: true });
  });

  it('the inbox lists changes, first checks and deliveries for active subscriptions only', async () => {
    const r = await json<InboxJson>(await inboxRoute(get(`/api/v1/watch/inbox?subscriber=${burner.address}`)));
    expect(r.active.map((x) => x.id)).toEqual(['3', '2']);
    expect(r.ended).toBe(1);
    expect(r.items.map((i) => `${i.subscriptionId}:${i.kind}`)).toEqual([
      '2:delivery',
      '2:change',
      '2:first-check',
      '3:delivery',
      '3:delivery',
      '3:change',
      '3:first-check',
    ]);
    expect(r.items[1]!.event.change).toMatchObject({ kind: 'changed', from: { status: 'partial' }, to: { status: 'complete' } });
    expect((await inboxRoute(get('/api/v1/watch/inbox?subscriber=me'))).status).toBe(400);
  });

  it('with the contract unset, everything says not deployed', async () => {
    delete process.env.NEXT_PUBLIC_SPECFIRST_SUBS_10143;
    try {
      expect(await json<SubsSummaryJson>(await subsRoute())).toMatchObject({ deployed: false, address: null });
      expect(await json<InboxJson>(await inboxRoute(get(`/api/v1/watch/inbox?subscriber=${burner.address}`)))).toMatchObject({ deployed: false, items: [] });
    } finally {
      process.env.NEXT_PUBLIC_SPECFIRST_SUBS_10143 = SUBS;
    }
  });
});

describe('webhooks', () => {
  const post = (body: unknown) =>
    new Request('http://localhost/api/v1/watch/webhooks', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('stores a signed registration in <watch dir>/webhooks.json and serves it back', async () => {
    const issued = Math.floor(Date.now() / 1000);
    const url = 'https://hooks.example.com/specfirst';
    const signature = await burner.signMessage({ message: webhookMessage({ subscriber: burner.address, url, issued }) });
    const res = await webhookPost(post({ subscriber: burner.address, url, issued, signature }));
    expect(res.status).toBe(200);
    const file = JSON.parse(await readFile(path.join(root, 'watch', 'webhooks.json'), 'utf8'));
    expect(file.webhooks[burner.address.toLowerCase()]).toEqual({ subscriber: burner.address, url, issued, signature });
    // The full URL can be a secret: the API shows its origin only.
    const back = await json<{ webhook: Record<string, unknown> }>(await webhookGet(get(`/api/v1/watch/webhooks?subscriber=${burner.address}`)));
    expect(back.webhook).toEqual({ origin: 'https://hooks.example.com', issued });
    const inbox = await json<InboxJson>(await inboxRoute(get(`/api/v1/watch/inbox?subscriber=${burner.address}`)));
    expect(inbox.webhook).toEqual({ origin: 'https://hooks.example.com', issued });
    expect(JSON.stringify(inbox)).not.toContain('/specfirst');
  });

  it("a local URL registers only with the flag, and only at this site's own origin", async () => {
    const issued = Math.floor(Date.now() / 1000);
    const sign = async (url: string) => ({
      subscriber: burner.address,
      url,
      issued,
      signature: await burner.signMessage({ message: webhookMessage({ subscriber: burner.address, url, issued }) }),
    });
    const at = (origin: string, body: unknown) => new Request(`${origin}/api/v1/watch/webhooks`, { method: 'POST', body: JSON.stringify(body) });
    const own = await sign('http://localhost:3418/api/v1/watch/demo-hook');
    expect((await webhookPost(at('http://localhost:3418', own))).status).toBe(400);
    process.env.SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS = '1';
    try {
      expect((await webhookPost(at('http://localhost:3418', own))).status).toBe(200);
      const elsewhere = await webhookPost(at('http://localhost:3418', await sign('http://localhost:9999/hook')));
      expect(elsewhere.status).toBe(400);
      expect(await json<{ reason: string; error: string }>(elsewhere)).toMatchObject({ reason: 'url', error: 'url not https' });
    } finally {
      delete process.env.SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS;
    }
  });

  it('needs an active subscription: none is 409, contract unset is 503', async () => {
    const stranger = privateKeyToAccount(keccak256(toHex('watch-web api test stranger')));
    const issued = Math.floor(Date.now() / 1000);
    const url = 'https://hooks.example.com/stranger';
    const reg = {
      subscriber: stranger.address,
      url,
      issued,
      signature: await stranger.signMessage({ message: webhookMessage({ subscriber: stranger.address, url, issued }) }),
    };
    const none = await webhookPost(post(reg));
    expect(none.status).toBe(409);
    expect((await json<{ error: string }>(none)).error).toMatch(/holds no active subscription/);
    delete process.env.NEXT_PUBLIC_SPECFIRST_SUBS_10143;
    try {
      const off = await webhookPost(post(reg));
      expect(off.status).toBe(503);
      expect((await json<{ error: string }>(off)).error).toMatch(/subscriptions are not deployed/);
    } finally {
      process.env.NEXT_PUBLIC_SPECFIRST_SUBS_10143 = SUBS;
    }
    const file = JSON.parse(await readFile(path.join(root, 'watch', 'webhooks.json'), 'utf8'));
    expect(file.webhooks[stranger.address.toLowerCase()]).toBeUndefined();
  });

  it('rejects a stale signature, a wrong signer and bodies that are not JSON', async () => {
    const issued = Math.floor(Date.now() / 1000) - 11 * 60;
    const url = 'https://hooks.example.com/old';
    const signature = await burner.signMessage({ message: webhookMessage({ subscriber: burner.address, url, issued }) });
    const stale = await webhookPost(post({ subscriber: burner.address, url, issued, signature }));
    expect(stale.status).toBe(400);
    expect(await json<{ reason: string; error: string }>(stale)).toMatchObject({ reason: 'stale', error: expect.stringMatching(/more than 600 s/) });
    const now = Math.floor(Date.now() / 1000);
    const wrong = await burner.signMessage({ message: webhookMessage({ subscriber: OTHER, url, issued: now }) });
    expect((await webhookPost(post({ subscriber: OTHER, url, issued: now, signature: wrong }))).status).toBe(401);
    // Only the canonical form verifies (the inbox signs new URL(input).href): the signed text is the URL called.
    const bare = 'https://hooks.example.com';
    const unslashed = await webhookPost(post({ subscriber: burner.address, url: bare, issued: now, signature: await burner.signMessage({ message: webhookMessage({ subscriber: burner.address, url: bare, issued: now }) }) }));
    expect(await json<{ reason: string; error: string }>(unslashed)).toMatchObject({ reason: 'url', error: 'url not in canonical form (send new URL(url).href)' });
    expect((await webhookPost(post('{oops'))).status).toBe(400);
    expect((await webhookPost(post('x'.repeat(9000)))).status).toBe(413);
  });
});

describe('revenue on /desk', () => {
  it('adds subscription fees to desk fees and the watcher gas a status.json reports', async () => {
    const status = JSON.parse(await readFile(path.join(FIXTURES, '143', 'status.json'), 'utf8'));
    await mkdir(path.join(root, 'watch', '10143'), { recursive: true });
    await writeFile(path.join(root, 'watch', '10143', 'status.json'), JSON.stringify({ ...status, chainId: 10143, gasCostWei: '52000000000000000' }));
    const desk = {
      summary: { deployed: true },
      economics: { earnedWei: (2n * 10n ** 17n).toString(), withdrawnWei: '0', escrowedWei: (10n ** 17n).toString(), gasCostWei: (5n * 10n ** 16n).toString() },
    } as unknown as DeskViewJson;
    const r = await revenueView(desk);
    expect(r).toMatchObject({
      earnedWei: (2n * 10n ** 17n + 3n * FEE).toString(),
      escrowedWei: (10n ** 17n + 90n * FEE).toString(),
      watcherGasWei: (208n * 10n ** 15n + 52n * 10n ** 15n).toString(),
      watcherGasChains: [143, 10143],
      gasWei: (5n * 10n ** 16n + 260n * 10n ** 15n).toString(),
      missing: [],
    });
    expect(BigInt(r.netWei!)).toBe(2n * 10n ** 17n + 3n * FEE - 5n * 10n ** 16n - 260n * 10n ** 15n);
  });
});

describe('demo webhook receiver', () => {
  it('keeps what was POSTed, newest first, and marks ADR alert payloads', async () => {
    // What the watcher's sink POSTs (core's webhookPayload) for a change, to a subscriber holding ids 2 and 5.
    const summary = { pass: 29, fail: 1, inconclusive: 0, notApplicable: 0 };
    const alert = webhookPayload(
      { v: 1, seq: 9, at: '2026-10-06T09:00:00.000Z', kind: 'changed', chainId: 143, subject: getAddress(MORPHO), change: { kind: 'regressed', from: null, to: { summary, failed: ['previewDeposit'] } } },
      [5n, 2n],
    );
    expect(alert).toMatchObject({ subscriptionId: '2', subscriptionIds: ['2', '5'], check: null, reportURL: null });
    const post = (body: string) =>
      new Request('http://localhost/api/v1/watch/demo-hook', { method: 'POST', body, headers: { 'user-agent': 'specfirst-watch/test' } });
    expect((await demoPost(post(JSON.stringify(alert)))).status).toBe(200);
    expect((await demoPost(post('{"hello":"world"}'))).status).toBe(200);
    expect((await demoPost(post('not json'))).status).toBe(400);
    expect((await demoPost(post(JSON.stringify({ big: 'x'.repeat(70 * 1024) })))).status).toBe(413);
    const r = await json<{ received: Array<{ n: number; isAlert: boolean; userAgent: string }> }>(await demoGet());
    expect(r.received.map((e) => [e.n, e.isAlert])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(r.received[0]!.userAgent).toBe('specfirst-watch/test');
  });

  it('SPECFIRST_DEMO_HOOK=off turns it off', async () => {
    process.env.SPECFIRST_DEMO_HOOK = 'off';
    try {
      expect((await demoPost(new Request('http://localhost/x', { method: 'POST', body: '{}' }))).status).toBe(404);
      expect((await demoGet()).status).toBe(404);
    } finally {
      delete process.env.SPECFIRST_DEMO_HOOK;
    }
  });
});
