// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toFunctionSelector } from 'viem';
import { NATIVE_ASSET_REASON, RESTRICTED_ASSET_NOTE as CORE_RESTRICTED_NOTE, erc7575Reason, maxZeroNote } from '@specfirst/core';
import {
  KNOWN_ERROR_SELECTORS,
  RESTRICTED_ASSET_NOTE,
  classifyReason,
  describeFailure,
  describeKeyKind,
  effectiveSkipReason,
  explainResult,
  explainSkip,
  groupDigits,
  parseMaxHonoredFailure,
  verdictSentence,
} from '../lib/board/reasons';

const UPSHIFT_FAIL = 'withdraw(1) reverted with selector 0x75ed2e3e while maxWithdraw is 3';

describe('strings copied from @specfirst/core', () => {
  it('match core, so classification cannot drift from what the CLI writes', () => {
    expect(RESTRICTED_ASSET_NOTE).toBe(CORE_RESTRICTED_NOTE);
    expect(classifyReason('not_applicable', maxZeroNote('maxWithdraw'))).toBe('max-zero');
    expect(classifyReason('not_applicable', NATIVE_ASSET_REASON)).toBe('native-asset');
    expect(classifyReason('not_applicable', erc7575Reason('0x1111111111111111111111111111111111111111'))).toBe('separate-share-token');
    expect(classifyReason('not_applicable', `${CORE_RESTRICTED_NOTE} (selector 0x82b42900)`)).toBe('asset-transfer-restricted');
  });

  it('names every known selector correctly', () => {
    for (const [selector, signature] of Object.entries(KNOWN_ERROR_SELECTORS)) {
      expect(toFunctionSelector(`function ${signature}`)).toBe(selector);
    }
  });
});

describe('classifyReason', () => {
  it.each([
    ['inconclusive', '`vm.assume` rejected too many inputs (4096 allowed)', 'inputs-rejected'],
    ['inconclusive', "the asset's balance slot cannot be written, test users cannot be funded (non-standard token): stdStorage find(StdStorage): No storage use detected for target.", 'unfundable-asset'],
    ['inconclusive', 'fork RPC error, rerun or pass another --rpc: EVM error; database error: failed to get storage', 'rpc-error'],
    ['not_applicable', 'setUp failed: EvmError: Revert', 'setup-reverted'],
    ['inconclusive', 'no result in forge output', 'other'],
  ] as const)('%s "%s" is %s', (status, reason, category) => {
    expect(classifyReason(status, reason)).toBe(category);
  });

  it('gives pass and fail no category', () => {
    expect(classifyReason('pass', undefined)).toBeNull();
    expect(classifyReason('fail', UPSHIFT_FAIL)).toBeNull();
  });
});

describe('explainResult', () => {
  it('pass states the runs and nothing more', () => {
    expect(explainResult({ status: 'pass', runs: 16 })).toBe('No counterexample in 16 fuzz runs at this block.');
    expect(explainResult({ status: 'pass' })).toBe('No counterexample at this block.');
  });

  it('a max-honored failure says what the vault promised, what reverted and which rule it breaks', () => {
    expect(parseMaxHonoredFailure(UPSHIFT_FAIL)).toEqual({ action: 'withdraw', amount: '1', selector: '0x75ed2e3e', maxName: 'maxWithdraw', max: '3' });
    const { finding, rule } = describeFailure(UPSHIFT_FAIL);
    expect(finding).toBe('maxWithdraw was 3, but withdraw(1) reverted with 0x75ed2e3e, WithdrawalRequestRequired().');
    expect(rule).toMatch(/^EIP-4626: maxWithdraw MUST return the maximum amount of assets withdraw accepts without reverting, and 0 while withdrawals are disabled\.$/);
    expect(explainResult({ status: 'fail', reason: UPSHIFT_FAIL })).toBe(`${finding} ${rule}`);
  });

  it('groups digits of large amounts and keeps unknown selectors raw', () => {
    const { finding } = describeFailure('redeem(643765674186) reverted with selector 0x90b8ec18 while maxRedeem is 846667177803');
    expect(finding).toBe('maxRedeem was 846,667,177,803, but redeem(643,765,674,186) reverted with 0x90b8ec18.');
    expect(describeFailure('deposit(5) reverted with no revert data while maxDeposit is 9').finding).toBe(
      'maxDeposit was 9, but deposit(5) reverted with no revert data.',
    );
  });

  it('an upstream failure falls back to forge\'s own reason', () => {
    expect(explainResult({ status: 'fail', reason: 'Error: a <=~ b not satisfied' })).toBe('Forge found a counterexample: Error: a <=~ b not satisfied');
    expect(describeFailure(undefined)).toEqual({ finding: 'Forge found a counterexample.', rule: null });
  });

  it('inputs rejected, with and without deposits reverting below maxDeposit', () => {
    expect(explainResult({ status: 'inconclusive', reason: '`vm.assume` rejected too many inputs (4096 allowed)' })).toBe(
      'Never exercised: the vault rejected nearly every amount the fuzzer tried, and forge gave up after 4096 discarded inputs.',
    );
    const withNote = explainResult({
      status: 'inconclusive',
      reason: '`vm.assume` rejected too many inputs (4096 allowed); deposit reverted below maxDeposit 37 times (inputs discarded, EIP-4626 says it must not revert)',
    });
    expect(withNote).toBe(
      'Never exercised: the vault rejected nearly every amount the fuzzer tried, and forge gave up after 4096 discarded inputs. Along the way deposit reverted 37 times at amounts up to maxDeposit; some of these may be tiny amounts that round to zero shares, which many vaults reject. Those inputs were discarded, as upstream does, so this stays inconclusive; whether deposit honors maxDeposit is judged by sf-maxDeposit-honored.',
    );
    // The count includes reverts EIP-4626 does not forbid (a 1-unit deposit that mints 0 shares), so the page must not call them violations.
    expect(withNote).not.toMatch(/must not|EIP-4626 says/);
  });

  it('not applicable reasons say why without blaming the vault', () => {
    expect(explainResult({ status: 'not_applicable', reason: maxZeroNote('maxRedeem') })).toBe(
      'Nothing to honor: maxRedeem returned 0 for every test user. EIP-4626 allows a max to underestimate, so there was no advertised amount to hold the vault to.',
    );
    expect(explainResult({ status: 'not_applicable', reason: `${RESTRICTED_ASSET_NOTE} (selector 0x82b42900)` })).toBe(
      'Not applicable: the asset restricts transfers, through an allowlist or similar, and both suites need test balances that move freely. The test transfer was refused with 0x82b42900, Unauthorized().',
    );
    expect(explainResult({ status: 'not_applicable', reason: erc7575Reason('0x1111111111111111111111111111111111111111') })).toMatch(
      /^Not applicable: this is an ERC-7575 vault whose shares are a separate token at 0x1111111111111111111111111111111111111111\./,
    );
    expect(explainResult({ status: 'not_applicable', reason: NATIVE_ASSET_REASON })).toMatch(/native coin/);
    expect(explainResult({ status: 'not_applicable', reason: 'setUp failed: EvmError: Revert' })).toBe(
      'Not applicable: the suite could not start on this contract. setUp reverted with "EvmError: Revert".',
    );
  });

  it('other inconclusive results', () => {
    expect(explainResult({ status: 'inconclusive', reason: 'fork RPC error, rerun or pass another --rpc: EVM error; database error: x' })).toMatch(/says nothing about the vault/);
    expect(explainResult({ status: 'inconclusive', reason: "the asset's balance slot cannot be written, x" })).toMatch(/could not be given the asset/);
    expect(explainResult({ status: 'inconclusive', reason: 'no result in forge output' })).toBe('Inconclusive: forge reported no result for this property.');
    expect(explainResult({ status: 'inconclusive', reason: 'forge status Skipped' })).toBe('Inconclusive: forge ended this property with status Skipped.');
    expect(explainResult({ status: 'inconclusive', reason: 'something new' })).toBe('Inconclusive: something new');
  });
});

