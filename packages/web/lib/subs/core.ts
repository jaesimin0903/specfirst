import { getAddress, isAddress, parseAbi, verifyMessage, type Address, type Hex } from 'viem';
import { z } from 'zod';

/*
 * Stand-in for the part of @specfirst/core/subs the web uses (feat/subscriptions: packages/core/src/subs,
 * subscription.ts and alerts.ts), with the same names, signatures and behavior: the CheckSubscriptions ABI, the
 * day accounting, and the webhook message, URL rules, registration schema and verification. At merge this file
 * becomes `export * from '@specfirst/core/subs'`. Client-safe: viem and zod only.
 */

/** CheckSubscriptions, as the contract on feat/subscriptions declares it (test/subs-contract.test.ts pins it). */
export const checkSubscriptionsAbi = parseAbi([
  'struct Subscription { address subscriber; uint64 subjectChainId; address subject; bytes32 standardId; uint96 feePerDay; uint64 startsAt; uint64 endsAt; uint96 paid; uint96 settled; bool cancelled; }',
  'constructor(address owner_, uint96 feePerDay_)',
  'function subscribe(uint64 subjectChainId, address subject, bytes32 standardId, uint32 days_) payable returns (uint256 id)',
  'function extend(uint256 id, uint32 days_) payable',
  'function cancel(uint256 id)',
  'function settle(uint256[] ids)',
  'function withdraw(address to)',
  'function setFeePerDay(uint96 feePerDay_)',
  'function subscriptionOf(uint256 id) view returns (Subscription)',
  'function subscriptionCount() view returns (uint256)',
  'function isActive(uint256 id) view returns (bool)',
  'function feePerDay() view returns (uint96)',
  'function owner() view returns (address)',
  'function earned() view returns (uint256)',
  'function withdrawn() view returns (uint256)',
  'function escrowed() view returns (uint256)',
  'event Subscribed(uint256 indexed id, address indexed subscriber, uint64 subjectChainId, address indexed subject, bytes32 standardId, uint32 days_, uint96 paid, uint64 endsAt)',
  'event Extended(uint256 indexed id, uint32 days_, uint96 paid, uint64 endsAt)',
  'event Cancelled(uint256 indexed id, uint96 refund)',
  'event Settled(uint256 indexed id, uint96 amount)',
  'event FeesWithdrawn(address indexed to, uint96 amount)',
  'event FeePerDaySet(uint96 feePerDay)',
  'error NotOwner()',
  'error NotSubscriber(uint256 id)',
  'error ZeroAddress()',
  'error ZeroChainId()',
  'error EmptyStandardId()',
  'error BadDays(uint32 days_)',
  'error WrongValue(uint256 sent, uint256 expected)',
  'error PaidOverflow(uint256 id, uint256 paid)',
  'error UnknownSubscription(uint256 id)',
  'error AlreadyCancelled(uint256 id)',
  'error NothingToWithdraw()',
  'error TransferFailed(address to, uint256 amount)',
  'error Reentrancy()',
]);

/* Day accounting (subscription.ts) */

/** Length of one paid day in CheckSubscriptions, in seconds of block.timestamp. */
export const SUBSCRIPTION_DAY_SECONDS = 86_400n;
/** Most days one subscribe or extend can pay for. */
export const MAX_SUBSCRIPTION_DAYS = 365;

/** CheckSubscriptions.Subscription as viem decodes it. */
export interface Subscription {
  subscriber: Address;
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
  feePerDay: bigint;
  /** Start of the current run: block.timestamp of subscribe, or of an extend after the subscription expired. */
  startsAt: bigint;
  /** End of the current run, exclusive; startsAt plus whole days. */
  endsAt: bigint;
  /** Sum of the fees paid (subscribe and every extend). */
  paid: bigint;
  /** Part of paid moved to earned. */
  settled: bigint;
  cancelled: boolean;
}

type Run = Pick<Subscription, 'startsAt' | 'endsAt' | 'feePerDay' | 'paid' | 'settled' | 'cancelled'>;

