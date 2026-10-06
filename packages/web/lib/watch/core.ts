import { getAddress } from 'viem';
import { z } from 'zod';

/*
 * Stand-in for @specfirst/core/watch (ADR 0006, "Interfaces"): the watcher's file schemas, written from the ADR
 * and matched to the watcher branch's schema.ts so the web could be built beside it; at merge this file becomes
 * a re-export of the core subpath (core names the enums FEED_KINDS and FEED_SOURCES, the summary
 * watchSummarySchema). Nothing else in the web defines these shapes. Client-safe (viem, zod). The webhook message
 * and its verification belong to @specfirst/core/subs, stood in by lib/subs/core.ts.
 */

// As the ADR says: addresses checksummed (EIP-55), block numbers and wei decimal strings, times ISO 8601 UTC.
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && getAddress(a) === a, 'expected a checksummed (EIP-55) address');
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const isoTime = z.string().datetime();
const count = z.number().int().nonnegative();

export const summarySchema = z.object({ pass: count, fail: count, inconclusive: count, notApplicable: count }).strict();
export type Summary = z.infer<typeof summarySchema>;

export const feedKindSchema = z.enum(['detected', 'probe-rejected', 'queued', 'checked', 'attested', 'changed', 'alerted', 'error']);
export type FeedKind = z.infer<typeof feedKindSchema>;

export const feedSourceSchema = z.enum([
  'factory',
  'deposit',
  'upgrade',
  'beacon-upgrade',
  'implementation',
  'first-deposit',
  'sweep',
  'subscribed',
  'backfill',
]);
export type FeedSource = z.infer<typeof feedSourceSchema>;

export const changeKindSchema = z.enum(['new', 'regressed', 'recovered', 'changed', 'implementation']);
export type ChangeKind = z.infer<typeof changeKindSchema>;

const outcomeSchema = z.object({ summary: summarySchema, failed: z.array(z.string().min(1)) }).strict();

export const feedCheckSchema = z
  .object({
    block: decimal,
    summary: summarySchema,
    failed: z.array(z.string().min(1)),
    implementationKey: hash32.nullable(),
    reportPath: z.string().min(1),
    reportHash: hash32,
    durationMs: count,
  })
  .strict();
export type FeedCheck = z.infer<typeof feedCheckSchema>;

/** One line of feed.ndjson. seq counts from 1 and never repeats. */
export const feedEventSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().positive(),
    at: isoTime,
    kind: feedKindSchema,
    chainId: z.number().int().positive(),
    subject: address,
    source: feedSourceSchema.optional(),
    block: decimal.optional(),
    txHash: hash32.optional(),
    factory: z
      .object({ address, name: z.string().min(1) })
      .strict()
      .optional(),
    check: feedCheckSchema.optional(),
    attestation: z.object({ id: decimal, txHash: hash32, supersedes: decimal.nullable() }).strict().optional(),
    change: z.object({ kind: changeKindSchema, from: outcomeSchema.nullable(), to: outcomeSchema }).strict().optional(),
    alert: z
      .object({ subscriptionId: decimal, subscriber: address, channel: z.enum(['webhook', 'inbox']), ok: z.boolean(), status: z.number().int().optional() })
      .strict()
      .optional(),
    reason: z.string().optional(),
  })
  .strict();
export type FeedEvent = z.infer<typeof feedEventSchema>;

export const watchStageSchema = z.enum(['probing', 'checking', 'attesting']);
export type WatchStage = z.infer<typeof watchStageSchema>;

/** status.json, rewritten atomically after every step. */
export const watchStatusSchema = z
  .object({
    v: z.literal(1),
    chainId: z.number().int().positive(),
    head: decimal,
    cursor: decimal,
    lagBlocks: count,
    startedAt: isoTime,
    updatedAt: isoTime,
    running: z.object({ subject: address, source: feedSourceSchema, stage: watchStageSchema, startedAt: isoTime }).strict().nullable(),
    queue: z.array(z.object({ subject: address, source: feedSourceSchema, enqueuedAt: isoTime }).strict()),
    counts: z.object({ known: count, detected24h: count, checked24h: count, attested24h: count, changed24h: count }).strict(),
    sources: z.array(z.object({ name: z.string().min(1), address: address.nullable(), topic0: hash32, seen: count }).strict()),
    attestBudget: z.object({ perDay: count, usedToday: count }).strict(),
  })
  .strict();
export type WatchStatus = z.infer<typeof watchStatusSchema>;

export const watchVaultSchema = z
  .object({
    firstSeen: z.object({ source: feedSourceSchema, block: decimal, at: isoTime }).strict(),
    deployBlock: decimal.nullable(),
    lastCheck: z
      .object({
        block: decimal,
        at: isoTime,
        reportPath: z.string().min(1),
        summary: summarySchema,
        failed: z.array(z.string().min(1)),
        implementationKey: hash32.nullable(),
      })
      .strict()
      .nullable(),
    lastAttestationId: decimal.nullable(),
    firstDepositBlock: decimal.nullable(),
  })
  .strict();
export type WatchVault = z.infer<typeof watchVaultSchema>;

/** vaults.json: lowercase address -> what the watcher knows about that vault. */
export const watchVaultsSchema = z.object({ v: z.literal(1), vaults: z.record(z.string().regex(/^0x[0-9a-f]{40}$/), watchVaultSchema) }).strict();
export type WatchVaults = z.infer<typeof watchVaultsSchema>;
