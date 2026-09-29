import { z } from 'zod';
import { callsOf, extractJson, formatForgeCall, type ForgeTestResult } from '../fuzz/forge.js';
import type { StandardProperty } from './erc4626.js';

export const STANDARD_CHECK_SCHEMA_VERSION = 1;
/** CLI exit code when any standard property fails on the checked contract. */
export const STANDARD_CHECK_FAILED_EXIT_CODE = 16;
export const STANDARDS = ['erc4626'] as const;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte 0x hex string');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address');
const decimal = z.string().regex(/^\d+$/, 'expected a non-negative decimal integer string');
const count = z.number().int().nonnegative();

export const standardNameSchema = z.enum(STANDARDS);
export type StandardName = z.infer<typeof standardNameSchema>;

/**
 * pass: the property held on every fuzz run. fail: forge found a counterexample.
 * inconclusive: the property could not be exercised (every input rejected, `deal` could not fund users, or
 * the fork RPC failed mid-run).
 * not_applicable: the suite could not start on this contract (setUp reverted, e.g. no asset()).
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
    implementationKey: hexBytes,
    implementationKeyKind: z
      .object({ of: z.enum(['implementation', 'self']), hash: z.enum(['metadataHash', 'maskedCodeHash', 'codeHash']) })
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
    schemaVersion: z.literal(STANDARD_CHECK_SCHEMA_VERSION),
    chainId: z.number().int().positive(),
    address,
    /** Fork block, decimal. */
    blockNumber: decimal,
    standard: standardNameSchema,
    upstream: z.object({ repo: z.string().url(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).strict(),
    harnessSha256: hex32,
    runs: z.number().int().positive(),
    /** SF_DELTA, tolerated absolute error in asset base units, decimal. */
    delta: decimal,
    identity: implementationIdentitySchema,
    results: z.array(standardPropertyResultSchema).min(1),
    summary: standardCheckSummarySchema,
    startedAt: z.string().datetime(),
    durationMs: count,
  })
  .strict()
  .superRefine((r, ctx) => {
    const expected = summarize(r.results);
    for (const k of Object.keys(expected) as Array<keyof StandardCheckSummary>) {
      if (r.summary[k] !== expected[k]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summary', k], message: `summary.${k} is ${r.summary[k]}, results say ${expected[k]}` });
      }
    }
  });
export type StandardCheckReport = z.infer<typeof standardCheckReportSchema>;

export function summarize(results: readonly Pick<StandardPropertyResult, 'status'>[]): StandardCheckSummary {
  const s: StandardCheckSummary = { pass: 0, fail: 0, inconclusive: 0, notApplicable: 0 };
  for (const r of results) {
    if (r.status === 'not_applicable') s.notApplicable++;
    else s[r.status]++;
  }
  return s;
}

/** forge rejected every generated input via vm.assume, so nothing was checked. */
const TOO_MANY_REJECTS = /rejected too many inputs|too many rejects/i;
/** forge-std `deal` found no balance slot to write: a non-standard token (rebasing, computed balances). */
const DEAL_FAILED = /stdStorage find|No storage use detected|Slot\(s\) not found/i;
/**
 * The fork backend could not read state (HTTP 429 from a rate-limited RPC, timeouts): forge reports it as a
 * test failure, but it says nothing about the contract. Seen live: "EVM error; database error: failed to get
 * account for 0x..: Max retries exceeded HTTP error 429".
 */
const FORK_ERROR = /database error|Max retries exceeded|HTTP error \d{3}|request limit|rate limit|error sending request|could not instantiate forked environment/i;
const MAX_LOG_LINES = 20;

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

function classify(p: StandardProperty, r: ForgeTestResult): StandardPropertyResult {
  const base = { id: p.id, test: p.test, description: p.description };
  const runs = r.kind?.Fuzz?.runs;
  const withRuns = runs !== undefined ? { runs } : {};
  const reason = r.reason ?? '';
  if (r.status === 'Success') return { ...base, status: 'pass', ...withRuns };
  if (r.status !== 'Failure') return { ...base, status: 'inconclusive', ...withRuns, reason: `forge status ${r.status}` };
  if (TOO_MANY_REJECTS.test(reason)) return { ...base, status: 'inconclusive', ...withRuns, reason };
  if (FORK_ERROR.test(reason)) return { ...base, status: 'inconclusive', ...withRuns, reason: `fork RPC error, rerun or pass another --rpc: ${reason}` };
  if (DEAL_FAILED.test(reason)) {
    return { ...base, status: 'inconclusive', ...withRuns, reason: `deal could not fund test users (non-standard token): ${reason}` };
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

/**
 * Turns `forge test --json` stdout of a standard suite into one result per property, in `properties` order.
 * A failed setUp() makes every property not_applicable. A property forge did not report is inconclusive.
 * Returns null when the output holds no forge JSON (compile error, fork error); the caller reports stderr.
 */
export function parseStandardForgeJson(text: string, properties: readonly StandardProperty[]): StandardPropertyResult[] | null {
  const doc = extractJson(text);
  if (!doc || typeof doc !== 'object') return null;
  const byTest = new Map<string, ForgeTestResult>();
  let setupFailure: string | null = null;
  for (const suite of Object.values(doc as Record<string, { test_results?: Record<string, ForgeTestResult> }>)) {
    if (!suite || typeof suite !== 'object' || !suite.test_results) continue;
    for (const [key, r] of Object.entries(suite.test_results)) {
      const name = testName(key);
      if (name === 'setUp' && r.status !== 'Success') setupFailure = r.reason || 'setUp reverted';
      else byTest.set(name, r);
    }
  }
  const known = new Set(properties.map((p) => p.test));
  const extra = [...byTest.keys()].filter((t) => !known.has(t)).map((t) => ({ test: t, id: t, description: 'not in the property table' }));
  return [...properties, ...extra].map((p) => {
    if (setupFailure !== null) {
      return { id: p.id, test: p.test, description: p.description, status: 'not_applicable', reason: `setUp failed: ${setupFailure}` };
    }
    const r = byTest.get(p.test);
    if (!r) return { id: p.id, test: p.test, description: p.description, status: 'inconclusive', reason: 'no result in forge output' };
    return classify(p, r);
  });
}