describe('effectiveSkipReason', () => {
  const na = (reason: string) => Array.from({ length: 3 }, () => ({ status: 'not_applicable' as const, reason }));

  it('prefers the report\'s skipReason (schemaVersion 3)', () => {
    expect(effectiveSkipReason({ skipReason: 'asset-transfer-restricted', vaultKind: 'erc4626', results: na('anything') })).toBe('asset-transfer-restricted');
    expect(effectiveSkipReason({ skipReason: null, vaultKind: 'erc4626', results: [{ status: 'pass' }] })).toBeNull();
  });

  it('derives it for older reports from vaultKind, then from the reasons', () => {
    expect(effectiveSkipReason({ vaultKind: 'erc7575', results: na('x') })).toBe('separate-share-token');
    expect(effectiveSkipReason({ vaultKind: 'erc7535', results: na('x') })).toBe('native-asset');
    expect(effectiveSkipReason({ results: na(`${RESTRICTED_ASSET_NOTE} (no revert data)`) })).toBe('asset-transfer-restricted');
    expect(effectiveSkipReason({ results: na('setUp failed: nope') })).toBe('setup-reverted');
    expect(effectiveSkipReason({ results: [...na('x'), { status: 'pass' }] })).toBeNull();
  });

  it('every skip reason has a sentence', () => {
    for (const s of ['native-asset', 'separate-share-token', 'asset-transfer-restricted', 'setup-reverted'] as const) {
      expect(explainSkip(s)).toMatch(/^No property applies\./);
    }
  });
});

describe('verdictSentence and formatting', () => {
  it('one sentence per vault status', () => {
    expect(verdictSentence('mismatch', { pass: 16, fail: 2, inconclusive: 12, notApplicable: 0 }, '109195820')).toBe(
      "2 of 30 properties failed at block 109,195,820. The vault's behavior contradicts an EIP-4626 MUST sentence.",
    );
    expect(verdictSentence('complete', { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, '1')).toMatch(/not a safety guarantee/);
    expect(verdictSentence('partial', { pass: 26, fail: 0, inconclusive: 0, notApplicable: 4 }, '1')).toBe(
      '26 of 30 properties passed and none failed at block 1. 4 could not be exercised.',
    );
    expect(verdictSentence('not_applicable', { pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 }, '1')).toBe('None of the 30 properties apply to this vault at block 1.');
  });

  it('groupDigits and describeKeyKind', () => {
    expect(groupDigits('5192296858534827628530496329220095')).toBe('5,192,296,858,534,827,628,530,496,329,220,095');
    expect(groupDigits('12')).toBe('12');
    expect(groupDigits('0x12')).toBe('0x12');
    expect(describeKeyKind({ of: 'implementation', hash: 'metadataHash+maskedCodeHash' })).toBe(
      'Implementation behind the proxy: same compiler metadata and same code with immutables masked',
    );
    expect(describeKeyKind({ of: 'self', hash: 'maskedCodeHash' })).toBe("The vault's own code: same code with immutables masked, no compiler metadata");
  });
});
