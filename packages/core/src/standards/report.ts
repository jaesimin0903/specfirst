import { toFunctionSelector } from 'viem';
import { z } from 'zod';
import { callsOf, extractJson, formatForgeCall, type ForgeTestResult } from '../fuzz/forge.js';
import type { StandardProperty } from './erc4626.js';

/**
 * 2 adds `vaultKind`. Version 1 reports (without it) still validate, so reports written before the change,
 * and attestations built from them, stay readable.
 */
export const STANDARD_CHECK_SCHEMA_VERSION = 2;
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
export type StandardName = z.infer<typeof standardNameSchema>;

/**
 * pass: the property held on every fuzz run. fail: forge found a counterexample.
 * inconclusive: the property could not be exercised (every input rejected, `deal` could not fund users, or
 * the fork RPC failed, including in setUp).
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
    schemaVersion: z.union([z.literal(1), z.literal(STANDARD_CHECK_SCHEMA_VERSION)]),
    chainId: z.number().int().positive(),
    address,
    /** Fork block, decimal without leading zeros. */
    blockNumber: canonicalDecimal,
    standard: standardNameSchema,
    /** Required from schemaVersion 2 on; absent in version 1 reports. */
    vaultKind: vaultKindSchema.optional(),
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
const FORK_ERROR_NOTE = 'fork RPC error, rerun or pass another --rpc';

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
 * Counts, per test, the lines of sf-events/<run>.deposit-below-max.log: one selector per discarded input
 * whose deposit reverted at or below maxDeposit (see the harness). Unknown selectors are ignored.
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
  return [...properties, ...extra].map((p): StandardPropertyResult => {
    const base = { id: p.id, test: p.test, description: p.description };
    const r = byTest.get(p.test);
    // A suite whose setUp failed reports no tests; its properties take the setUp reason. Properties of a
    // suite that did run keep their own results.
    if (!r && setupFailure !== null) {
      return FORK_ERROR.test(setupFailure)
        ? { ...base, status: 'inconclusive', reason: `${FORK_ERROR_NOTE}: setUp failed: ${setupFailure}` }
        : { ...base, status: 'not_applicable', reason: `setUp failed: ${setupFailure}` };
    }
    if (!r) return { ...base, status: 'inconclusive', reason: 'no result in forge output' };
    return withDepositNote(classify(p, r), deposits.get(p.test));
  });
}
