import { toFunctionSelector } from 'viem';
import { z } from 'zod';
import { callsOf, extractJson, formatForgeCall, type ForgeTestResult } from '../fuzz/forge.js';
import type { StandardProperty } from './erc4626.js';

/**
 * 2 adds `vaultKind`, 3 adds `skipReason`, 4 adds `traits`. Reports of earlier versions (without those fields)
 * still validate, so reports written before a change, and attestations built from them, stay readable.
 */
export const STANDARD_CHECK_SCHEMA_VERSION = 4;
/** CLI exit code when any standard property fails on the checked contract. */
export const STANDARD_CHECK_FAILED_EXIT_CODE = 16;
/**
 * CLI exit code when nothing failed but the check is incomplete: no property passed, or at least one is
 * inconclusive or not applicable. Inconclusive never counts as pass, so this is "not verified".
 */
export const STANDARD_CHECK_INCOMPLETE_EXIT_CODE = 17;
export const STANDARDS = ['erc4626'] as const;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte 0x hex string');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address');
const decimal = z.string().regex(/^\d+$/, 'expected a non-negative decimal integer string');
/** No leading zeros: one block has one spelling, so its reportHash and report file name are unique. */
const canonicalDecimal = z.string().regex(/^(0|[1-9]\d*)$/, 'expected a decimal integer string without leading zeros');
const count = z.number().int().nonnegative();

export const standardNameSchema = z.enum(STANDARDS);

/**
 * What the pre-checks found before forge ran. erc4626: a vault that is its own share token (the suites
 * run). erc7535: asset() is the native-asset sentinel. erc7575: share() names a separate share token.
 * For the last two forge does not run and every property is not_applicable.
 */
export const vaultKindSchema = z.enum(['erc4626', 'erc7535', 'erc7575']);
export type VaultKind = z.infer<typeof vaultKindSchema>;

/**
 * Why no property was exercised, when that is the case (every result not_applicable, or every result
 * inconclusive with inputs that needed a precompile the fork lacks); null otherwise.
 * native-asset and separate-share-token come from the pre-checks (forge did not run);
 * asset-transfer-restricted from the harness's transfer probe; missing-precompile from its deposit probe;
 * setup-reverted from any other setUp revert.
 */
export const skipReasonSchema = z.enum(['native-asset', 'separate-share-token', 'asset-transfer-restricted', 'missing-precompile', 'setup-reverted']);
export type SkipReason = z.infer<typeof skipReasonSchema>;

/** The fixed prefix both suites' setUp revert with when test users cannot move the asset. */
export const RESTRICTED_ASSET_PREFIX = 'specfirst: asset transfers are restricted for test users';
/** Reason text of every property of a vault whose asset restricts transfers. */
export const RESTRICTED_ASSET_NOTE = 'asset token restricts transfers (allowlist or similar); both suites need freely transferable test balances';
/**
 * Start of the reason of a property whose inputs all needed a Monad precompile forge's EVM lacks (staking 0x1000,
 * reserve balance 0x1001, P256 0x0100); see missingPrecompileNote.
 */
export const MISSING_PRECOMPILE_NOTE = 'a vault call reached Monad precompile';
export type StandardName = z.infer<typeof standardNameSchema>;

/**
 * Request functions that mark an asynchronous exit when the code exposes them: ERC-7540's requestRedeem, and
 * Magma gMON's requestRedeemGVault (the variant met in the Upshift and Magma sources on Monad; Upshift earnAUSD
 * exposes requestRedeem itself).
 */
export const ASYNC_REDEEM_REQUEST_FUNCTIONS = ['requestRedeem(uint256,address,address)', 'requestRedeemGVault(uint256,address,address,uint64)'] as const;
/** ERC-165 interface ids EIP-7540 defines: asynchronous redemption, asynchronous deposit, operator methods. */
export const ERC7540_INTERFACE_IDS = { asyncRedeem: '0x620ee8e4', asyncDeposit: '0xce3bbe50', operator: '0xe3bc4e65' } as const;

