import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import {
  depositRevertCounts,
  ERC4626_CHECK_PROPERTIES,
  ERC4626_PROPERTIES,
  SPECFIRST_ERC4626_PROPERTIES,
  parseStandardForgeJson,
  STANDARD_CHECK_FAILED_EXIT_CODE,
  STANDARD_CHECK_INCOMPLETE_EXIT_CODE,
  standardCheckExitCode,
  skipReasonOf,
  RESTRICTED_ASSET_NOTE,
  summarize,
  type StandardPropertyResult,
} from '../src/index.js';

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
    expect(results[0]!.reason).toMatch(/^the asset's balance slot cannot be written, test users cannot be funded \(non-standard token\): stdStorage find/);
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

/** One suite of a multi-suite forge document, as its own document. */
async function suites(name: string): Promise<Map<string, string>> {
  const text = await fx(name);
  const doc = JSON.parse(text.trim().split('\n').filter((l) => l.startsWith('{')).pop()!) as Record<string, unknown>;
  return new Map(Object.entries(doc).map(([k, v]) => [k.split(':')[1]!, JSON.stringify({ [k]: v })]));
}
const statuses = (rs: StandardPropertyResult[]) => rs.filter((r) => r.status !== 'pass').map((r) => [r.id, r.status, r.reason]);

describe('review reproductions (forge 1.5.1, review/ fixtures)', () => {
  it('H1: a setUp that fails on the fork RPC (HTTP 429) is inconclusive for every property, not not_applicable', async () => {
    const text = await fx('review/setup-fork429.json');
    expect(text.startsWith('\u001b[2m')).toBe(true);
    const results = parseStandardForgeJson(text, ERC4626_PROPERTIES)!;
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 26, notApplicable: 0 });
    expect(results[0]!.reason).toMatch(/^fork RPC error, rerun or pass another --rpc: setUp failed: EVM error; database error: failed to get account for 0x5F0+11: Max retries exceeded HTTP error 429/);
  });

  it('H2: vault reverts that look like RPC trouble ("rate limit exceeded", "HTTP error 503") are fail, not inconclusive', async () => {
    const old = await suites('review/modes-old-harness.json');
    const rate = parseStandardForgeJson(old.get('ModeRateLimit')!, ERC4626_PROPERTIES)!;
    expect(summarize(rate)).toEqual({ pass: 0, fail: 26, inconclusive: 0, notApplicable: 0 });
    expect(rate.every((r) => r.reason === 'rate limit exceeded')).toBe(true);
    const http = parseStandardForgeJson(old.get('ModeMaxRedeemHttp')!, ERC4626_PROPERTIES)!;
    expect(statuses(http)).toEqual([['maxRedeem', 'fail', 'HTTP error 503']]);
    const setup = parseStandardForgeJson(old.get('SetupRevertsRateLimit')!, ERC4626_PROPERTIES)!;
    expect(summarize(setup)).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 26 });
    expect(setup[0]!.reason).toBe('setUp failed: rate limit exceeded');
  });

  it('packed balance slot (AUSD shape): the previous harness failed all 26 on checked_write; that is inconclusive, never fail', async () => {
    const old = await suites('review/packed-asset-old-harness.json');
    const results = parseStandardForgeJson(old.get('ModePackedAsset')!, ERC4626_PROPERTIES)!;
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 26, notApplicable: 0 });
    expect(new Set(results.map((r) => r.reason))).toEqual(
      new Set([
        "the asset's balance slot cannot be written, test users cannot be funded (non-standard token): stdStorage checked_write(StdStorage): Failed to write value.",
      ]),
    );
    expect(results.every((r) => r.counterexample === undefined)).toBe(true);
  });

  it('packed balance slot: the current harness falls back to the packed slot write and all 26 pass', async () => {
    const now = await suites('review/packed-asset-new-harness.json');
    expect(summarize(parseStandardForgeJson(now.get('ModePackedAsset')!, ERC4626_PROPERTIES)!)).toEqual({ pass: 26, fail: 0, inconclusive: 0, notApplicable: 0 });
  });

  it('M1: with the new harness a reverting maxDeposit fails test_maxDeposit only', async () => {
    const now = await suites('review/modes-new-harness.json');
    expect(statuses(parseStandardForgeJson(now.get('ModePaused')!, ERC4626_PROPERTIES)!)).toEqual([['maxDeposit', 'fail', 'paused']]);
    expect(statuses(parseStandardForgeJson(now.get('ModeRateLimit')!, ERC4626_PROPERTIES)!)).toEqual([['maxDeposit', 'fail', 'rate limit exceeded']]);
    expect(statuses(parseStandardForgeJson(now.get('ModeMaxRedeemHttp')!, ERC4626_PROPERTIES)!)).toEqual([['maxRedeem', 'fail', 'HTTP error 503']]);
  });

  it('L3: deposits reverting below maxDeposit are counted per property and noted in the reason, status unchanged', async () => {
    const now = await suites('review/modes-new-harness.json');
    const text = now.get('ModeDepositRevertsBelowMax')!;
    const keys = Object.keys((Object.values(JSON.parse(text))[0] as { test_results: object }).test_results);
    const sel = (test: string) => toFunctionSelector(keys.find((k) => k.startsWith(`${test}(`))!);
    const events = [...Array(3).fill(sel('test_deposit')), sel('test_RT_mint_redeem'), '0xdeadbeef', ''].join('\n');
    expect(depositRevertCounts(events, keys)).toEqual(new Map([['test_deposit', 3], ['test_RT_mint_redeem', 1]]));

    const results = parseStandardForgeJson(text, ERC4626_PROPERTIES, { depositRevertEvents: events })!;
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 26, notApplicable: 0 });
    const r = byId(results);
    expect(r.get('deposit')!.reason).toBe(
      '`vm.assume` rejected too many inputs (65536 allowed); deposit reverted below maxDeposit 3 times (inputs discarded, EIP-4626 says it must not revert)',
    );
    expect(r.get('RT-mint-redeem')!.reason).toMatch(/below maxDeposit 1 times/);
    expect(r.get('asset')!.reason).toBe('`vm.assume` rejected too many inputs (65536 allowed)');
  });
});

