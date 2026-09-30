import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCheckArgs, registerCheckCommand, type CheckOptions } from '../src/commands/check.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const VAULT = '0x802c91d807A8DaCA257c4708ab264B6520964e44';
const opts = (o: Partial<CheckOptions> = {}): CheckOptions => ({ standard: 'erc4626', network: 'monad-mainnet', runs: '32', delta: '0', ...o });

describe('parseCheckArgs', () => {
  it('parses a full set of flags', () => {
    expect(parseCheckArgs(VAULT.toLowerCase(), opts({ block: '109061472', runs: '8', delta: '2' }))).toEqual({
      standard: 'erc4626',
      address: VAULT,
      block: 109061472n,
      runs: 8,
      delta: 2n,
    });
    expect(parseCheckArgs(VAULT, opts()).block).toBeUndefined();
    expect(parseCheckArgs(VAULT, opts({ seed: '0x2a' })).seed).toBe(42n);
    expect(parseCheckArgs(VAULT, opts({ delta: (2n ** 256n - 1n).toString() })).delta).toBe(2n ** 256n - 1n);
  });

  it('L5: a mixed-case address must be a correct EIP-55 checksum; lowercase and uppercase are accepted', () => {
    expect(parseCheckArgs(VAULT.toLowerCase(), opts()).address).toBe(VAULT);
    expect(parseCheckArgs(`0x${VAULT.slice(2).toUpperCase()}`, opts()).address).toBe(VAULT);
    const wrong = '0x802C91d807A8DaCA257c4708ab264B6520964e44';
    expect(() => parseCheckArgs(wrong, opts())).toThrow(/is mixed-case but not a valid EIP-55 checksum \(expected 0x802c91d807A8DaCA257c4708ab264B6520964e44/);
  });

  it('L4: --delta and --seed must fit uint256', () => {
    expect(() => parseCheckArgs(VAULT, opts({ delta: (2n ** 256n).toString() }))).toThrow(/--delta must be a non-negative integer below 2\^256/);
    expect(() => parseCheckArgs(VAULT, opts({ seed: `0x1${'0'.repeat(64)}` }))).toThrow(/--seed must be a uint256/);
    expect(() => parseCheckArgs(VAULT, opts({ seed: '-1' }))).toThrow(/--seed must be a uint256/);
  });

  it('rejects each bad flag with the flag name', () => {
    expect(() => parseCheckArgs('0x1234', opts())).toThrow(/<address> must be a 0x-prefixed 20-byte hex address/);
    expect(() => parseCheckArgs(VAULT, opts({ standard: 'erc20' }))).toThrow(/unknown --standard "erc20" \(expected erc4626\)/);
    for (const runs of ['0', '-1', '1.5', 'x', '']) expect(() => parseCheckArgs(VAULT, opts({ runs }))).toThrow(/--runs must be a positive integer/);
    for (const block of ['latest', '-5', '1e6']) expect(() => parseCheckArgs(VAULT, opts({ block }))).toThrow(/--block must be a non-negative integer/);
    for (const delta of ['-1', '0.5', 'x']) expect(() => parseCheckArgs(VAULT, opts({ delta }))).toThrow(/--delta must be a non-negative integer/);
  });
});

describe('specfirst check argument errors (no RPC reached)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
    process.exitCode = undefined;
  });

  // An unroutable RPC: if validation let anything through, the command would fail on the network instead.
  const check = async (...args: string[]) => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-'));
    process.exitCode = undefined;
    const r = await capture(() =>
      buildProgram(registerCheckCommand).parseAsync(['node', 'specfirst', '--json', '--project', dir!, 'check', ...args, '--rpc', 'http://127.0.0.1:1']),
    );
    return { ...r, code: process.exitCode ?? 0 };
  };

  it('exits 1 on a malformed address and emits check-error', async () => {
    const r = await check('0xnope', '--standard', 'erc4626');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('specfirst check: <address> must be a 0x-prefixed 20-byte hex address');
    expect(JSON.parse(r.stdout.trim())).toMatchObject({ type: 'check-error', exitCode: 1 });
  });

  it('exits 1 on an unknown standard, bad runs or bad block', async () => {
    expect((await check(VAULT, '--standard', 'erc721')).code).toBe(1);
    expect((await check(VAULT, '--standard', 'erc4626', '--runs', '0')).code).toBe(1);
    expect((await check(VAULT, '--standard', 'erc4626', '--block', 'latest')).code).toBe(1);
  });

  it('exits 1 on an unknown network', async () => {
    const r = await check(VAULT, '--standard', 'erc4626', '--network', 'ethereum', '--block', '1');
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toMatch(/unknown network "ethereum"/);
  });

  it('requires --standard', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-'));
    await expect(buildProgram(registerCheckCommand).parseAsync(['node', 'specfirst', '--project', dir, 'check', VAULT])).rejects.toThrow(/--standard/);
  });
});

