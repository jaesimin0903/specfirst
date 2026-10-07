import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  ASYNC_REDEEM_REQUEST_FUNCTIONS,
  detectTraits,
  erc7540InterfacesOf,
  exitEvidenceOf,
  maxZeroNote,
  missingPrecompileNote,
  pushedSelectors,
  requestFunctionsIn,
  standardCheckReportSchema,
  type IdentityClient,
  type StandardCheckReport,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
/** Reports of the 2026-09-30 Monad batch, block 109195820, harness 0x5b48d421 (before traits existed). */
const report = async (address: string, file: string) =>
  standardCheckReportSchema.parse(JSON.parse(await readFile(path.join(repo, 'certs/checks/143', address, file), 'utf8'))) as StandardCheckReport;
const UPSHIFT = () => report('0xd793c04b87386a6bb84ee61d98e0065fde7fda5e', '109195820-2360d95c83b2c541.json');
const MORPHO = () => report('0x802c91d807a8daca257c4708ab264b6520964e44', '109195820-45882207749f22e5.json');

const STAKING = '0x0000000000000000000000000000000000001000';
const REQUEST_REDEEM = toFunctionSelector('requestRedeem(uint256,address,address)').slice(2);
const GVAULT = toFunctionSelector('requestRedeemGVault(uint256,address,address,uint64)').slice(2);
/** PUSH4 <selector> EQ, the way solc's dispatcher compares. */
const dispatch = (sel: string) => `63${sel}14`;

describe('pushedSelectors and requestFunctionsIn', () => {
  it('finds PUSH4 selectors in the dispatcher, in ASYNC_REDEEM_REQUEST_FUNCTIONS order', () => {
    expect(ASYNC_REDEEM_REQUEST_FUNCTIONS).toEqual(['requestRedeem(uint256,address,address)', 'requestRedeemGVault(uint256,address,address,uint64)']);
    expect(REQUEST_REDEEM).toBe('7d41c86e');
    const code = `0x${dispatch(GVAULT)}${dispatch(REQUEST_REDEEM)}00` as Hex;
    expect(pushedSelectors(code).has('0x7d41c86e')).toBe(true);
    expect(requestFunctionsIn(code)).toEqual(['requestRedeem(uint256,address,address)', 'requestRedeemGVault(uint256,address,address,uint64)']);
  });

  it('ignores the bytes inside a longer PUSH immediate and inside the CBOR tail', () => {
    // PUSH32 whose data happens to hold 63 7d41c86e: data, not an instruction.
    const push32 = `7f${`63${REQUEST_REDEEM}`.padEnd(64, '0')}`;
    expect(requestFunctionsIn(`0x${push32}00` as Hex)).toEqual([]);
    // CBOR tail {"solc": h'63 7d41c86e'} (one entry), then its 2-byte length 0x000c.
    const tail = `a164736f6c634563${REQUEST_REDEEM}000c`;
    expect(requestFunctionsIn(`0x00${tail}` as Hex)).toEqual([]);
    expect(requestFunctionsIn('0x')).toEqual([]);
  });
});

describe('exitEvidenceOf', () => {
  it('Upshift earnAUSD at block 109195820: deposit passed, withdraw and redeem rejected every input, the sf- calls reverted: exits-rejected', async () => {
    expect(exitEvidenceOf((await UPSHIFT()).results)).toBe('exits-rejected');
  });

  it('a vault whose exits pass is never async by the run', async () => {
    expect(exitEvidenceOf((await MORPHO()).results)).toBeNull();
  });

  it('a single passing exit property rules it out; max values of 0 count as blocked', async () => {
    const upshift = (await UPSHIFT()).results;
    const withPass = upshift.map((r) => (r.id === 'sf-maxRedeem-honored' ? { ...r, status: 'pass' as const, reason: undefined } : r));
    expect(exitEvidenceOf(withPass)).toBeNull();
    const honest = upshift.map((r) =>
      r.id === 'sf-maxWithdraw-honored'
        ? { ...r, status: 'not_applicable' as const, reason: maxZeroNote('maxWithdraw') }
        : r.id === 'sf-maxRedeem-honored'
          ? { ...r, status: 'not_applicable' as const, reason: maxZeroNote('maxRedeem') }
          : r,
    );
    expect(exitEvidenceOf(honest)).toBe('exits-rejected');
    // Deposits that never worked say nothing about exits.
    const noDeposit = upshift.map((r) => (r.id === 'deposit' || r.id === 'sf-maxDeposit-honored' ? { ...r, status: 'inconclusive' as const } : r));
    expect(exitEvidenceOf(noDeposit)).toBeNull();
  });

  it('every exit property inconclusive with inputs that needed a missing precompile: not-exercised', async () => {
    const all = (await UPSHIFT()).results.map((r) => ({ ...r, status: 'inconclusive' as const, reason: missingPrecompileNote(STAKING) }));
    expect(exitEvidenceOf(all)).toBe('not-exercised');
    // gMON at block 111051869: most rejected inputs needed 0x1000, a few deposits reverted on their own.
    const mixed = all.map((r) => ({ ...r, reason: `\`vm.assume\` rejected too many inputs (4096 allowed); ${missingPrecompileNote(STAKING, 3923)}` }));
    expect(exitEvidenceOf(mixed)).toBe('not-exercised');
    expect(exitEvidenceOf(all.map((r) => (r.id === 'redeem' ? { ...r, reason: '`vm.assume` rejected too many inputs (4096 allowed)' } : r)))).toBeNull();
  });
});

