// Shapes of the watcher's files under `.specfirst/watch/<subjectChainId>/` (docs/adr/0006, "Interfaces"):
// feed.ndjson, status.json and vaults.json. Only viem and zod are imported, so the web can read the files
// through `@specfirst/core/watch` without pulling Node-only modules.
import { getAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';

/** The watcher's directory under the project; one subdirectory per subject chain id. */
export const WATCH_DIR = '.specfirst/watch';
/** Where the web looks for WATCH_DIR when set (default `<repo>/.specfirst/watch`). */
export const WATCH_DIR_ENV = 'SPECFIRST_WATCH_DIR';
export const WATCH_FEED_NDJSON = 'feed.ndjson';
export const WATCH_STATUS_JSON = 'status.json';
export const WATCH_VAULTS_JSON = 'vaults.json';

export const FEED_KINDS = ['detected', 'probe-rejected', 'queued', 'checked', 'attested', 'changed', 'alerted', 'error'] as const;
export const feedKindSchema = z.enum(FEED_KINDS);
export type FeedKind = (typeof FEED_KINDS)[number];

/**
 * Why something happened to a subject. factory, deposit, upgrade, beacon-upgrade and implementation are
 * chain signals (docs/adr/0006, "Signals"); first-deposit, sweep and subscribed are re-check reasons;
 * backfill marks the vaults the watcher knew before it started (certs/checks/<chainId>/); price-drop marks a
 * confirmed fall of the share value and the re-check it queues.
 */
export const FEED_SOURCES = [
  'factory',
  'deposit',
  'upgrade',
  'beacon-upgrade',
  'implementation',
  'first-deposit',
  'sweep',
  'subscribed',
  'backfill',
  'price-drop',
] as const;
export const feedSourceSchema = z.enum(FEED_SOURCES);
export type FeedSource = (typeof FEED_SOURCES)[number];

/**
 * How a check differs from the subject's previous one. new: no previous check. regressed: a property fails
 * that did not fail before. recovered: no new failure, and a property that failed no longer does.
 * changed: the same failures, other counts. implementation: the same results, another implementation key.
 */
export const CHECK_CHANGE_KINDS = ['new', 'regressed', 'recovered', 'changed', 'implementation'] as const;
export type CheckChangeKind = (typeof CHECK_CHANGE_KINDS)[number];

/** Every change kind of a `changed` event: those of a check, and price-drop, a confirmed fall of the share value. */
export const CHANGE_KINDS = [...CHECK_CHANGE_KINDS, 'price-drop'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const WATCH_STAGES = ['probing', 'checking', 'attesting'] as const;
export type WatchStage = (typeof WATCH_STAGES)[number];

export const ALERT_CHANNELS = ['webhook', 'inbox'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

// zod runs a refinement even after the regex failed, so the refinement checks the shape again before
// getAddress, which throws on anything that is not 40 hex characters.
const checksummed = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address')
  .refine((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && getAddress(a) === a, 'expected a checksummed (EIP-55) address')
  .transform((a) => a as Address);
const lowerAddress = /^0x[0-9a-f]{40}$/;
const decimal = z.string().regex(/^(0|[1-9]\d*)$/, 'a non-negative decimal integer string');
const hex32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'a 32-byte 0x hex string')
  .transform((h) => h as Hex);
const iso = z.string().datetime();
const count = z.number().int().nonnegative();

export const watchSummarySchema = z.object({ pass: count, fail: count, inconclusive: count, notApplicable: count }).strict();
export type WatchSummary = z.infer<typeof watchSummarySchema>;

/** One side of a change: the four counts and the ids of the failed properties. */
export const watchResultSchema = z.object({ summary: watchSummarySchema, failed: z.array(z.string().min(1)) }).strict();
export type WatchResult = z.infer<typeof watchResultSchema>;

/**
 * A finished check. block: the subject chain block it forked at. reportPath: repository relative
 * (certs/checks/<chainId>/<address>/<block>-<hash8>.json). reportHash: keccak256 of the canonical report.
 */
export const feedCheckSchema = z
  .object({
    block: decimal,
    summary: watchSummarySchema,
    failed: z.array(z.string().min(1)),
    implementationKey: hex32.nullable(),
    reportPath: z.string().min(1),
    reportHash: hex32,
    durationMs: count,
  })
  .strict();
export type FeedCheck = z.infer<typeof feedCheckSchema>;

/** A registry attestation the watcher made; supersedes is the id of the Valid attestation it replaced. */
export const feedAttestationSchema = z.object({ id: decimal, txHash: hex32, supersedes: decimal.nullable() }).strict();
export type FeedAttestation = z.infer<typeof feedAttestationSchema>;

/** A change found by a check: its result against the previous check's. */
export const checkChangeSchema = z.object({ kind: z.enum(CHECK_CHANGE_KINDS), from: watchResultSchema.nullable(), to: watchResultSchema }).strict();
export type CheckChange = z.infer<typeof checkChangeSchema>;

/**
 * A confirmed fall of the share value: convertToAssets of one whole share (10 ** decimals() of the vault) read at
 * fromBlock and at toBlock, in the asset's base units, and the fall in basis points of the first, rounded down. A
 * fact about two blocks, not a verdict on the vault. scale (1 to 6, absent for 0): both values are for 10 ** scale
 * whole shares, read so for a vault whose one share is worth fewer than 10,000 base units.
 */
export const priceDropChangeSchema = z
  .object({
    kind: z.literal('price-drop'),
    fromAssetsPerShare: decimal,
    toAssetsPerShare: decimal,
    dropBps: z.number().int().min(0).max(10_000),
    fromBlock: decimal,
    toBlock: decimal,
    scale: z.number().int().min(1).max(6).optional(),
  })
  .strict();
export type PriceDropChange = z.infer<typeof priceDropChangeSchema>;

export const feedChangeSchema = z.discriminatedUnion('kind', [checkChangeSchema, priceDropChangeSchema]);
export type FeedChange = z.infer<typeof feedChangeSchema>;

export const feedAlertSchema = z
  .object({ subscriptionId: decimal, subscriber: checksummed, channel: z.enum(ALERT_CHANNELS), ok: z.boolean(), status: z.number().int().optional() })
  .strict();
export type FeedAlert = z.infer<typeof feedAlertSchema>;

/**
 * One line of feed.ndjson. seq counts from 1 and never repeats; at is ISO 8601 UTC; chainId is the subject
 * chain; block and txHash locate the signal (or, for a queued re-check, the signal that caused it).
 */
export const feedEventSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().positive(),
    at: iso,
    kind: feedKindSchema,
    chainId: z.number().int().positive(),
    subject: checksummed,
    source: feedSourceSchema.optional(),
    block: decimal.optional(),
    txHash: hex32.optional(),
    factory: z.object({ address: checksummed, name: z.string().min(1) }).strict().optional(),
    check: feedCheckSchema.optional(),
    attestation: feedAttestationSchema.optional(),
    change: feedChangeSchema.optional(),
    alert: feedAlertSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type FeedEvent = z.infer<typeof feedEventSchema>;

/**
 * status.json, rewritten after every step. head: the latest subject block seen. cursor: the first block
 * whose logs have not been read yet. lagBlocks: how far below head the watcher reads and checks.
 * counts are over the last 24 hours except known (vaults.json); changed24h counts changes of a result, priceDrops24h
 * (optional, added with the share value) confirmed falls of a share value. sources: one entry per signal source, seen
 * = signals of that source since the watcher's state was created. attestBudget: attestations made on the
 * current UTC day against --max-attest-per-day, and (optional) the unsolicited part of them against its own
 * smaller budget, the fails of candidates no factory announced and nobody attested within that, the cap per
 * subject, the balance floor, the issuer's last read balance and, when nothing is sent, why (paused). gasCostWei (optional): gasUsed x effectiveGasPrice summed over the watcher's
 * attestations since its state was created, for the web's spend figures.
 */
export const watchStatusSchema = z
  .object({
    v: z.literal(1),
    chainId: z.number().int().positive(),
    head: decimal,
    cursor: decimal,
    lagBlocks: count,
    startedAt: iso,
    updatedAt: iso,
    running: z
      .object({ subject: checksummed, source: z.enum(FEED_SOURCES), stage: z.enum(WATCH_STAGES), startedAt: iso })
      .strict()
      .nullable(),
    queue: z.array(z.object({ subject: checksummed, source: z.enum(FEED_SOURCES), enqueuedAt: iso }).strict()),
    counts: z.object({ known: count, detected24h: count, checked24h: count, attested24h: count, changed24h: count, priceDrops24h: count.optional() }).strict(),
    sources: z.array(z.object({ name: z.string().min(1), address: checksummed.nullable(), topic0: hex32, seen: count }).strict()),
    attestBudget: z
      .object({
        perDay: count,
        usedToday: count,
        unsolicitedPerDay: count.optional(),
        unsolicitedUsedToday: count.optional(),
        candidateFailsPerDay: count.optional(),
        candidateFailsUsedToday: count.optional(),
        perSubjectPerDay: count.optional(),
        minBalanceWei: decimal.optional(),
        balanceWei: decimal.nullable().optional(),
        paused: z.string().nullable().optional(),
      })
      .strict(),
    gasCostWei: decimal.optional(),
  })
  .strict();
export type WatchStatus = z.infer<typeof watchStatusSchema>;

/** The latest check of a vault, as in the feed's check minus the hash and duration; at is the report's startedAt. */
export const watchLastCheckSchema = z
  .object({ block: decimal, at: iso, reportPath: z.string().min(1), summary: watchSummarySchema, failed: z.array(z.string().min(1)), implementationKey: hex32.nullable() })
  .strict();
export type WatchLastCheck = z.infer<typeof watchLastCheckSchema>;

/**
 * One known vault. firstSeen: the signal that made it known (block of that signal; for backfill, the block
 * of its oldest report). deployBlock: its creation block when a factory announced it, else null.
 * lastAttestationId: the latest Valid registry attestation the watcher saw or made. firstDepositBlock: the
 * block of the first Deposit the watcher observed from it.
 */
export const watchVaultSchema = z
  .object({
    firstSeen: z.object({ source: z.enum(FEED_SOURCES), block: decimal, at: iso }).strict(),
    deployBlock: decimal.nullable(),
    lastCheck: watchLastCheckSchema.nullable(),
    lastAttestationId: decimal.nullable(),
    firstDepositBlock: decimal.nullable(),
  })
  .strict();
export type WatchVault = z.infer<typeof watchVaultSchema>;

/** vaults.json: every known vault keyed by its lowercase address. */
export const watchVaultsSchema = z
  .object({ v: z.literal(1), vaults: z.record(z.string(), watchVaultSchema) })
  .strict()
  .superRefine((v, ctx) => {
    for (const key of Object.keys(v.vaults)) {
      if (!lowerAddress.test(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['vaults', key], message: `vaults.json keys are lowercase addresses, got "${key}"` });
    }
  });
export type WatchVaults = z.infer<typeof watchVaultsSchema>;

/**
 * Parses feed.ndjson text. A last line without its newline is a write in progress and is left out; any
 * other line that is not a valid event is counted in `invalid` and skipped, so one bad line never hides
 * the rest of the feed.
 */
export function parseFeed(text: string): { events: FeedEvent[]; invalid: number } {
  const lines = text.split('\n');
  if (!text.endsWith('\n')) lines.pop();
  const events: FeedEvent[] = [];
  let invalid = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalid++;
      continue;
    }
    const parsed = feedEventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else invalid++;
  }
  return { events, invalid };
}