describe('H2: forge messages are matched only as forge writes them', () => {
  const one = { test: 'test_previewDeposit', id: 'previewDeposit', description: 'd' };
  const status = (reason: string) =>
    parseStandardForgeJson(
      JSON.stringify({ 's:S': { test_results: { 'test_previewDeposit()': { status: 'Failure', reason, counterexample: null } } } }),
      [one],
    )![0]!;

  it('contract revert strings that merely contain the words stay fail', () => {
    for (const reason of [
      'rate limit exceeded',
      'HTTP error 503',
      'Max retries exceeded',
      'request limit reached',
      'error sending request',
      'could not instantiate forked environment',
      'x `vm.assume` rejected too many inputs (65536 allowed)',
      'No storage use detected for target.',
      'Slot(s) not found.',
      'failed: EVM error; database error: x',
    ]) {
      expect([reason, status(reason).status]).toEqual([reason, 'fail']);
    }
  });

  it('the exact forge and forge-std prefixes are inconclusive', () => {
    expect(status('`vm.assume` rejected too many inputs (65536 allowed)').status).toBe('inconclusive');
    expect(status('stdStorage find(StdStorage): Slot(s) not found.').status).toBe('inconclusive');
    expect(status('stdStorage checked_write(StdStorage): Failed to write value.').status).toBe('inconclusive');
    expect(status('x stdStorage checked_write(StdStorage): Failed to write value.').status).toBe('fail');
    expect(status('stdStorage write(StdStorage): x').status).toBe('fail');
    expect(status('EVM error; database error: failed to get storage for 0x1').status).toBe('inconclusive');
  });

  it('policy: a contract that imitates a forge prefix only reaches "not verified" (exit 17), never pass', () => {
    const r = status('EVM error; database error: imitated by the vault');
    expect(r.status).toBe('inconclusive');
    expect(standardCheckExitCode(summarize([{ status: 'pass' }, r]))).toBe(STANDARD_CHECK_INCOMPLETE_EXIT_CODE);
  });
});

describe('M2: standardCheckExitCode', () => {
  const s = (pass: number, fail: number, inconclusive: number, notApplicable: number) => ({ pass, fail, inconclusive, notApplicable });
  it('fail wins, then incomplete, then 0', () => {
    expect(standardCheckExitCode(s(25, 1, 0, 0))).toBe(STANDARD_CHECK_FAILED_EXIT_CODE);
    expect(standardCheckExitCode(s(0, 1, 25, 0))).toBe(16);
    expect(standardCheckExitCode(s(25, 0, 1, 0))).toBe(17);
    expect(standardCheckExitCode(s(25, 0, 0, 1))).toBe(17);
    expect(standardCheckExitCode(s(0, 0, 0, 26))).toBe(17);
    expect(standardCheckExitCode(s(0, 0, 0, 0))).toBe(17);
    expect(standardCheckExitCode(s(26, 0, 0, 0))).toBe(0);
  });
});

