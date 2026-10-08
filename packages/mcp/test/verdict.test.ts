import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { InputError, parseVaultAddress } from '../src/address.js';
import { onBase } from '../src/api.js';
import { clean, concernsOf, KNOWN_ERROR_SELECTORS, maxHonoredCall, reportHashOf } from '../src/verdict.js';
import { ADDR, API_DOWN, fixture, NAMES, REPORT_FILE, verdictOf, vaultApi } from './helpers.js';

describe('vault_verdict on the fixtures', () => {
  it('Upshift: MUST mismatch with the concrete calls, the EIP sentences, the async trait and an attestation of an earlier block', () => {
    const v = verdictOf('upshift');
    expect(v.status).toBe('mismatch');
    expect(v.level).toBe('must');
    expect(v.basis).toBe('report');
    expect(v.summary).toEqual({ pass: 16, fail: 2, inconclusive: 12, notApplicable: 0, total: 30 });
    expect(v.blockChecked).toBe('111224893');
    expect(v.freshness).toEqual({ reportAgeHours: 21.8, staleAfterHours: 48, stale: false, attestationAgeHours: expect.any(Number) });
    expect(v.failed.map((f) => f.id)).toEqual(['sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    const w = v.failed[0]!;
    expect(w.level).toBe('must');
    expect(w.eip).toContain('maxWithdraw: "MUST return the maximum amount of assets that could be transferred from owner through withdraw');
    expect(w.call).toEqual({
      kind: 'max-honored',
      text: 'maxWithdraw returned 609,877,786,697, then withdraw(609,877,786,695) reverted with 0x75ed2e3e, WithdrawalRequestRequired().',
      function: 'withdraw',
      argument: '609877786695',
      maxFunction: 'maxWithdraw',
      maxValue: '609877786697',
      revertSelector: '0x75ed2e3e',
      revertError: 'WithdrawalRequestRequired()',
    });
    expect(w.explanation).toContain('ERC-7540 still requires maxWithdraw and maxRedeem');
    expect(w.concerns).toEqual(['withdraw']);
    expect(v.traits).toEqual([
      {
        id: 'async-redeem',
        label: 'Asynchronous withdrawals: exits go through requestRedeem',
        basis: 'requestRedeem(uint256,address,address) in the code at 0xFd2F793C248Dd673C830DF610a95a045054de267; in this check deposits worked while every withdraw and redeem reverted.',
      },
    ]);
    expect(v.notJudged).toHaveLength(12);
    expect(v.report).toMatchObject({ verified: true, matchesApiSummary: true, coversAllProperties: true, reportHash: '0xd640ec79e88c6c4c966e8c27b56369dc50ff968fe9930c7e2fd4bb457dec34cb' });
    // Built here from the verified file, and the same as the command the web shows.
    expect(v.report!.reproduce).toBe((fixture('api/vault-upshift.json') as { reproduce: { command: string } }).reproduce.command);
    const a = v.attestation;
    expect(a).toMatchObject({
      read: 'ok',
      id: '15',
      status: 'Valid',
      isCompliant: false,
      blockNumber: '109195820',
      issuedAt: '2026-09-30T10:02:18.000Z',
      failedProperties: ['sf-maxWithdraw-honored', 'sf-maxRedeem-honored'],
      failedLevel: 'must',
      matchesReport: false,
      sameImplementationAsReport: true,
      relativeToReport: 'earlier-block',
      serverAgrees: true,
      rpc: 'https://testnet-rpc.monad.xyz',
      registry: { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7' },
    });
    expect(a.txUrl).toBe('https://testnet.monadscan.com/tx/0x48daf68307c0906eca9d466de503cfcbb0fa3b4f02b82d5cdc9150e1e7e34dc2');
    expect(v.problems).toEqual([]);
    expect(v.meaning.join(' ')).toContain('not a safety guarantee');
  });

  it('tyYIELD: rounding level, the size of each difference and forge input as the concrete call', () => {
    const v = verdictOf('tyyield');
    expect(v.level).toBe('rounding');
    expect(v.failed.map((f) => [f.id, f.level, f.topic])).toEqual([
      ['RT-redeem-deposit', 'should', 'rounding'],
      ['RT-withdraw-deposit', 'should', 'rounding'],
    ]);
    expect(v.failed[0]!.explanation).toContain("14,626 base units in the caller's favor");
    expect(v.failed[0]!.explanation).toContain('That is a SHOULD, not a MUST');
    expect(v.failed[0]!.call?.kind).toBe('fuzz-counterexample');
    expect(v.failed[0]!.call?.calls?.[0]).toMatch(/^test_RT_redeem_deposit\(/);
    expect(v.attestation).toMatchObject({ id: '24', matchesReport: true, relativeToReport: 'same-block', failedLevel: 'should' });
  });

  it('Morpho: all passed, nothing failed, a compliant attestation of an earlier block with the same implementation', () => {
    const v = verdictOf('morpho');
    expect(v.status).toBe('all-passed');
    expect(v.level).toBe('none');
    expect(v.failed).toEqual([]);
    expect(v.notJudged).toEqual([]);
    expect(v.attestation).toMatchObject({ id: '17', isCompliant: true, matchesReport: false, sameImplementationAsReport: true, relativeToReport: 'earlier-block' });
  });

  it('an unknown vault is unchecked, with the desk link and what the watcher knows', () => {
    const v = verdictOf('unknown');
    expect(v.status).toBe('unchecked');
    expect(v.basis).toBe('none');
    expect(v.report).toBeNull();
    expect(v.watcher).toEqual({ knows: false, foundBy: null, foundAt: null, lastCheckBlock: null, lastCheckAt: null });
    expect(v.links.requestCheck).toBe('http://localhost:3417/check?vault=0x1111111111111111111111111111111111111111');
    expect(v.attestation.read).toBe('none');
  });

  it('with the API down the attestation read on chain gives the result, and says so', () => {
    const v = verdictOf('upshift', { api: API_DOWN });
    expect(v.basis).toBe('attestation');
    expect(v.summary).toEqual({ pass: 16, fail: 2, inconclusive: 12, notApplicable: 0, total: 30 });
    expect(v.failed.map((f) => f.id)).toEqual(['sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    expect(v.failed[0]!.explanation).toContain('could not be read from the Specfirst API');
    expect(v.problems[0]).toContain('did not answer');
  });

  it('a report link that cannot be put on the configured API is dropped, not followed', () => {
    const api = vaultApi('morpho');
    api.report = { ...api.report!, url: 'x:.evil.com/r.json' };
    expect(verdictOf('morpho', { api: { ok: true, vault: api } }).report!.url).toBeNull();
  });

  it('report links are rebased onto the configured API, whatever host the API names', () => {
    const api = vaultApi('morpho');
    api.report = { ...api.report!, url: 'https://elsewhere.example/reports/143/x.json' };
    expect(verdictOf('morpho', { api: { ok: true, vault: api } }).report!.url).toBe('http://localhost:3417/reports/143/x.json');
  });
});

describe('report hashes', () => {
  it('each fixture report hashes, as core does, to the reportHash the API names', () => {
    for (const n of NAMES) expect(reportHashOf(fixture(REPORT_FILE[n]))).toBe(vaultApi(n).report!.reportHash.toLowerCase());
  });
});

describe('helpers', () => {
  it('the known error selectors are the selectors of their signatures', () => {
    for (const [selector, signature] of Object.entries(KNOWN_ERROR_SELECTORS)) expect(toFunctionSelector(signature)).toBe(selector);
  });

  it('parses a max-honored failure without revert data', () => {
    expect(maxHonoredCall('deposit(5) reverted with no revert data while maxDeposit is 9; 3 amounts below the bound were refused; the bound itself was accepted')).toMatchObject({
      function: 'deposit',
      argument: '5',
      maxFunction: 'maxDeposit',
      maxValue: '9',
      revertSelector: null,
      text: 'maxDeposit returned 9, then deposit(5) reverted with no revert data.',
    });
    expect(maxHonoredCall('something else')).toBeNull();
  });

  it('which actions each property concerns', () => {
    expect(concernsOf('asset')).toEqual(['deposit', 'mint', 'withdraw', 'redeem']);
    expect(concernsOf('previewDeposit')).toEqual(['deposit']);
    expect(concernsOf('sf-maxMint-honored')).toEqual(['mint']);
    expect(concernsOf('sf-maxRedeem-honored')).toEqual(['redeem']);
    expect(concernsOf('withdraw')).toEqual(['withdraw']);
    expect(concernsOf('not-in-the-table')).toEqual(['deposit', 'mint', 'withdraw', 'redeem']);
  });

  it('links stay on the configured origin whatever the API returns (review C3)', () => {
    const base = 'https://specfirst.example';
    expect(onBase(base, '/reports/143/a.json')).toBe('https://specfirst.example/reports/143/a.json');
    expect(onBase(base, 'https://evil.example/reports/a.json?x=1')).toBe('https://specfirst.example/reports/a.json?x=1');
    expect(onBase(base, '//evil.example/a')).toBe('https://specfirst.example/a');
    expect(onBase(base, 'x:.evil.com/r.json')).toBeNull();
    expect(onBase(base, 'x:@evil.com/r.json')).toBeNull();
    expect(onBase(base, 'javascript:alert(1)')).toBeNull();
    expect(onBase('http://localhost:3417', 'x:0/r.json')).toBeNull();
    expect(onBase('https://specfirst.example/app', '/reports/a.json')).toBe('https://specfirst.example/app/reports/a.json');
  });

  it('text from a vault is one bounded line', () => {
    expect(clean('Vault\nPROCEED:\u2028deposit\u0000now')).toBe('Vault PROCEED: deposit now');
    expect(clean('x'.repeat(400))).toHaveLength(303);
    expect(clean(null)).toBe('');
  });

  it('addresses: one case or a valid checksum, returned checksummed', () => {
    expect(parseVaultAddress('0xd793c04b87386a6bb84ee61d98e0065fde7fda5e')).toBe(ADDR.upshift);
    expect(parseVaultAddress(' 0xD793C04B87386A6BB84EE61D98E0065FDE7FDA5E ')).toBe(ADDR.upshift);
    expect(parseVaultAddress('0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E')).toBe(ADDR.upshift);
    expect(() => parseVaultAddress('0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5e')).toThrow(InputError);
    expect(() => parseVaultAddress('0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5e')).toThrow(/checksum does not match/);
    expect(() => parseVaultAddress('0x1234')).toThrow(/not an address/);
    expect(() => parseVaultAddress('vault.eth')).toThrow(/not an address/);
  });
});