/** isActive(id) of the contract at block timestamp `now`: not cancelled and now < endsAt. */
export function isActiveAt(s: Pick<Subscription, 'endsAt' | 'cancelled'>, now: bigint): boolean {
  return !s.cancelled && now < s.endsAt;
}

/** Whole days of the current run, (endsAt - startsAt) / 86400. */
export function runDaysOf(s: Pick<Subscription, 'startsAt' | 'endsAt'>): bigint {
  return (s.endsAt - s.startsAt) / SUBSCRIPTION_DAY_SECONDS;
}

/** Days of the current run that have started at `now`, the current one included, capped at the run's days. */
export function startedDaysAt(s: Pick<Subscription, 'startsAt' | 'endsAt'>, now: bigint): bigint {
  const days = runDaysOf(s);
  if (now >= s.endsAt) return days;
  if (now < s.startsAt) return 0n;
  return (now - s.startsAt) / SUBSCRIPTION_DAY_SECONDS + 1n;
}

/** The fee of the started days, earlier runs included: paid minus the fee of the days of the run not started. */
export function dueAt(s: Run, now: bigint): bigint {
  return s.paid - (runDaysOf(s) - startedDaysAt(s, now)) * s.feePerDay;
}

/** What settle([id]) would move to earned at `now`; 0 for a cancelled subscription. */
export function settleableAt(s: Run, now: bigint): bigint {
  return s.cancelled ? 0n : dueAt(s, now) - s.settled;
}

/** What cancel(id) would refund at `now`: the fee of the days not started; 0 for a cancelled subscription. */
export function refundAt(s: Run, now: bigint): bigint {
  return s.cancelled ? 0n : s.paid - dueAt(s, now);
}

/* Webhook registration (alerts.ts) */

/** A registration older than this (seconds between issued and now) is refused. */
export const WEBHOOK_MAX_AGE_SEC = 600;
/** A registration issued further than this in the future (clock skew) is refused. */
export const WEBHOOK_MAX_FUTURE_SEC = 60;
export const WEBHOOK_MAX_URL_LENGTH = 2048;

export interface WebhookMessageInput {
  subscriber: Address | string;
  url: string;
  /** Unix seconds. */
  issued: number;
}

/**
 * Exactly the text a subscriber signs (EIP-191 personal_sign) to register `url`:
 * "Specfirst alerts webhook\nsubscriber: <checksummed address>\nurl: <url>\nissued: <unix seconds>".
 */
export function webhookMessage(i: WebhookMessageInput): string {
  if (!Number.isSafeInteger(i.issued) || i.issued < 0) throw new Error(`issued must be unix seconds, got ${i.issued}`);
  return `Specfirst alerts webhook\nsubscriber: ${getAddress(i.subscriber)}\nurl: ${i.url}\nissued: ${i.issued}`;
}

const checksummed = z.string().refine((a) => isAddress(a, { strict: false }) && getAddress(a) === a, 'a checksummed 0x address');

/** One stored registration: what the subscriber signed, and the signature. */
export const webhookRegistrationSchema = z
  .object({
    subscriber: checksummed,
    url: z.string().min(1).max(WEBHOOK_MAX_URL_LENGTH),
    issued: z.number().int().nonnegative().refine(Number.isSafeInteger, 'unix seconds'),
    signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'a 0x hex signature'),
  })
  .strict();
export type WebhookRegistration = z.infer<typeof webhookRegistrationSchema>;

/** `<watch dir>/webhooks.json`: the latest registration per subscriber, keyed by the lowercase address. Never served. */
export const webhooksFileSchema = z
  .object({
    v: z.literal(1),
    webhooks: z.record(z.string().regex(/^0x[0-9a-f]{40}$/, 'a lowercase 0x address'), webhookRegistrationSchema),
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const [key, r] of Object.entries(f.webhooks)) {
      if (r.subscriber.toLowerCase() !== key)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['webhooks', key], message: `key ${key} is not the subscriber ${r.subscriber}` });
    }
  });
export type WebhooksFile = z.infer<typeof webhooksFileSchema>;

