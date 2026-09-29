import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERC4626_PROPERTIES, parseStandardForgeJson, summarize, type StandardPropertyResult } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (name: string) => readFile(path.join(here, 'fixtures/standards', name), 'utf8');
const parse = async (name: string) => parseStandardForgeJson(await fx(name), ERC4626_PROPERTIES)!;
const byId = (rs: StandardPropertyResult[]) => new Map(rs.map((r) => [r.id, r]));

describe('ERC4626_PROPERTIES', () => {
  it('maps the 26 upstream tests onto unique ids with one-line descriptions', () => {
    expect(ERC4626_PROPERTIES).toHaveLength(26);
    expect(new Set(ERC4626_PROPERTIES.map((p) => p.id)).size).toBe(26);
    expect(new Set(ERC4626_PROPERTIES.map((p) => p.test)).size).toBe(26);
    for (const p of ERC4626_PROPERTIES) {
      expect(p.test).toMatch(/^test_/);
      expect(p.description).not.toContain('\n');
      expect(p.description.length).toBeGreaterThan(10);
    }
  });
});

describe('parseStandardForgeJson on real forge output (forge 1.5.1)', () => {
  it('Morpho vault on Monad mainnet at block 109061472: all 26 pass with 32 runs', async () => {
    const results = await parse('morpho-143-109061472-runs32.json');
    expect(results.map((r) => r.id)).toEqual(ERC4626_PROPERTIES.map((p) => p.id));
    expect(results.every((r) => r.status === 'pass' && r.runs === 32)).toBe(true);
    expect(summarize(results)).toEqual({ pass: 26, fail: 0, inconclusive: 0, notApplicable: 0 });
  });

  it('positive control (BrokenVault over Monad USDC): previewDeposit is the only fail', async () => {
    const results = await parse('control-143-109061472-runs8.json');
    expect(results.filter((r) => r.status !== 'pass').map((r) => [r.id, r.status])).toEqual([['previewDeposit', 'fail']]);
    const r = byId(results).get('previewDeposit')!;
    expect(r.reason).toBe('Error: a >=~ b not satisfied [uint]');
    expect(r.counterexample!.logs).toContain(' Max Delta: 0');
  });

  it('fork RPC rate limit (HTTP 429) mid-run is inconclusive, not fail; log lines before the JSON are skipped', async () => {
    const text = await fx('morpho-143-109061472-runs8-rpc429.json');
    expect(text.startsWith('2026-09-29T15:08:34')).toBe(true);
    const results = await parse('morpho-143-109061472-runs8-rpc429.json');
    expect(summarize(results)).toEqual({ pass: 25, fail: 0, inconclusive: 1, notApplicable: 0 });
    const r = byId(results).get('withdraw')!;
    expect(r.status).toBe('inconclusive');
    expect(r.reason).toMatch(/^fork RPC error, rerun or pass another --rpc: EVM error; database error: failed to get account for 0x[0-9a-fA-F]{40}: Max retries exceeded HTTP error 429/);
    expect(r.counterexample).toBeUndefined();
  });

  it('BuggyVault: fail with a null forge reason takes the assertion from decoded_logs and keeps the call', async () => {
    const raw = JSON.parse(await fx('local-buggy.json')) as Record<string, { test_results: Record<string, { reason: string | null }> }>;
    const rt = Object.entries(Object.values(raw)[0]!.test_results).find(([k]) => k.startsWith('test_RT_deposit_redeem('))![1];
    expect(rt.reason).toBeNull();

    const results = await parse('local-buggy.json');
    expect(results.filter((r) => r.status === 'fail').map((r) => r.id)).toEqual([
      'RT-deposit-redeem',
      'RT-deposit-withdraw',
      'RT-redeem-deposit',
      'RT-withdraw-deposit',
    ]);
    expect(summarize(results)).toEqual({ pass: 22, fail: 4, inconclusive: 0, notApplicable: 0 });
    const r = byId(results).get('RT-deposit-redeem')!;
    expect(r.reason).toBe('Error: a <=~ b not satisfied [uint]');
    expect(r.counterexample!.logs).toContain(' Max Delta: 0');
    expect(r.counterexample!.logs.some((l) => /Value a: \d+/.test(l))).toBe(true);
    expect(r.counterexample!.calls).toHaveLength(1);
    expect(r.counterexample!.calls[0]).toMatch(/^test_RT_deposit_redeem\(\(\[0x[0-9a-fA-F]{40}/);
    expect(r.counterexample!.calldata).toMatch(/^0x[0-9a-f]+$/);
  });

  it('ClosedVault: every input rejected is inconclusive, never pass or fail', async () => {
    const results = await parse('local-closed.json');
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 26, notApplicable: 0 });
    expect(results[0]!.reason).toBe('`vm.assume` rejected too many inputs (65536 allowed)');
    expect(results.every((r) => r.counterexample === undefined)).toBe(true);
  });

  it('asset without storage balances: deal failure is inconclusive, not fail', async () => {
    const results = await parse('local-computed.json');
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 26, notApplicable: 0 });
    expect(results[0]!.reason).toMatch(/^deal could not fund test users \(non-standard token\): stdStorage find/);
  });

  it('setUp revert (asset() on a plain token): every property is not_applicable', async () => {
    const results = await parse('local-notvault.json');
    expect(results).toHaveLength(26);
    expect(results.every((r) => r.status === 'not_applicable' && r.reason === 'setUp failed: EvmError: Revert')).toBe(true);
  });
});