/**
 * Why a vault carries the async-redeem trait. codeAddress: the code that was read (the implementation behind a
 * proxy, else the vault). requestFunctions: the request functions whose selector that code pushes. erc165: what
 * supportsInterface answered for the ERC-7540 ids, null when the vault does not implement ERC-165. run: what this
 * check showed. exits-rejected: deposit worked while withdraw and redeem rejected every input (the upstream
 * properties ran out of inputs and the sf- calls reverted within their max, or the max was 0). not-exercised: the
 * fork could not run the vault (a Monad precompile it lacks), so the trait rests on the code and on the vault's
 * own ERC-165 answer for asynchronous redemption.
 */
export const asyncRedeemEvidenceSchema = z
  .object({
    codeAddress: address,
    requestFunctions: z.array(z.enum(ASYNC_REDEEM_REQUEST_FUNCTIONS)).min(1),
    erc165: z.object({ asyncRedeem: z.boolean(), asyncDeposit: z.boolean(), operator: z.boolean() }).strict().nullable(),
    run: z.enum(['exits-rejected', 'not-exercised']),
  })
  .strict();
export type AsyncRedeemEvidence = z.infer<typeof asyncRedeemEvidenceSchema>;

/**
 * A capability of the vault, with the evidence for it. Context only: a trait never changes a property's status.
 * async-redeem: exits go through a request function (ERC-7540 style). ERC-7540 still requires maxWithdraw and
 * maxRedeem to report what can be claimed now, so such a vault that reports its full balance still fails.
 */
export const vaultTraitSchema = z.object({ id: z.literal('async-redeem'), evidence: asyncRedeemEvidenceSchema }).strict();
export type VaultTrait = z.infer<typeof vaultTraitSchema>;

/**
 * pass: the property held on every fuzz run. fail: forge found a counterexample.
 * inconclusive: the property could not be exercised (every input rejected, `deal` could not fund users, the
 * fork RPC failed, or a vault call stopped at a precompile the fork lacks, including in setUp).
 * not_applicable: the suite could not start on this contract (setUp reverted, e.g. no asset()).
 * Policy: only pass counts as verified. inconclusive and not_applicable are "not verified" (exit 17), so a
 * contract that imitates a forge message to turn a fail into inconclusive gains nothing.
 */
export const standardPropertyStatusSchema = z.enum(['pass', 'fail', 'inconclusive', 'not_applicable']);
export type StandardPropertyStatus = z.infer<typeof standardPropertyStatusSchema>;

