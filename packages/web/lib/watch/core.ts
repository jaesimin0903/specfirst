import { getAddress } from 'viem';
import { z } from 'zod';

/*
 * Stand-in for @specfirst/core/watch (ADR 0006, "Interfaces"): the watcher's file schemas with the names, shapes
 * and strictness of feat/watch's packages/core/src/watch/schema.ts, so at merge this file becomes
 * `export * from '@specfirst/core/watch'`. Only names core exports are defined here. Nothing else in the web
 * defines these shapes. Client-safe (viem, zod). The webhook message and its verification belong to
 * @specfirst/core/subs, stood in by lib/subs/core.ts.
 */

// As the ADR says: addresses checksummed (EIP-55), block numbers and wei decimal strings, times ISO 8601 UTC.
const checksummed = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .refine((a) => /^0x[0-9a-fA-F]{40}$/.test(a) && getAddress(a) === a, 'expected a checksummed (EIP-55) address');
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)$/);
const iso = z.string().datetime();
const count = z.number().int().nonnegative();

export const WATCH_DIR = '.specfirst/watch';
export const WATCH_DIR_ENV = 'SPECFIRST_WATCH_DIR';
export const WATCH_FEED_NDJSON = 'feed.ndjson';
export const WATCH_STATUS_JSON = 'status.json';
export const WATCH_VAULTS_JSON = 'vaults.json';

export const FEED_KINDS = ['detected', 'probe-rejected', 'queued', 'checked', 'attested', 'changed', 'alerted', 'error'] as const;
export type FeedKind = (typeof FEED_KINDS)[number];
export const feedKindSchema = z.enum(FEED_KINDS);

export const FEED_SOURCES = ['factory', 'deposit', 'upgrade', 'beacon-upgrade', 'implementation', 'first-deposit', 'sweep', 'subscribed', 'backfill'] as const;
export type FeedSource = (typeof FEED_SOURCES)[number];
export const feedSourceSchema = z.enum(FEED_SOURCES);

export const CHANGE_KINDS = ['new', 'regressed', 'recovered', 'changed', 'implementation'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const WATCH_STAGES = ['probing', 'checking', 'attesting'] as const;
export type WatchStage = (typeof WATCH_STAGES)[number];

export const ALERT_CHANNELS = ['webhook', 'inbox'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const watchSummarySchema = z.object({ pass: count, fail: count, inconclusive: count, notApplicable: count }).strict();
export type WatchSummary = z.infer<typeof watchSummarySchema>;

/** One side of a change: the four counts and the ids of the failed properties. */
export const watchResultSchema = z.object({ summary: watchSummarySchema, failed: z.array(z.string().min(1)) }).strict();
export type WatchResult = z.infer<typeof watchResultSchema>;

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

export const feedAttestationSchema = z.object({ id: decimal, txHash: hex32, supersedes: decimal.nullable() }).strict();
export type FeedAttestation = z.infer<typeof feedAttestationSchema>;

export const feedChangeSchema = z.object({ kind: z.enum(CHANGE_KINDS), from: watchResultSchema.nullable(), to: watchResultSchema }).strict();
export type FeedChange = z.infer<typeof feedChangeSchema>;

export const feedAlertSchema = z
  .object({ subscriptionId: decimal, subscriber: checksummed, channel: z.enum(ALERT_CHANNELS), ok: z.boolean(), status: z.number().int().optional() })
  .strict();
export type FeedAlert = z.infer<typeof feedAlertSchema>;

/** One line of feed.ndjson. seq counts from 1 and never repeats. */
export const feedEventSchema = z
  .object({
    v: z.literal(1),
    seq: z.number().int().positive(),
    at: iso,
    kind: z.enum(FEED_KINDS),
    chainId: z.number().int().positive(),
    subject: checksummed,
    source: z.enum(FEED_SOURCES).optional(),
    block: decimal.optional(),
    txHash: hex32.optional(),
    factory: z
      .object({ address: checksummed, name: z.string().min(1) })
      .strict()
      .optional(),
    check: feedCheckSchema.optional(),
    attestation: feedAttestationSchema.optional(),
    change: feedChangeSchema.optional(),
    alert: feedAlertSchema.optional(),
    reason: z.string().optional(),
  })
  .strict();
export type FeedEvent = z.infer<typeof feedEventSchema>;

/**
 * status.json, rewritten after every step. gasCostWei (optional): what the watcher's attestations cost,
 * gasUsed x effectiveGasPrice summed since its state.json was created.
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
    counts: z.object({ known: count, detected24h: count, checked24h: count, attested24h: count, changed24h: count }).strict(),
    sources: z.array(z.object({ name: z.string().min(1), address: checksummed.nullable(), topic0: hex32, seen: count }).strict()),
    attestBudget: z.object({ perDay: count, usedToday: count }).strict(),
    gasCostWei: decimal.optional(),
  })
  .strict();
export type WatchStatus = z.infer<typeof watchStatusSchema>;

export const watchLastCheckSchema = z
  .object({
    block: decimal,
    at: iso,
    reportPath: z.string().min(1),
    summary: watchSummarySchema,
    failed: z.array(z.string().min(1)),
    implementationKey: hex32.nullable(),
  })
  .strict();
export type WatchLastCheck = z.infer<typeof watchLastCheckSchema>;

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
export const watchVaultsSchema = z.object({ v: z.literal(1), vaults: z.record(z.string().regex(/^0x[0-9a-f]{40}$/), watchVaultSchema) }).strict();
export type WatchVaults = z.infer<typeof watchVaultsSchema>;