describe('parseStandardForgeJson shapes', () => {
  const suite = (tests: Record<string, unknown>) => JSON.stringify({ 'test/SpecfirstERC4626.t.sol:SpecfirstERC4626Test': { test_results: tests } });
  const one = { test: 'test_previewDeposit', id: 'previewDeposit', description: 'd' };
  const failure = (reason: string | null, decoded: string[] = []) => ({
    status: 'Failure',
    reason,
    counterexample: { Single: { sender: null, addr: null, calldata: '0xab', args: 'Init({...}), 5', raw_args: '(...), 5' } },
    decoded_logs: decoded,
    kind: { Fuzz: { runs: 3 } },
  });

  it('a Failure whose reason is the empty string is still fail', () => {
    const [r] = parseStandardForgeJson(suite({ 'test_previewDeposit((address[4],uint256[4],uint256[4],int256),uint256)': failure('') }), [one])!;
    expect(r!.status).toBe('fail');
    expect(r!.reason).toBe('property failed');
    expect(r!.runs).toBe(3);
    expect(r!.counterexample).toEqual({ calls: ['test_previewDeposit((...), 5)'], calldata: '0xab', logs: [] });
  });

  it('a Failure with an empty reason uses the first decoded log line', () => {
    const [r] = parseStandardForgeJson(suite({ 'test_previewDeposit()': failure('', ['Error: a >=~ b not satisfied [uint]', '   Value a: 1']) }), [one])!;
    expect(r!.status).toBe('fail');
    expect(r!.reason).toBe('Error: a >=~ b not satisfied [uint]');
  });

  it('an assertion reason is kept as is', () => {
    const [r] = parseStandardForgeJson(suite({ 'test_previewDeposit()': failure('assertion failed: 1 != 2') }), [one])!;
    expect(r!).toMatchObject({ status: 'fail', reason: 'assertion failed: 1 != 2' });
  });

  it('a property forge did not report is inconclusive; a test outside the table is appended', () => {
    const rs = parseStandardForgeJson(suite({ 'test_extra()': { status: 'Success', reason: null, counterexample: null } }), [one])!;
    expect(rs).toEqual([
      { id: 'previewDeposit', test: 'test_previewDeposit', description: 'd', status: 'inconclusive', reason: 'no result in forge output' },
      { id: 'test_extra', test: 'test_extra', description: 'not in the property table', status: 'pass' },
    ]);
  });

  it('a status other than Success or Failure is inconclusive', () => {
    const [r] = parseStandardForgeJson(suite({ 'test_previewDeposit()': { status: 'Skipped', reason: null, counterexample: null } }), [one])!;
    expect(r!).toMatchObject({ status: 'inconclusive', reason: 'forge status Skipped' });
  });

  it('output without forge JSON (compile or fork error) returns null', () => {
    expect(parseStandardForgeJson('Error: Compiler run failed', [one])).toBeNull();
    expect(parseStandardForgeJson('', [one])).toBeNull();
  });
});