describe('erc7540InterfacesOf and detectTraits (mock client)', () => {
  const VAULT: Address = '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E';
  const IMPL: Address = '0xFd2F793C248Dd673C830DF610a95a045054de267';
  const client = (opts: { code?: Hex; supports?: (id: string) => boolean | Error }): IdentityClient & { codeReads: Address[] } => {
    const codeReads: Address[] = [];
    return {
      codeReads,
      getCode: async ({ address }: { address: Address }) => {
        codeReads.push(address);
        return opts.code ?? '0x';
      },
      getStorageAt: async () => '0x',
      readContract: async ({ args }: { args: readonly [Hex] }) => {
        if (!opts.supports) throw Object.assign(new Error('execution reverted'), { name: 'ContractFunctionExecutionError' });
        const v = opts.supports(args[0]);
        if (v instanceof Error) throw v;
        return v;
      },
    } as unknown as IdentityClient & { codeReads: Address[] };
  };
  const erc7540 = (id: string) => id === '0x01ffc9a7' || id === '0x620ee8e4' || id === '0xe3bc4e65';

  it('ERC-165: null without it (revert, or true for 0xffffffff), the three ids when it answers', async () => {
    expect(await erc7540InterfacesOf(client({}), VAULT, 1n)).toBeNull();
    expect(await erc7540InterfacesOf(client({ supports: () => true }), VAULT, 1n)).toBeNull();
    expect(await erc7540InterfacesOf(client({ supports: erc7540 }), VAULT, 1n)).toEqual({ asyncRedeem: true, asyncDeposit: false, operator: true });
  });

  it('ERC-165: an RPC failure is thrown, never read as "no ERC-165"', async () => {
    const down = client({ supports: () => Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' }) });
    await expect(erc7540InterfacesOf(down, VAULT, 1n)).rejects.toThrow(/fetch failed/);
  });

  it('Upshift: the implementation code is read, requestRedeem found, no ERC-165: the trait with run exits-rejected', async () => {
    const c = client({ code: `0x${dispatch(REQUEST_REDEEM)}00` });
    const traits = await detectTraits(c, VAULT, { implementation: { address: IMPL } as never }, (await UPSHIFT()).results, 109195820n);
    expect(traits).toEqual([
      { id: 'async-redeem', evidence: { codeAddress: IMPL, requestFunctions: ['requestRedeem(uint256,address,address)'], erc165: null, run: 'exits-rejected' } },
    ]);
    expect(c.codeReads).toEqual([IMPL]);
  });

  it('no request function in the code: no trait; a run that does not point that way reads nothing from the chain', async () => {
    const noSelector = client({ code: '0x00' });
    expect(await detectTraits(noSelector, VAULT, { implementation: null }, (await UPSHIFT()).results, 1n)).toEqual([]);
    const passing = client({ code: `0x${dispatch(REQUEST_REDEEM)}00` });
    expect(await detectTraits(passing, VAULT, { implementation: null }, (await MORPHO()).results, 1n)).toEqual([]);
    expect(passing.codeReads).toEqual([]);
  });

  it('not-exercised needs ERC-165 to declare asynchronous redemption', async () => {
    const results = (await UPSHIFT()).results.map((r) => ({ ...r, status: 'inconclusive' as const, reason: missingPrecompileNote(STAKING) }));
    const code = `0x${dispatch(REQUEST_REDEEM)}${dispatch(GVAULT)}00` as Hex;
    expect(await detectTraits(client({ code }), VAULT, { implementation: null }, results, 1n)).toEqual([]);
    expect(await detectTraits(client({ code, supports: erc7540 }), VAULT, { implementation: null }, results, 1n)).toEqual([
      {
        id: 'async-redeem',
        evidence: {
          codeAddress: VAULT,
          requestFunctions: ['requestRedeem(uint256,address,address)', 'requestRedeemGVault(uint256,address,address,uint64)'],
          erc165: { asyncRedeem: true, asyncDeposit: false, operator: true },
          run: 'not-exercised',
        },
      },
    ]);
  });
});