export const standardPropertyResultSchema = z
  .object({
    id: z.string().min(1),
    test: z.string().min(1),
    description: z.string(),
    status: standardPropertyStatusSchema,
    /** Fuzz runs forge completed; 0 or absent when the property never ran. */
    runs: count.optional(),
    /** Why the property failed, was inconclusive or not applicable. */
    reason: z.string().optional(),
    counterexample: z
      .object({
        /** The failing test call, e.g. `test_previewDeposit(Init({ user: [...] }), 123)`. */
        calls: z.array(z.string()),
        calldata: z.string().optional(),
        /** forge's decoded logs, e.g. the upstream "a <=~ b not satisfied" lines with both values. */
        logs: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StandardPropertyResult = z.infer<typeof standardPropertyResultSchema>;

const hexBytes = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/, 'expected 0x hex bytes');
const fingerprintShape = {
  codeHash: hex32,
  /** Solidity CBOR metadata ipfs/bzzr value; null when the code carries none. */
  metadataHash: hexBytes.nullable(),
  /** keccak256 of the code without CBOR tail and PUSH32 immediates (immutables); null for empty code. */
  maskedCodeHash: hex32.nullable(),
};

export const implementationIdentitySchema = z
  .object({
    ...fingerprintShape,
    codeSize: count,
    proxy: z
      .union([
        z.object({ kind: z.enum(['eip1967', 'eip1967-beacon', 'eip1167']), implementation: address, beacon: address.optional() }).strict(),
        z.object({ kind: z.literal('unknown') }).strict(),
      ])
      .nullable(),
    implementation: z.object({ address, ...fingerprintShape }).strict().nullable(),
    implementationKey: hex32,
    implementationKeyKind: z
      .object({ of: z.enum(['implementation', 'self']), hash: z.enum(['metadataHash+maskedCodeHash', 'maskedCodeHash', 'codeHash']) })
      .strict(),
  })
  .strict();

export const standardCheckSummarySchema = z
  .object({ pass: count, fail: count, inconclusive: count, notApplicable: count })
  .strict();
export type StandardCheckSummary = z.infer<typeof standardCheckSummarySchema>;

/**
 * `.specfirst/checks/<chainId>/<address>/<block>.json`: third-party standard properties run on a fork of a
 * deployed contract at a pinned block. Nothing in it comes from the contract's author.
 */
export const standardCheckReportSchema = z
  .object({
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(STANDARD_CHECK_SCHEMA_VERSION)]),
    chainId: z.number().int().positive(),
    address,
    /** Fork block, decimal without leading zeros. */
    blockNumber: canonicalDecimal,
    standard: standardNameSchema,
    /** Required from schemaVersion 2 on; absent in version 1 reports. */
    vaultKind: vaultKindSchema.optional(),
    /** Required (possibly null) from schemaVersion 3 on; absent before. */
    skipReason: skipReasonSchema.nullable().optional(),
    /** Required (possibly empty) from schemaVersion 4 on; absent before. */
    traits: z.array(vaultTraitSchema).optional(),
    upstream: z.object({ repo: z.string().url(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
    harnessSha256: hex32,
    /** sha256 of Specfirst's own properties (SpecfirstMaxHonored.t.sol). */
    sfPropertiesSha256: hex32,
    runs: z.number().int().positive(),
    /** SF_DELTA, tolerated absolute error in asset base units, decimal. */
    delta: decimal,
    /** forge --fuzz-seed of this run, 32-byte hex; null when forge did not run. */
    seed: hex32.nullable(),
    /** forge --sender of this run: a fresh random EOA, so a vault cannot recognise forge's default sender. */
    sender: address.nullable(),
    toolchain: z
      .object({
        /** First line of `forge --version`; null when forge did not run. */
        forgeVersion: z.string().min(1).nullable(),
        forgeStd: z.object({ repo: z.string().url(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
        foundryTomlSha256: hex32,
        /** forge fuzz max_test_rejects from foundry.toml. */
        maxTestRejects: z.number().int().positive(),
      })
      .strict(),
    identity: implementationIdentitySchema,
    results: z.array(standardPropertyResultSchema).min(1),
    summary: standardCheckSummarySchema,
    startedAt: z.string().datetime(),
    durationMs: count,
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.schemaVersion >= 2 && r.vaultKind === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaultKind'], message: `vaultKind is required from schemaVersion 2 on` });
    }
    if (r.schemaVersion === 1 && r.vaultKind !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaultKind'], message: 'vaultKind does not exist in schemaVersion 1' });
    }
    if (r.schemaVersion >= 3 && r.skipReason === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skipReason'], message: 'skipReason (null when properties ran) is required from schemaVersion 3 on' });
    }
    if (r.schemaVersion < 3 && r.skipReason !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['skipReason'], message: `skipReason does not exist in schemaVersion ${r.schemaVersion}` });
    }
    if (r.schemaVersion >= 4 && r.traits === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['traits'], message: 'traits (empty when none) is required from schemaVersion 4 on' });
    }
    if (r.schemaVersion < 4 && r.traits !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['traits'], message: `traits does not exist in schemaVersion ${r.schemaVersion}` });
    }
    const expected = summarize(r.results);
    for (const k of Object.keys(expected) as Array<keyof StandardCheckSummary>) {
      if (r.summary[k] !== expected[k]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summary', k], message: `summary.${k} is ${r.summary[k]}, results say ${expected[k]}` });
      }
    }
  });
export type StandardCheckReport = z.infer<typeof standardCheckReportSchema>;

/** 16 when any property failed; 17 when none failed but none passed or any is inconclusive or not applicable; else 0. */
export function standardCheckExitCode(s: StandardCheckSummary): 0 | 16 | 17 {
  if (s.fail > 0) return STANDARD_CHECK_FAILED_EXIT_CODE;
  if (s.pass === 0 || s.inconclusive > 0 || s.notApplicable > 0) return STANDARD_CHECK_INCOMPLETE_EXIT_CODE;
  return 0;
}

export function summarize(results: readonly Pick<StandardPropertyResult, 'status'>[]): StandardCheckSummary {
  const s: StandardCheckSummary = { pass: 0, fail: 0, inconclusive: 0, notApplicable: 0 };
  for (const r of results) {
    if (r.status === 'not_applicable') s.notApplicable++;
    else s[r.status]++;
  }
  return s;
}