describe('Specfirst properties sf-* (real forge output, local anvil with anvil_setCode)', () => {
  const check = async (name: string) => parseStandardForgeJson(await fx(name), ERC4626_CHECK_PROPERTIES)!;

  it('the table: four sf- ids after the 26 upstream ones, each description names the EIP-4626 rule', () => {
    expect(SPECFIRST_ERC4626_PROPERTIES.map((p) => p.id)).toEqual(['sf-maxDeposit-honored', 'sf-maxMint-honored', 'sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    expect(ERC4626_CHECK_PROPERTIES).toHaveLength(30);
    for (const p of SPECFIRST_ERC4626_PROPERTIES) expect(p.description).toMatch(/\(EIP-4626: /);
  });

  it('(b) a vault that honours its max values passes all 30', async () => {
    expect(summarize(await check('local-sf-honouring.json'))).toEqual({ pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 });
  });

  it('(a) async exits (Upshift shape): sf-maxWithdraw and sf-maxRedeem fail with the raw selector and the max; upstream only runs out of inputs', async () => {
    const results = await check('local-sf-async-exit.json');
    const r = byId(results);
    expect(r.get('sf-maxWithdraw-honored')).toMatchObject({ status: 'fail' });
    expect(r.get('sf-maxWithdraw-honored')!.reason).toMatch(/^withdraw\(\d+\) reverted with selector 0x75ed2e3e while maxWithdraw is \d+$/);
    expect(r.get('sf-maxRedeem-honored')!.reason).toMatch(/^redeem\(\d+\) reverted with selector 0x75ed2e3e while maxRedeem is \d+$/);
    expect(r.get('sf-maxWithdraw-honored')!.counterexample!.calls[0]).toMatch(/^test_sf_maxWithdraw_honored\(/);
    expect(r.get('sf-maxDeposit-honored')!.status).toBe('pass');
    expect(r.get('sf-maxMint-honored')!.status).toBe('pass');
    expect(summarize(results)).toEqual({ pass: 16, fail: 2, inconclusive: 12, notApplicable: 0 });
    expect(results.filter((x) => x.status === 'inconclusive').every((x) => /^`vm\.assume` rejected too many inputs \(4096 allowed\)$/.test(x.reason!))).toBe(true);
  });

  it('(c) exits disabled and max values of 0: nothing fails, sf-maxWithdraw and sf-maxRedeem end inconclusive', async () => {
    const results = await check('local-sf-honest-closed.json');
    const r = byId(results);
    expect(r.get('sf-maxWithdraw-honored')!.status).toBe('inconclusive');
    expect(r.get('sf-maxRedeem-honored')!.status).toBe('inconclusive');
    expect(summarize(results)).toEqual({ pass: 16, fail: 0, inconclusive: 14, notApplicable: 0 });
  });

  it('a suite whose setUp failed only affects its own properties', () => {
    const doc = JSON.stringify({
      'test/SpecfirstERC4626.t.sol:SpecfirstERC4626Test': { test_results: { 'test_asset((address[4],uint256[4],uint256[4],int256))': { status: 'Success', reason: null, counterexample: null } } },
      'test/SpecfirstMaxHonored.t.sol:SpecfirstMaxHonored': { test_results: { 'setUp()': { status: 'Failure', reason: 'EvmError: Revert', counterexample: null } } },
    });
    const r = byId(parseStandardForgeJson(doc, [ERC4626_PROPERTIES[0]!, SPECFIRST_ERC4626_PROPERTIES[2]!])!);
    expect(r.get('asset')!.status).toBe('pass');
    expect(r.get('sf-maxWithdraw-honored')).toMatchObject({ status: 'not_applicable', reason: 'setUp failed: EvmError: Revert' });
  });
});

describe('ERC-7575 vault run without the pre-check (local anvil, SplitShareVault)', () => {
  it('the 16 properties that touch the vault as an ERC-20 fail with "EvmError: Revert" and no counterexample logs', async () => {
    const results = parseStandardForgeJson(await fx('local-erc7575-no-precheck.json'), ERC4626_CHECK_PROPERTIES)!;
    const failed = results.filter((r) => r.status === 'fail');
    expect(failed.map((r) => r.id)).toEqual([
      'deposit',
      'mint',
      'previewWithdraw',
      'withdraw',
      'withdraw-zero-allowance',
      'previewRedeem',
      'redeem',
      'redeem-zero-allowance',
      'RT-deposit-redeem',
      'RT-deposit-withdraw',
      'RT-redeem-deposit',
      'RT-redeem-mint',
      'RT-mint-withdraw',
      'RT-mint-redeem',
      'RT-withdraw-mint',
      'RT-withdraw-deposit',
    ]);
    expect(failed.every((r) => r.reason === 'EvmError: Revert')).toBe(true);
    expect(summarize(results)).toEqual({ pass: 14, fail: 16, inconclusive: 0, notApplicable: 0 });
  });
});

describe('ZeroMaxVault: every max is 0, the actions work (Morpho Vault V2 shape)', () => {
  it('the upstream suite runs and passes; the sf- properties discard every input and end inconclusive', async () => {
    const results = parseStandardForgeJson(await fx('local-zero-max.json'), ERC4626_CHECK_PROPERTIES)!;
    expect(summarize(results)).toEqual({ pass: 26, fail: 0, inconclusive: 4, notApplicable: 0 });
    expect(results.filter((r) => r.status === 'inconclusive').map((r) => r.id)).toEqual([
      'sf-maxDeposit-honored',
      'sf-maxMint-honored',
      'sf-maxWithdraw-honored',
      'sf-maxRedeem-honored',
    ]);
    expect(results.filter((r) => r.status === 'inconclusive').every((r) => /^`vm\.assume` rejected too many inputs/.test(r.reason!))).toBe(true);
  });
});

describe('assets that test users cannot move (transfer probe in both setUps)', () => {
  const check = async (name: string) => parseStandardForgeJson(await fx(name), ERC4626_CHECK_PROPERTIES)!;

  it('an asset nobody may transfer: both setUps stop, all 30 not_applicable with the note and the selector', async () => {
    const results = await check('local-restricted-asset.json');
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(new Set(results.map((r) => r.reason))).toEqual(new Set([`${RESTRICTED_ASSET_NOTE} (selector 0x82b42900)`]));
    expect(skipReasonOf(results)).toBe('asset-transfer-restricted');
    expect(standardCheckExitCode(summarize(results))).toBe(17);
  });

  it('an asset only the vault may receive (deposits work, withdrawals fail in the token): also not_applicable', async () => {
    const results = await check('local-partial-restricted.json');
    expect(summarize(results)).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(skipReasonOf(results)).toBe('asset-transfer-restricted');
  });

  it('a free asset behind a vault hook that refuses deposits is not skipped: sf-maxDeposit and sf-maxMint fail', async () => {
    const results = await check('local-hook-blocked.json');
    const r = byId(results);
    expect(r.get('sf-maxDeposit-honored')!.status).toBe('fail');
    expect(r.get('sf-maxDeposit-honored')!.reason).toMatch(/^deposit\(\d+\) reverted with selector 0xea8e4eb5 while maxDeposit is \d+$/);
    expect(r.get('sf-maxMint-honored')!.reason).toMatch(/^mint\(\d+\) reverted with selector 0xea8e4eb5 while maxMint is \d+$/);
    expect(summarize(results)).toEqual({ pass: 0, fail: 2, inconclusive: 28, notApplicable: 0 });
    expect(skipReasonOf(results)).toBeNull();
  });

  it('the prefix is matched only at the start; any other setUp revert is setup-reverted', () => {
    const doc = (reason: string) =>
      JSON.stringify({ 't:S': { test_results: { 'setUp()': { status: 'Failure', reason, counterexample: null } } } });
    const own = parseStandardForgeJson(doc('specfirst: asset transfers are restricted for test users (no revert data)'), [ERC4626_PROPERTIES[0]!])!;
    expect(own[0]).toMatchObject({ status: 'not_applicable', reason: `${RESTRICTED_ASSET_NOTE} (no revert data)` });
    const other = parseStandardForgeJson(doc('x specfirst: asset transfers are restricted for test users (selector 0x12345678)'), [ERC4626_PROPERTIES[0]!])!;
    expect(other[0]).toMatchObject({ status: 'not_applicable', reason: 'setUp failed: x specfirst: asset transfers are restricted for test users (selector 0x12345678)' });
    expect(skipReasonOf(other)).toBe('setup-reverted');
  });
});
