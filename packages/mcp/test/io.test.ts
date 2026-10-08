import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/api.js';
import { checkAttestationRegistryAbi } from '@specfirst/core';
import { createPublicClient, http } from 'viem';
import { createChainReader, ERC4626_STANDARD_ID } from '../src/chain.js';
import { ConfigError, configFromEnv, DEFAULT_REGISTRY, DEFAULT_SUBSCRIPTIONS, originOf } from '../src/config.js';
import { decide } from '../src/decide.js';
import { gatherVerdict } from '../src/verdict.js';
import { ADDR, NOW, REGISTRY, verdictOf } from './helpers.js';
import { deadUrl, startMockApi, startMockRpc, type Running } from './mocks.js';

let api: Running;
let rpc: Running;
let dead: string;
beforeAll(async () => {
  [api, rpc, dead] = await Promise.all([startMockApi(), startMockRpc(), deadUrl()]);
});
afterAll(async () => {
  await Promise.all([api.close(), rpc.close()]);
});

const reader = (rpcUrl: string) => createChainReader({ rpcUrl, registry: REGISTRY, subscriptions: DEFAULT_SUBSCRIPTIONS, timeoutMs: 3000 });

describe('the API client', () => {
  it('reads a vault, a 404 vault in the same shape, and a report by its path on the configured base', async () => {
    const c = createApi({ base: api.url, timeoutMs: 3000 });
    const v = await c.vault(143, ADDR.upshift);
    expect(v.report?.status).toBe('mismatch');
    const unknown = await c.vault(143, ADDR.unknown);
    expect(unknown.checked).toBe(false);
    // The fixture names http://localhost:3417; only its path is kept.
    const r = await c.report(v.report!.url);
    expect(r.parsed.blockNumber).toBe('111224893');
    expect(api.requests).toContain('GET /reports/143/0xd793c04b87386a6bb84ee61d98e0065fde7fda5e/111224893-d640ec79e88c6c4c.json');
  });

  it('says what went wrong: down, an HTTP error, not JSON, the wrong shape', async () => {
    await expect(createApi({ base: dead, timeoutMs: 3000 }).vault(143, ADDR.upshift)).rejects.toMatchObject({ kind: 'unreachable' });
    const c = createApi({ base: api.url, timeoutMs: 3000 });
    await expect(c.report('/reports/143/0x00000000000000000000000000000000000000aa/1-x.json')).rejects.toMatchObject({ kind: 'http', status: 404 });
    const text = createApi({ base: 'http://x', timeoutMs: 3000, fetch: async () => new Response('<html>', { status: 200 }) });
    await expect(text.watchStatus(143)).rejects.toMatchObject({ kind: 'bad-response' });
    const shape = createApi({ base: 'http://x', timeoutMs: 3000, fetch: async () => new Response('{"schema":"other"}', { status: 200 }) });
    await expect(shape.vault(143, ADDR.upshift)).rejects.toBeInstanceOf(ApiError);
  });

  it('never follows a link off the configured base (review C3)', async () => {
    const seen: string[] = [];
    const c = createApi({ base: 'https://specfirst.example', timeoutMs: 3000, fetch: async (u) => (seen.push(u), new Response('{}')) });
    await expect(c.report('x:.evil.com/r.json')).rejects.toMatchObject({ kind: 'bad-response' });
    await expect(c.report('x:@evil.com/r.json')).rejects.toMatchObject({ kind: 'bad-response' });
    await c.report('https://evil.example/reports/r.json').catch(() => undefined);
    expect(seen).toEqual(['https://specfirst.example/reports/r.json']);
  });

  it('refuses a body larger than 4 MiB without reading it all', async () => {
    const big = createApi({ base: 'http://x.invalid', timeoutMs: 3000, fetch: async () => new Response('[' + '0,'.repeat(3_000_000) + '0]') });
    await expect(big.watchStatus(143)).rejects.toMatchObject({ kind: 'bad-response', message: expect.stringContaining('too large') });
  });

  it('gives up after the timeout', async () => {
    const slow = createApi({
      base: 'http://x',
      timeoutMs: 50,
      fetch: (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    await expect(slow.watchStatus(143)).rejects.toMatchObject({ kind: 'unreachable' });
  });
});

describe('the chain reader', () => {
  it('reads latest, isCompliant and isIssuer, and NoAttestation as none', async () => {
    const r = reader(rpc.url);
    const up = await r.latest(143, ADDR.upshift);
    expect(up.read).toBe('ok');
    if (up.read !== 'ok') return;
    expect(up.attestation.id).toBe(15n);
    expect(up.attestation.status).toBe('Valid');
    expect(up.attestation.failedBitmap).toBe((1n << 28n) | (1n << 29n));
    expect(up.isCompliant).toBe(false);
    expect(up.issuerCurrent).toBe(true);
    const morpho = await r.latest(143, ADDR.morpho);
    expect(morpho.read === 'ok' && morpho.isCompliant).toBe(true);
    expect(await r.latest(143, ADDR.unknown)).toEqual({ read: 'none' });
    expect(await r.feePerDay()).toEqual({ read: 'ok', feePerDayWei: 50_000_000_000_000_000n });
    expect([...new Set(rpc.requests)].sort()).toEqual(['eth_call', 'eth_chainId']);
  });

  it('refuses an RPC of another chain instead of reading "no attestation" there', async () => {
    const mainnet = await startMockRpc({ chainId: 143 });
    try {
      const r = await reader(mainnet.url).latest(143, ADDR.upshift);
      expect(r).toMatchObject({ read: 'unread', reason: expect.stringContaining('chain 143, not Monad testnet 10143') });
      expect(mainnet.requests).toEqual(['eth_chainId']);
    } finally {
      await mainnet.close();
    }
  });

  it('does not follow an OffchainLookup revert to a URL the RPC chose (review M2)', async () => {
    const sentinel = await startMockApi();
    const evil = await startMockRpc({ offchainLookup: `${sentinel.url}/{sender}/{data}.json` });
    try {
      // The same revert does make a client with viem's default (CCIP-Read on) fetch the URL: the attack is real.
      const plain = createPublicClient({ transport: http(evil.url) });
      await plain.readContract({ address: REGISTRY, abi: checkAttestationRegistryAbi, functionName: 'isCompliant', args: [143n, ADDR.morpho, ERC4626_STANDARD_ID] } as never).catch(() => undefined);
      expect(sentinel.requests.length).toBeGreaterThan(0);
      sentinel.requests.length = 0;
      expect((await reader(evil.url).latest(143, ADDR.morpho)).read).toBe('unread');
      expect(sentinel.requests).toEqual([]);
    } finally {
      await Promise.all([sentinel.close(), evil.close()]);
    }
  });

  it('an RPC that is down is unread, never none', async () => {
    const r = reader(dead);
    expect((await r.latest(143, ADDR.morpho)).read).toBe('unread');
    expect((await r.feePerDay()).read).toBe('unread');
  });
});

describe('gatherVerdict over both sources', () => {
  const deps = () => ({ api: createApi({ base: api.url, timeoutMs: 3000 }), chain: reader(rpc.url), registry: REGISTRY, rpcUrl: rpc.url, staleHours: 48, now: () => NOW });

  it('reads the report and the registry and agrees with the server about the attestation', async () => {
    const v = await gatherVerdict(deps(), ADDR.tyyield, 143);
    expect(v.level).toBe('rounding');
    expect(v.report?.verified).toBe(true);
    expect(v.attestation).toMatchObject({ id: '24', matchesReport: true, serverAgrees: true });
    expect(v.report?.url?.startsWith(api.url)).toBe(true);
  });

  it('asks the watcher about a vault with no report', async () => {
    const v = await gatherVerdict(deps(), ADDR.unknown, 143);
    expect(v.status).toBe('unchecked');
    expect(v.watcher?.knows).toBe(false);
    expect(api.requests.some((r) => r.startsWith('GET /api/v1/watch/vaults/143/0x1111'))).toBe(true);
  });

  it('an API answer of the wrong shape is an unreadable source, not a tool error (review M3)', async () => {
    const odd = async (u: string) => {
      const res = await fetch(u);
      if (!u.includes('/api/v1/vaults/')) return res;
      const body = (await res.json()) as { report: { blockNumber: string } };
      body.report.blockNumber = '1.5';
      return new Response(JSON.stringify(body));
    };
    const v = await gatherVerdict({ ...deps(), api: createApi({ base: api.url, timeoutMs: 3000, fetch: odd }) }, ADDR.upshift, 143);
    expect(v.basis).toBe('attestation');
    expect(v.problems[0]).toContain('does not have the expected shape (report.blockNumber');
    expect(decide(v, 'withdraw', null, NOW).decision).toBe('refuse');
    expect(decide(verdictOf('morpho', { api: { ok: false, reason: v.problems[0]! } }), 'deposit', null, NOW).decision).toBe('caution');
  });

  it('sends nothing but GETs to the API', () => {
    expect(api.requests.every((r) => r.startsWith('GET '))).toBe(true);
  });
});

describe('configuration', () => {
  it('defaults to the local web, the public testnet RPC and the deployed contracts', () => {
    expect(configFromEnv({})).toEqual({
      apiBase: 'http://localhost:3417',
      rpcUrl: 'https://testnet-rpc.monad.xyz',
      registry: DEFAULT_REGISTRY,
      subscriptions: DEFAULT_SUBSCRIPTIONS,
      staleHours: 48,
      timeoutMs: 10000,
    });
  });

  it('takes the environment and refuses what is not usable', () => {
    expect(configFromEnv({ SPECFIRST_API_BASE: 'https://specfirst.example/', SPECFIRST_MCP_STALE_HOURS: '24' })).toMatchObject({ apiBase: 'https://specfirst.example', staleHours: 24 });
    expect(() => configFromEnv({ SPECFIRST_API_BASE: 'ftp://x' })).toThrow(ConfigError);
    expect(() => configFromEnv({ SPECFIRST_ATTEST_REGISTRY_10143: '0x12' })).toThrow(ConfigError);
    expect(() => configFromEnv({ SPECFIRST_MCP_TIMEOUT_MS: '0' })).toThrow(ConfigError);
    // Plain http only to this machine; no credentials, query or fragment in the API base.
    expect(() => configFromEnv({ SPECFIRST_API_BASE: 'http://specfirst.example' })).toThrow(/https unless it is on this machine/);
    expect(() => configFromEnv({ SPECFIRST_API_BASE: 'https://user:pw@specfirst.example' })).toThrow(/credentials/);
    expect(() => configFromEnv({ SPECFIRST_API_BASE: 'https://specfirst.example/?x=1' })).toThrow(/query/);
    // The web's links carry its origin only, so a base with a path would double that path in every link (re-review 8).
    expect(() => configFromEnv({ SPECFIRST_API_BASE: 'https://specfirst.example/app' })).toThrow(/without a path/);
    // An RPC keeps a provider key in its path or query.
    expect(configFromEnv({ MONAD_TESTNET_RPC: 'https://rpc.example/v1/key?token=abc' }).rpcUrl).toBe('https://rpc.example/v1/key?token=abc');
  });

  it('shows only the origin of an RPC, so a key in its path never reaches a result', () => {
    expect(originOf('https://rpc.example/v1/secret-key?token=abc')).toBe('https://rpc.example');
  });
});