/*
 * Messages forge and forge-std produce, anchored at the start of the reason (forge 1.5.1, forge-std 1.16.2,
 * seen in real runs). A contract's own revert string becomes the reason verbatim, so a contract can still
 * imitate one of these; per the policy above that only turns its result into "not verified".
 */
/** forge rejected every generated input via vm.assume, so nothing was checked. */
const TOO_MANY_REJECTS = /^`vm\.assume` rejected too many inputs \(\d+ allowed\)$/;
/**
 * forge-std could not find or write the asset's balance slot, even with the harness's packed-slot fallback:
 * a non-standard token (rebasing, computed balances). "find" when no slot is found, "checked_write" when the
 * write does not show up in balanceOf (seen on Monad AUSD before the packed fallback existed).
 */
const DEAL_FAILED = /^stdStorage (find|checked_write)\(StdStorage\): /;
/**
 * The fork backend could not read state (HTTP 429 from a rate-limited RPC, timeouts). Seen live:
 * "EVM error; database error: failed to get account for 0x..: Max retries exceeded HTTP error 429".
 */
const FORK_ERROR = /^EVM error; database error: /;
const MAX_LOG_LINES = 20;
/** Prefix of the reason of a property left inconclusive by a fork RPC failure (in the suite or its setUp). */
export const FORK_ERROR_NOTE = 'fork RPC error, rerun or pass another --rpc';

function testName(key: string): string {
  const i = key.indexOf('(');
  return i === -1 ? key : key.slice(0, i);
}

function counterexampleOf(test: string, r: ForgeTestResult): NonNullable<StandardPropertyResult['counterexample']> {
  const calls = callsOf(r.counterexample).map((c) =>
    // Fuzz counterexamples are a single test call without sender or target; invariant ones are handler calls.
    c.sender ? formatForgeCall(c) : `${test}(${c.raw_args ?? c.args ?? ''})`,
  );
  const calldata = callsOf(r.counterexample)[0]?.calldata;
  return {
    calls,
    ...(calldata ? { calldata } : {}),
    logs: (r.decoded_logs ?? []).slice(0, MAX_LOG_LINES),
  };
}

/** Selector (0x + 8 hex) of every test key forge reported, e.g. test_deposit((address[4],...),uint256,uint256). */
function selectorsOf(keys: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of keys) {
    try {
      out.set(toFunctionSelector(key).toLowerCase(), testName(key));
    } catch {
      /* not a signature */
    }
  }
  return out;
}

/**
 * Counts, per test, the lines of an sf-events file (one selector per line): deposit-below-max.log from the
 * harness, max-zero.log from the sf- suite. Unknown selectors are ignored.
 */
export function depositRevertCounts(events: string, testKeys: Iterable<string>): Map<string, number> {
  const bySelector = selectorsOf(testKeys);
  const counts = new Map<string, number>();
  for (const line of events.split('\n')) {
    const test = bySelector.get(line.trim().toLowerCase());
    if (test) counts.set(test, (counts.get(test) ?? 0) + 1);
  }
  return counts;
}

function withDepositNote(r: StandardPropertyResult, n: number | undefined): StandardPropertyResult {
  if (!n) return r;
  const note = `deposit reverted below maxDeposit ${n} times (inputs discarded, EIP-4626 says it must not revert)`;
  return { ...r, reason: r.reason ? `${r.reason}; ${note}` : note };
}

function classify(p: StandardProperty, r: ForgeTestResult): StandardPropertyResult {
  const base = { id: p.id, test: p.test, description: p.description };
  const runs = r.kind?.Fuzz?.runs;
  const withRuns = runs !== undefined ? { runs } : {};
  const reason = r.reason ?? '';
  if (r.status === 'Success') return { ...base, status: 'pass', ...withRuns };
  if (r.status !== 'Failure') return { ...base, status: 'inconclusive', ...withRuns, reason: `forge status ${r.status}` };
  if (TOO_MANY_REJECTS.test(reason)) return { ...base, status: 'inconclusive', ...withRuns, reason };
  if (FORK_ERROR.test(reason)) return { ...base, status: 'inconclusive', ...withRuns, reason: `${FORK_ERROR_NOTE}: ${reason}` };
  if (DEAL_FAILED.test(reason)) {
    return { ...base, status: 'inconclusive', ...withRuns, reason: `the asset's balance slot cannot be written, test users cannot be funded (non-standard token): ${reason}` };
  }
  // Upstream assertions call fail() after emitting log lines, so forge's reason is often null or "".
  return {
    ...base,
    status: 'fail',
    ...withRuns,
    reason: reason || (r.decoded_logs ?? [])[0] || 'property failed',
    counterexample: counterexampleOf(p.test, r),
  };
}

