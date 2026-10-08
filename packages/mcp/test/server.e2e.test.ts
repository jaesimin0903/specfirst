import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADDR, REGISTRY } from './helpers.js';
import { deadUrl, startMockApi, startMockRpc, type Running } from './mocks.js';

/*
 * The built server (dist/index.js, as an MCP host launches it) over stdio with the SDK's own client, against the
 * mocked web API and testnet RPC. `pnpm test` builds first.
 */

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');

type Result = { content: Array<{ type: string; text: string }>; structuredContent?: Record<string, any>; isError?: boolean };

async function connect(env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'specfirst-e2e', version: '0.0.1' });
  // The stale limit is lifted so the fixtures' fixed check times do not age with the wall clock.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { PATH: process.env.PATH ?? '', SPECFIRST_MCP_STALE_HOURS: '1000000', SPECFIRST_MCP_TIMEOUT_MS: '3000', ...env },
    stderr: 'ignore',
  });
  await client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Result> {
  return (await client.callTool({ name, arguments: args })) as Result;
}

let api: Running;
let rpc: Running;
let dead: string;
let client: Client;

beforeAll(async () => {
  if (!existsSync(SERVER)) throw new Error(`${SERVER} is missing: run pnpm --filter @specfirst/mcp build first`);
  [api, rpc, dead] = await Promise.all([startMockApi(), startMockRpc(), deadUrl()]);
  client = await connect({ SPECFIRST_API_BASE: api.url, MONAD_TESTNET_RPC: rpc.url, SPECFIRST_ATTEST_REGISTRY_10143: REGISTRY });
}, 30_000);

afterAll(async () => {
  await client?.close();
  await Promise.all([api?.close(), rpc?.close()]);
});

describe('the server over stdio', () => {
  it('lists four read-only tools with their schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['check_before_moving_funds', 'how_to_watch', 'recent_findings', 'vault_verdict']);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.outputSchema).toBeDefined();
      expect(t.description!.length).toBeGreaterThan(200);
    }
    const move = tools.find((t) => t.name === 'check_before_moving_funds')!;
    expect(Object.keys(move.inputSchema.properties ?? {})).toEqual(['address', 'chainId', 'action', 'amount']);
    expect(move.inputSchema.required).toEqual(['address', 'action']);
    expect((move.inputSchema.properties as Record<string, { enum?: string[] }>).action!.enum).toEqual(['deposit', 'mint', 'withdraw', 'redeem']);
  });

  it('vault_verdict: Upshift is a MUST mismatch with its concrete call and the attestation read from the RPC', async () => {
    const r = await call(client, 'vault_verdict', { address: ADDR.upshift.toLowerCase() });
    expect(r.isError).toBeFalsy();
    const v = r.structuredContent!;
    expect(v.vault.address).toBe(ADDR.upshift);
    expect([v.status, v.level]).toEqual(['mismatch', 'must']);
    expect(v.failed[0].call.text).toContain('withdraw(609,877,786,695) reverted with 0x75ed2e3e, WithdrawalRequestRequired()');
    expect(v.attestation).toMatchObject({ read: 'ok', id: '15', isCompliant: false, matchesReport: false });
    expect(r.content[0]!.text).toContain('Status: mismatch, level MUST.');
    expect(JSON.parse(r.content[1]!.text)).toEqual(v);
  });

  it('check_before_moving_funds: refuse, caution and proceed on the three fixture vaults', async () => {
    const decision = async (address: string, action: string) => (await call(client, 'check_before_moving_funds', { address, action })).structuredContent!;
    const up = await decision(ADDR.upshift, 'withdraw');
    expect(up.decision).toBe('refuse');
    expect(up.sizing[0]).toMatch(/^Do not size withdrawals from maxWithdraw/);
    expect((await decision(ADDR.tyyield, 'deposit')).decision).toBe('caution');
    const morpho = await decision(ADDR.morpho, 'deposit');
    expect(morpho.decision).toBe('proceed');
    expect(morpho.reasons[0].text).toContain('not a safety guarantee');
  });

  it('an unknown vault is an answer that points to the desk, not an error', async () => {
    const r = await call(client, 'check_before_moving_funds', { address: ADDR.unknown, action: 'deposit', amount: '1000000' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent!.decision).toBe('caution');
    expect(r.structuredContent!.basis.status).toBe('unchecked');
    expect(r.content[0]!.text).toContain(`${api.url}/check?vault=${ADDR.unknown.toLowerCase()}`);
  });

  it('bad input is a tool error that says what is wrong', async () => {
    const checksum = await call(client, 'vault_verdict', { address: '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5e' });
    expect(checksum.isError).toBe(true);
    expect(checksum.content[0]!.text).toContain('checksum does not match');
    const action = await call(client, 'check_before_moving_funds', { address: ADDR.morpho, action: 'transfer' });
    expect(action.isError).toBe(true);
    const amount = await call(client, 'check_before_moving_funds', { address: ADDR.morpho, action: 'deposit', amount: '1.5' });
    expect(amount.isError).toBe(true);
    expect(amount.content[0]!.text).toContain('base units');
  });

  it('recent_findings and how_to_watch', async () => {
    const f = (await call(client, 'recent_findings', { limit: 5 })).structuredContent!;
    expect(f.changes.map((c: { kind: string }) => c.kind)).toEqual(['regressed', 'price-drop', 'changed']);
    expect(f.currentMismatches).toHaveLength(2);
    const w = await call(client, 'how_to_watch', { address: ADDR.morpho });
    expect(w.structuredContent!.subscriptions).toMatchObject({ feePerDayWei: '50000000000000000', feePerDayMon: '0.05', fee: 'chain', chainId: 10143 });
    expect(w.structuredContent!.webhook.kinds.map((k: { kind: string }) => k.kind)).toEqual(['first-check', 'change', 'price-drop']);
    expect(w.content[0]!.text).toContain('0.05 MON per day');
  });

  it('sent only GETs to the API and only eth_chainId and eth_call to the RPC', () => {
    expect(api.requests.length).toBeGreaterThan(5);
    expect(api.requests.every((r) => r.startsWith('GET '))).toBe(true);
    expect([...new Set(rpc.requests)].sort()).toEqual(['eth_call', 'eth_chainId']);
  });
});

