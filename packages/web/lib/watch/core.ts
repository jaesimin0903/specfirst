import { getAddress, isAddress, recoverMessageAddress } from 'viem';
import { z } from 'zod';

/*
 * Stand-in for @specfirst/core/watch (ADR 0006, "Interfaces"): the watcher's file schemas and the webhook
 * registration message. Written from the ADR so the web could be built beside the watcher; at merge this file
 * becomes a re-export of the core subpath. Nothing else in the web defines these shapes. Client-safe (viem, zod).
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

/* Webhook registration (ADR 0006, "Alerts"). */

export const WEBHOOK_MAX_AGE_SEC = 600;

export interface WebhookRegistration {
  subscriber: string;
  url: string;
  /** unix seconds */
  issued: number;
  signature: `0x${string}`;
}

/** The exact text a subscriber signs (EIP-191 personal_sign) to register a webhook URL. */
export function webhookMessage(o: { subscriber: string; url: string; issued: number }): string {
  return `Specfirst alerts webhook\nsubscriber: ${getAddress(o.subscriber)}\nurl: ${o.url}\nissued: ${o.issued}`;
}

export interface VerifyWebhookOptions {
  /** unix seconds; defaults to the clock */
  now?: number;
  maxAgeSec?: number;
  /** http:// is accepted for localhost and 127.0.0.1 only when this is true. */
  allowLocalHttp?: boolean;
}

export type VerifyWebhookResult = { ok: true; subscriber: `0x${string}` } | { ok: false; reason: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/** Signature by the subscriber over webhookMessage, issued within maxAgeSec, and an https URL. */
export async function verifyWebhookRegistration(reg: WebhookRegistration, o: VerifyWebhookOptions = {}): Promise<VerifyWebhookResult> {
  if (typeof reg?.subscriber !== 'string' || !isAddress(reg.subscriber, { strict: false })) return { ok: false, reason: 'subscriber is not an address' };
  if (!Number.isSafeInteger(reg.issued) || reg.issued <= 0) return { ok: false, reason: 'issued must be unix seconds' };
  if (typeof reg.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(reg.signature)) return { ok: false, reason: 'signature must be 65 bytes of hex' };
  // Whitespace or control characters would change the signed text's lines.
  if (typeof reg.url !== 'string' || /[\s\u0000-\u001f\u007f]/.test(reg.url))
    return { ok: false, reason: 'url must not contain whitespace or control characters' };
  let url: URL;
  try {
    url = new URL(reg.url);
  } catch {
    return { ok: false, reason: 'url is not a URL' };
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && o.allowLocalHttp && LOCAL_HOSTS.has(url.hostname))) {
    return { ok: false, reason: o.allowLocalHttp ? 'url must be https, or http on localhost' : 'url must be https' };
  }
  const now = o.now ?? Math.floor(Date.now() / 1000);
  const maxAge = o.maxAgeSec ?? WEBHOOK_MAX_AGE_SEC;
  if (reg.issued > now + 60) return { ok: false, reason: 'issued is in the future' };
  if (now - reg.issued > maxAge) return { ok: false, reason: `the signature is older than ${Math.round(maxAge / 60)} minutes; sign again` };
  const subscriber = getAddress(reg.subscriber);
  let signer: `0x${string}`;
  try {
    signer = await recoverMessageAddress({ message: webhookMessage({ subscriber, url: reg.url, issued: reg.issued }), signature: reg.signature });
  } catch {
    return { ok: false, reason: 'signature does not recover' };
  }
  if (signer.toLowerCase() !== subscriber.toLowerCase()) return { ok: false, reason: 'signature is not by the subscriber' };
  return { ok: true, subscriber };
}