/** The forge --json document inside stdout (log lines before it are skipped), or null. */
export function extractForgeDoc(text: string): Record<string, unknown> | null {
  const doc = extractJson(text);
  return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : null;
}

export interface ParseStandardOptions {
  /** Content of the harness's deposit-below-max event file for this run. */
  depositRevertEvents?: string;
  /** Content of the sf- suite's max-zero event file for this run: one selector per input discarded for a max of 0. */
  maxZeroEvents?: string;
  /** Content of the sf- suite's below-bound event file: one selector per input below the bound that was refused while the bound was accepted. */
  belowBoundEvents?: string;
  /** Content of the sf- suite's bound-unfunded event file: one selector per input not judged because the bound could not be funded. */
  unfundedBoundEvents?: string;
  /** Content of the missing-precompile event file both suites write: "<selector> <precompile>" per input not judged. */
  missingPrecompileEvents?: string;
  /** Content of the setup-precompile event file: the same per input discarded in a setup deposit (a rejected input). */
  setupPrecompileEvents?: string;
}

/** Note on an sf- property whose drawn amounts below the bound min(max, cap) were refused while the bound itself went through. */
export function belowBoundNote(n: number): string {
  return `${n} amounts below the bound were refused; the bound itself was accepted`;
}

/** Note on an sf- property with inputs whose bound could not be funded, so it was not tried there. */
export function unfundedBoundNote(n: number): string {
  return `the bound could not be funded in ${n} inputs; these inputs were not judged`;
}

/**
 * Reason of a property every rejected input of which needed a Monad precompile forge's EVM lacks: those inputs
 * were not judged, and no other input ran. With `n`, the note added to a property that also judged other inputs.
 */
export function missingPrecompileNote(precompile: string, n?: number): string {
  return n === undefined
    ? `${MISSING_PRECOMPILE_NOTE} ${precompile}, which forge lacks; these inputs were not judged`
    : `${MISSING_PRECOMPILE_NOTE} ${precompile}, which forge lacks, in ${n} inputs; these inputs were not judged`;
}

/** Note on a property that ran out of inputs, `n` of which were rejected in a setup deposit that reached a missing precompile. */
export function setupPrecompileNote(precompile: string, n: number): string {
  return `${MISSING_PRECOMPILE_NOTE} ${precompile} in the setup deposit, which forge lacks, in ${n} inputs; these inputs were rejected`;
}

/**
 * Test name -> how many inputs were not judged and the first precompile they needed, from the missing-precompile
 * event file: one line "<selector of the test> <precompile address>" per input, written by the harness after a
 * vault call reverted and SfForkGaps.precompileCause showed that the call reached the precompile. Unknown
 * selectors and malformed lines are ignored.
 */
export function missingPrecompilesOf(events: string, testKeys: Iterable<string>): Map<string, { count: number; precompile: string }> {
  const bySelector = selectorsOf(testKeys);
  const out = new Map<string, { count: number; precompile: string }>();
  for (const line of events.split('\n')) {
    const m = /^(0x[0-9a-fA-F]{8}) (0x[0-9a-fA-F]{40})$/.exec(line.trim());
    const test = m ? bySelector.get(m[1]!.toLowerCase()) : undefined;
    if (!test) continue;
    const cur = out.get(test);
    if (cur) cur.count++;
    else out.set(test, { count: 1, precompile: m![2]! });
  }
  return out;
}

/**
 * Inputs whose vault call reverted after reaching a missing precompile, which the fork cannot judge. Unjudged
 * inputs of the property itself (`unjudged`) rule out a pass: such an input may be exactly the one that would have
 * failed on Monad. A fail keeps its status and
 * counterexample (another input failed) and gets the count; a pass becomes inconclusive with the count. Inputs
 * discarded in a setup deposit (`setup`) never ran the property: they are rejected inputs, named in the reason of
 * a property that ran out of inputs and otherwise not counted. A property whose rejected inputs were all of these
 * kinds (at least forge's reject limit) is inconclusive with missingPrecompileNote alone. Applied to forge's own
 * reason, before the other notes are added.
 */