/** JSON-RPC stub for a native-asset (ERC-7535) vault on anvil's chain id; `down` answers HTTP 503. */
function rpcStub(opts: { down?: boolean } = {}): Promise<{ server: Server; url: string; methods: string[] }> {
  const methods: string[] = [];
  const answer = (method: string): unknown => {
    switch (method) {
      case 'eth_chainId':
        return '0x7a69';
      case 'eth_blockNumber':
        return '0x5';
      case 'eth_getCode':
        return `0x6080604052a2646970667358221220${'11'.repeat(32)}64736f6c63430008180033`;
      case 'eth_getStorageAt':
        return `0x${'0'.repeat(64)}`;
      case 'eth_call':
        return `0x${'0'.repeat(24)}eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`;
      default:
        return null;
    }
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const msg = JSON.parse(body) as { id: number; method: string } | Array<{ id: number; method: string }>;
      const list = Array.isArray(msg) ? msg : [msg];
      methods.push(...list.map((m) => m.method));
      if (opts.down) return void res.writeHead(503).end('down');
      const out = list.map((m) => ({ jsonrpc: '2.0', id: m.id, result: answer(m.method) }));
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(msg) ? out : out[0]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, methods })));
}

describe('specfirst check against a stub RPC (no forge, no public RPC)', () => {
  const servers: Server[] = [];
  let dir: string | undefined;
  const saved = { ...process.env };
  afterEach(async () => {
    for (const s of servers.splice(0)) s.close();
    process.env = { ...saved };
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
    process.exitCode = undefined;
  });
  const run = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(registerCheckCommand).parseAsync(['node', 'specfirst', '--json', '--project', dir!, 'check', ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };

  it('M2 + L7: an ERC-7535 vault is all not_applicable, exits 17, reports no raw file and removes a stale one', async () => {
    const stub = await rpcStub();
    servers.push(stub.server);
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-'));
    process.env.SPECFIRST_CACHE_DIR = path.join(dir, 'cache');
    const checkDir = path.join(dir, '.specfirst/checks/31337', VAULT.toLowerCase());
    await mkdir(checkDir, { recursive: true });
    await writeFile(path.join(checkDir, '5.forge.json'), '{"stale":true}');
    const r = await run(VAULT, '--standard', 'erc4626', '--network', 'anvil', '--rpc', stub.url);
    expect(r.code).toBe(17);
    expect(r.err).toMatch(/specfirst check: incomplete, not verified: 0 pass, 0 inconclusive, 30 not applicable/);
    const summary = r.events.find((e) => e.type === 'check-summary')!;
    expect(summary).toMatchObject({ exitCode: 17, blockNumber: '5', vaultKind: 'erc7535', seed: null, sender: null, reportPath: `.specfirst/checks/31337/${VAULT.toLowerCase()}/5.json` });
    expect(summary).not.toHaveProperty('rawPath');
    expect(existsSync(path.join(checkDir, '5.forge.json'))).toBe(false);
    expect(JSON.parse(await readFile(path.join(checkDir, '5.json'), 'utf8')).summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(r.events.at(-1)).toMatchObject({ type: 'check-error', exitCode: 17 });
    expect(existsSync(path.join(dir, 'cache'))).toBe(false);
  });

  it('L9: reads only the fork RPC; a configured fallback is never used', async () => {
    const down = await rpcStub({ down: true });
    const fallback = await rpcStub();
    servers.push(down.server, fallback.server);
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-'));
    process.env.MONAD_TESTNET_RPC_FALLBACKS = fallback.url;
    const r = await run(VAULT, '--standard', 'erc4626', '--network', 'monad-testnet', '--rpc', down.url, '--block', '5');
    expect(r.code).toBe(1);
    expect(down.methods.length).toBeGreaterThan(0);
    expect(fallback.methods).toEqual([]);
  });
});
