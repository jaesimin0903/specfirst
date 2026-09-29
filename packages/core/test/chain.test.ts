import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anvilChain,
  chainFor,
  createChainClients,
  isRateLimited,
  isWriteForbidden,
  monadMainnet,
  monadTestnet,
  TokenBucket,
} from '../src/index.js';

describe('chains', () => {
  it('defines monadTestnet 10143 and anvil 31337', () => {
    expect(monadTestnet.id).toBe(10143);
    expect(anvilChain.id).toBe(31337);
    expect(chainFor('monad-testnet').id).toBe(10143);
    expect(chainFor('anvil').id).toBe(31337);
    expect(() => chainFor('mainnet')).toThrow(/unknown network/);
  });

  it('defines monad-mainnet 143 as write-forbidden; testnet and anvil stay writable', () => {
    expect(monadMainnet.id).toBe(143);
    expect(chainFor('monad-mainnet').id).toBe(143);
    expect(monadMainnet.rpcUrls.default.http).toEqual(['https://rpc.monad.xyz']);
    expect(isWriteForbidden(143)).toBe(true);
    expect(isWriteForbidden(10143)).toBe(false);
    expect(isWriteForbidden(31337)).toBe(false);
  });

  it('never builds a wallet client for monad-mainnet, even with a valid key', () => {
    const key = `0x${'11'.repeat(32)}` as const;
    const mainnet = createChainClients({ chain: monadMainnet, rpcUrls: ['http://127.0.0.1:1'] });
    expect(() => mainnet.wallet(key)).toThrow(/refusing to create a wallet client for Monad \(chain 143\)/);
    expect(mainnet.publicClient.chain.id).toBe(143);
    const testnet = createChainClients({ chain: monadTestnet, rpcUrls: ['http://127.0.0.1:1'] });
    expect(testnet.wallet(key).account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe('TokenBucket', () => {
  it('serves a burst of rps tokens, then waits about 1/rps per token', async () => {
    let now = 0;
    const waits: number[] = [];
    const bucket = new TokenBucket(
      10,
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    for (let i = 0; i < 10; i++) await bucket.acquire();
    expect(waits).toEqual([]);
    await bucket.acquire();
    await bucket.acquire();
    expect(waits).toEqual([100, 100]);
    expect(now).toBe(200);
  });
});

/** JSON-RPC stub: answers eth_chainId and eth_blockNumber, returning HTTP 429 for the first `fail429` requests. */
function stub(fail429: number, opts: { down?: boolean } = {}): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits++;
      if (opts.down) {
        res.writeHead(503).end('down');
        return;
      }
      if (hits <= fail429) {
        res.writeHead(429, { 'content-type': 'application/json' }).end('{"error":"too many requests"}');
        return;
      }
      const { id, method } = JSON.parse(body) as { id: number; method: string };
      const result = method === 'eth_chainId' ? '0x7a69' : '0x2a';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits }),
    ),
  );
}

describe('rpcTransport', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  it('retries HTTP 429 with exponential backoff, then succeeds', async () => {
    const s = await stub(3);
    servers.push(s.server);
    const retries: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const slept: number[] = [];
    const { publicClient } = createChainClients({
      chain: anvilChain,
      rpcUrls: [s.url],
      baseDelayMs: 50,
      sleep: async (ms) => void slept.push(ms),
      onRetry: (r) => retries.push(r),
    });
    expect(await publicClient.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(s.hits()).toBe(4);
    expect(retries.map((r) => r.reason)).toEqual(['429', '429', '429']);
    expect(slept).toEqual([50, 100, 200]);
  });

  it('fails over to the next RPC when one is down or keeps returning 429', async () => {
    const down = await stub(0, { down: true });
    const limited = await stub(1000);
    const good = await stub(0);
    servers.push(down.server, limited.server, good.server);
    const reasons: string[] = [];
    const { publicClient } = createChainClients({
      chain: anvilChain,
      rpcUrls: [down.url, limited.url, good.url],
      maxRetries: 2,
      baseDelayMs: 1,
      onRetry: (r) => reasons.push(`${r.url === down.url ? 'down' : r.url === limited.url ? 'limited' : 'good'}:${r.reason}`),
    });
    expect(await publicClient.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(reasons).toEqual(['down:failover', 'limited:429', 'limited:429', 'limited:failover']);
    expect(good.hits()).toBe(1);
  });

  it('isRateLimited recognises status, code and message forms', () => {
    expect(isRateLimited({ status: 429 })).toBe(true);
    expect(isRateLimited({ cause: { code: 429 } })).toBe(true);
    expect(isRateLimited(new Error('Too Many Requests'))).toBe(true);
    expect(isRateLimited(new Error('execution reverted'))).toBe(false);
  });
});