function withMissingPrecompile(
  r: StandardPropertyResult,
  unjudged: { count: number; precompile: string } | undefined,
  setup: { count: number; precompile: string } | undefined,
): StandardPropertyResult {
  if (!unjudged && !setup) return r;
  const runs = r.runs !== undefined ? { runs: r.runs } : {};
  const base = { id: r.id, test: r.test, description: r.description };
  const limit = /^`vm\.assume` rejected too many inputs \((\d+) allowed\)$/.exec(r.reason ?? '');
  const total = (unjudged?.count ?? 0) + (setup?.count ?? 0);
  if (r.status === 'inconclusive' && limit && total >= Number(limit[1])) {
    return { ...base, status: 'inconclusive', ...runs, reason: missingPrecompileNote((unjudged ?? setup)!.precompile) };
  }
  let out = r;
  if (unjudged) {
    const note = missingPrecompileNote(unjudged.precompile, unjudged.count);
    out = out.status === 'pass' ? { ...base, status: 'inconclusive', ...runs, reason: note } : { ...out, reason: out.reason ? `${out.reason}; ${note}` : note };
  }
  if (setup && limit && out.status === 'inconclusive') {
    const note = setupPrecompileNote(setup.precompile, setup.count);
    out = { ...out, reason: `${out.reason}; ${note}` };
  }
  return out;
}

function withBelowBoundNote(r: StandardPropertyResult, n: number | undefined): StandardPropertyResult {
  if (!n) return r;
  const note = belowBoundNote(n);
  return { ...r, reason: r.reason ? `${r.reason}; ${note}` : note };
}

/**
 * Inputs whose bound could not be funded are unjudged, like those whose call reached a missing precompile: a
 * vault and its asset by the same author could refuse the funding on exactly the inputs that would fail. A
 * property with one is never a pass (a pass becomes inconclusive), and a fail keeps its counterexample; the
 * count is noted either way.
 */
function withUnfundedBound(r: StandardPropertyResult, n: number | undefined): StandardPropertyResult {
  if (!n) return r;
  const note = unfundedBoundNote(n);
  const reason = r.reason ? `${r.reason}; ${note}` : note;
  if (r.status === 'pass') return { ...r, status: 'inconclusive', reason };
  return { ...r, reason };
}

/** Reason of an sf- property whose every discarded input had a max of 0. */
export function maxZeroNote(maxName: string): string {
  return `${maxName} returned 0 for every test user; there is no max value to honor (EIP-4626 allows underestimating)`;
}

/**
 * An sf- property that ran out of inputs only because its max was 0 every time is not applicable: the
 * vault never advertised anything to honor. The sf- suite writes one event per such discard; when there
 * are at least as many as forge's reject limit, every rejected input was one of them.
 */
function withMaxZero(r: StandardPropertyResult, maxZero: number | undefined): StandardPropertyResult {
  const m = /^test_sf_(max(?:Deposit|Mint|Withdraw|Redeem))_honored$/.exec(r.test);
  const limit = /^`vm\.assume` rejected too many inputs \((\d+) allowed\)$/.exec(r.reason ?? '');
  if (!m || !limit || r.status !== 'inconclusive' || !maxZero || maxZero < Number(limit[1])) return r;
  return { id: r.id, test: r.test, description: r.description, status: 'not_applicable', ...(r.runs !== undefined ? { runs: r.runs } : {}), reason: maxZeroNote(m[1]!) };
}

/**
 * Turns `forge test --json` stdout of a standard suite into one result per property, in `properties` order.
 * A property whose suite's setUp() failed is not_applicable, or inconclusive when the failure is a fork RPC
 * error. Any other property forge did not report is inconclusive.
 * Returns null when the output holds no forge JSON (compile error, fork error); the caller reports stderr.
 */