describe('a host on the 2025 protocol revisions', () => {
  it('is served after a plain initialize handshake (protocol 2025-06-18)', async () => {
    const p = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH ?? '', SPECFIRST_API_BASE: api.url, MONAD_TESTNET_RPC: rpc.url }, stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      const waiting = new Map<number, (m: { result: Record<string, any> }) => void>();
      let buf = '';
      p.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const m = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          waiting.get(m.id)?.(m);
        }
      });
      const send = (m: object) => p.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
      const request = (id: number, method: string, params: object) =>
        new Promise<{ result: Record<string, any> }>((resolve) => {
          waiting.set(id, resolve);
          send({ id, method, params });
        });
      const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy-host', version: '1' } });
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect(init.result.serverInfo.name).toBe('specfirst');
      expect(init.result.instructions).toContain('check_before_moving_funds');
      send({ method: 'notifications/initialized' });
      const list = await request(2, 'tools/list', {});
      expect(list.result.tools).toHaveLength(4);
      const r = await request(3, 'tools/call', { name: 'check_before_moving_funds', arguments: { address: ADDR.upshift, action: 'withdraw' } });
      expect(r.result.structuredContent.decision).toBe('refuse');
    } finally {
      p.kill();
    }
  }, 30_000);
});

describe('degraded sources, through the same server', () => {
  it('API down: the registry alone still refuses a MUST, and an all-pass attestation is only caution', async () => {
    const c = await connect({ SPECFIRST_API_BASE: dead, MONAD_TESTNET_RPC: rpc.url });
    try {
      const up = (await call(c, 'check_before_moving_funds', { address: ADDR.upshift, action: 'withdraw' })).structuredContent!;
      expect(up.decision).toBe('refuse');
      const morpho = (await call(c, 'check_before_moving_funds', { address: ADDR.morpho, action: 'deposit' })).structuredContent!;
      expect(morpho.decision).toBe('caution');
      expect(morpho.reasons.map((r: { code: string }) => r.code)).toContain('api-unavailable');
    } finally {
      await c.close();
    }
  }, 30_000);

  it('RPC down: an all-pass report is caution, never proceed', async () => {
    const c = await connect({ SPECFIRST_API_BASE: api.url, MONAD_TESTNET_RPC: dead });
    try {
      const morpho = await call(c, 'check_before_moving_funds', { address: ADDR.morpho, action: 'deposit' });
      expect(morpho.structuredContent!.decision).toBe('caution');
      expect(morpho.structuredContent!.reasons.map((r: { code: string }) => r.code)).toEqual(['registry-unread']);
      const w = (await call(c, 'how_to_watch', { address: ADDR.morpho })).structuredContent!;
      expect(w.subscriptions.fee).toBe('unread');
    } finally {
      await c.close();
    }
  }, 30_000);
});