export function emptyWebhooksFile(): WebhooksFile {
  return { v: 1, webhooks: {} };
}

/** Private, loopback, link-local, CGNAT and unspecified addresses, by the URL parser's hostname. */
function privateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:');
  }
  return false;
}

/**
 * Why `url` cannot be a webhook, or null when it can. https only, at most 2048 characters, no whitespace or control
 * characters (they would break the signed message), no credentials, and no private, loopback or link-local host.
 * With allowLocalHttp (demos only) http and https to localhost and 127.0.0.1 are allowed as well.
 */
export function webhookUrlProblem(url: string, opts: { allowLocalHttp?: boolean } = {}): string | null {
  if (url.length > WEBHOOK_MAX_URL_LENGTH) return `longer than ${WEBHOOK_MAX_URL_LENGTH} characters`;
  if (/[\s\x00-\x1f\x7f]/.test(url)) return 'contains whitespace or control characters';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (u.username || u.password) return 'carries credentials';
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (opts.allowLocalHttp && local && (u.protocol === 'http:' || u.protocol === 'https:')) return null;
  if (u.protocol !== 'https:') return 'not https';
  if (privateHost(u.hostname)) return 'points at a private or loopback address';
  return null;
}

export type WebhookRejection = 'invalid' | 'url' | 'stale' | 'future' | 'signature';

function withChecksummedSubscriber(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const subscriber = (input as { subscriber?: unknown }).subscriber;
  if (typeof subscriber !== 'string' || !isAddress(subscriber, { strict: false })) return input;
  return { ...input, subscriber: getAddress(subscriber) };
}

export type WebhookVerification = { ok: true; registration: WebhookRegistration } | { ok: false; reason: WebhookRejection; message: string };

export interface VerifyWebhookOptions {
  /** Unix seconds (default: the local clock). */
  now?: number;
  allowLocalHttp?: boolean;
  /** Skip the issued window, for registrations read back from webhooks.json long after they were made. */
  ignoreAge?: boolean;
}

/**
 * Checks a registration `{ subscriber, url, issued, signature }`: the shape, the URL (webhookUrlProblem), issued at
 * most WEBHOOK_MAX_AGE_SEC in the past and WEBHOOK_MAX_FUTURE_SEC in the future, and an EIP-191 signature of
 * webhookMessage by the subscriber (EOA signatures only). The subscriber may come in any case and is returned
 * checksummed.
 */
export async function verifyWebhookRegistration(input: unknown, opts: VerifyWebhookOptions = {}): Promise<WebhookVerification> {
  const parsed = webhookRegistrationSchema.safeParse(withChecksummedSubscriber(input));
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, reason: 'invalid', message: `not a webhook registration: ${issues.join('; ')}` };
  }
  const r = parsed.data;
  const problem = webhookUrlProblem(r.url, opts);
  if (problem) return { ok: false, reason: 'url', message: `url ${problem}` };
  if (!opts.ignoreAge) {
    const now = opts.now ?? Math.floor(Date.now() / 1000);
    if (now - r.issued > WEBHOOK_MAX_AGE_SEC)
      return { ok: false, reason: 'stale', message: `issued ${now - r.issued} s ago, more than ${WEBHOOK_MAX_AGE_SEC} s` };
    if (r.issued - now > WEBHOOK_MAX_FUTURE_SEC)
      return { ok: false, reason: 'future', message: `issued ${r.issued - now} s in the future, more than ${WEBHOOK_MAX_FUTURE_SEC} s` };
  }
  let valid = false;
  try {
    valid = await verifyMessage({ address: r.subscriber as Address, message: webhookMessage(r), signature: r.signature as Hex });
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'signature', message: `the signature is not ${r.subscriber}'s signature of the webhook message` };
  return { ok: true, registration: r };
}

/** The JSON body the watcher POSTs to a webhook for one `changed` event and one subscription (ADR 0006). */
export interface WebhookPayload {
  v: 1;
  subscriptionId: string;
  subject: Address;
  chainId: number;
  change: unknown;
  check: unknown;
  attestation: unknown;
  reportURL: string | null;
}