export function parseStandardForgeJson(
  text: string,
  properties: readonly StandardProperty[],
  opts: ParseStandardOptions = {},
): StandardPropertyResult[] | null {
  const doc = extractForgeDoc(text);
  if (!doc) return null;
  const keys: string[] = [];
  const byTest = new Map<string, ForgeTestResult>();
  let setupFailure: string | null = null;
  for (const suite of Object.values(doc as Record<string, { test_results?: Record<string, ForgeTestResult> }>)) {
    if (!suite || typeof suite !== 'object' || !suite.test_results) continue;
    for (const [key, r] of Object.entries(suite.test_results)) {
      keys.push(key);
      const name = testName(key);
      if (name === 'setUp' && r.status !== 'Success') setupFailure ??= r.reason || 'setUp reverted';
      else byTest.set(name, r);
    }
  }
  const known = new Set(properties.map((p) => p.test));
  const extra = [...byTest.keys()].filter((t) => !known.has(t)).map((t) => ({ test: t, id: t, description: 'not in the property table' }));
  const deposits = opts.depositRevertEvents ? depositRevertCounts(opts.depositRevertEvents, keys) : new Map<string, number>();
  const maxZero = opts.maxZeroEvents ? depositRevertCounts(opts.maxZeroEvents, keys) : new Map<string, number>();
  const belowBound = opts.belowBoundEvents ? depositRevertCounts(opts.belowBoundEvents, keys) : new Map<string, number>();
  const unfundedBound = opts.unfundedBoundEvents ? depositRevertCounts(opts.unfundedBoundEvents, keys) : new Map<string, number>();
  const precompiles = opts.missingPrecompileEvents ? missingPrecompilesOf(opts.missingPrecompileEvents, keys) : new Map<string, { count: number; precompile: string }>();
  const setupPrecompiles = opts.setupPrecompileEvents ? missingPrecompilesOf(opts.setupPrecompileEvents, keys) : new Map<string, { count: number; precompile: string }>();
  return [...properties, ...extra].map((p): StandardPropertyResult => {
    const base = { id: p.id, test: p.test, description: p.description };
    const r = byTest.get(p.test);
    // A suite whose setUp failed reports no tests; its properties take the setUp reason. Properties of a
    // suite that did run keep their own results.
    if (!r && setupFailure !== null) {
      if (FORK_ERROR.test(setupFailure)) return { ...base, status: 'inconclusive', reason: `${FORK_ERROR_NOTE}: setUp failed: ${setupFailure}` };
      // Our own fixed prefix, anchored like forge's messages. Imitating it only reaches "not applicable".
      if (setupFailure.startsWith(`${RESTRICTED_ASSET_PREFIX} (`)) {
        return { ...base, status: 'not_applicable', reason: `${RESTRICTED_ASSET_NOTE} ${setupFailure.slice(RESTRICTED_ASSET_PREFIX.length + 1)}` };
      }
      return { ...base, status: 'not_applicable', reason: `setUp failed: ${setupFailure}` };
    }
    if (!r) return { ...base, status: 'inconclusive', reason: 'no result in forge output' };
    // Each rule reads forge's own reason first, so the order matters: max-zero, then the precompile inputs, then the notes.
    const judged = withMissingPrecompile(withMaxZero(classify(p, r), maxZero.get(p.test)), precompiles.get(p.test), setupPrecompiles.get(p.test));
    return withUnfundedBound(withBelowBoundNote(withDepositNote(judged, deposits.get(p.test)), belowBound.get(p.test)), unfundedBound.get(p.test));
  });
}

/** skipReason of a run whose properties forge reported (the pre-checks set their own). */
export function skipReasonOf(results: readonly Pick<StandardPropertyResult, 'status' | 'reason'>[]): SkipReason | null {
  // No property ran, and every one had inputs that needed a Monad precompile the fork lacks (most often all of them).
  if (results.length > 0 && results.every((r) => r.status === 'inconclusive' && r.reason?.includes(MISSING_PRECOMPILE_NOTE))) return 'missing-precompile';
  if (results.length === 0 || !results.every((r) => r.status === 'not_applicable')) return null;
  return results.every((r) => r.reason?.startsWith(RESTRICTED_ASSET_NOTE)) ? 'asset-transfer-restricted' : 'setup-reverted';
}

/**
 * The results a fork RPC failure left inconclusive (reason starting with FORK_ERROR_NOTE). A report with any
 * of them says more about the RPC than about the contract: the watcher does not attest it and checks again.
 */
export function forkRpcErrorsOf(report: Pick<StandardCheckReport, 'results'>): StandardPropertyResult[] {
  return report.results.filter((r) => r.status === 'inconclusive' && (r.reason ?? '').startsWith(FORK_ERROR_NOTE));
}
