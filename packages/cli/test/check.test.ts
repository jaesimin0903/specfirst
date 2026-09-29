import { mkdtemp, rm } from 'node:fs/promises';
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
