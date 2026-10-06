// Webhook alerts (docs/adr/0006, Alerts): the message a subscriber signs to register a webhook, its verification,
// the webhooks.json schema, the payload, and the delivery with retries. Only viem and zod are imported, so the
// web can build the message for the wallet and verify registrations from `@specfirst/core/subs`; the file store
// and the watcher's sink are in webhooks.ts (Node).
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { ActiveSubscription, FeedAttestation, FeedChange, FeedCheck, FeedEvent } from './hooks.js';

/** A registration older than this (seconds between issued and now) is refused. */
export const WEBHOOK_MAX_AGE_SEC = 600;
/** A registration issued further than this in the future (clock skew) is refused. */
export const WEBHOOK_MAX_FUTURE_SEC = 60;
export const WEBHOOK_MAX_URL_LENGTH = 2048;
export const DEFAULT_WEBHOOK_ATTEMPTS = 3;
/** Waits before the second and the third attempt. */
export const DEFAULT_WEBHOOK_BACKOFF_MS: readonly number[] = [1_000, 4_000];
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
/** POSTs in flight at once for one event. */
export const DEFAULT_WEBHOOK_CONCURRENCY = 4;
export const WEBHOOK_USER_AGENT = 'specfirst-alerts/1';

export interface WebhookMessageInput {
  subscriber: Address | string;
  url: string;
  /** Unix seconds. */
  issued: number;
}

/**
 * Exactly the text a subscriber signs (EIP-191 personal_sign) to register `url`:
 * "Specfirst alerts webhook\nsubscriber: <checksummed address>\nurl: <url>\nissued: <unix seconds>".
 * The url is signed as given, not normalized, and must not contain whitespace (webhookUrlProblem).
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

/**
 * `<watch dir>/webhooks.json`: the latest registration per subscriber, keyed by the lowercase address. The file
 * holds the URLs, which can be secrets (chat webhook URLs are), so it is never served; the feed never carries a URL.
 */
export const webhooksFileSchema = z
  .object({
    v: z.literal(1),
    webhooks: z.record(z.string().regex(/^0x[0-9a-f]{40}$/, 'a lowercase 0x address'), webhookRegistrationSchema),
  })
  .strict()
  .superRefine((f, ctx) => {
    for (const [key, r] of Object.entries(f.webhooks)) {
      if (r.subscriber.toLowerCase() !== key) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['webhooks', key], message: `key ${key} is not the subscriber ${r.subscriber}` });
    }
  });
export type WebhooksFile = z.infer<typeof webhooksFileSchema>;

export function emptyWebhooksFile(): WebhooksFile {
  return { v: 1, webhooks: {} };
}

/** Private, loopback, link-local and unspecified addresses, by the URL parser's hostname (IPv4 already normalized). */
function privateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
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

/** The input with its subscriber checksummed when it is an address in any case; anything else as it was. */
function withChecksummedSubscriber(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const subscriber = (input as { subscriber?: unknown }).subscriber;
  if (typeof subscriber !== 'string' || !isAddress(subscriber, { strict: false })) return input;
  return { ...input, subscriber: getAddress(subscriber) };
}

export type WebhookVerification =
  | { ok: true; registration: WebhookRegistration }
  | { ok: false; reason: WebhookRejection; message: string };

export interface VerifyWebhookOptions {
  /** Unix seconds (default: the local clock). */
  now?: number;
  allowLocalHttp?: boolean;
  /** Skip the issued window, for registrations read back from webhooks.json long after they were made. */
  ignoreAge?: boolean;
}

/**
 * Checks a registration `{ subscriber, url, issued, signature }`: the shape, the URL (webhookUrlProblem), issued
 * at most WEBHOOK_MAX_AGE_SEC in the past and WEBHOOK_MAX_FUTURE_SEC in the future, and an EIP-191 signature of
 * webhookMessage by the subscriber (viem verifyMessage: an EOA signature; contract wallets cannot register). The
 * subscriber may come in any case and is returned checksummed.
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
    if (now - r.issued > WEBHOOK_MAX_AGE_SEC) return { ok: false, reason: 'stale', message: `issued ${now - r.issued} s ago, more than ${WEBHOOK_MAX_AGE_SEC} s` };
    if (r.issued - now > WEBHOOK_MAX_FUTURE_SEC) return { ok: false, reason: 'future', message: `issued ${r.issued - now} s in the future, more than ${WEBHOOK_MAX_FUTURE_SEC} s` };
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

/** The JSON body POSTed to a webhook for one `changed` event and one subscription (ADR 0006). */
export interface WebhookPayload {
  v: 1;
  subscriptionId: string;
  subject: Address;
  chainId: number;
  change: FeedChange | null;
  check: FeedCheck | null;
  attestation: FeedAttestation | null;
  /** Public URL of the report: reportBaseUrl plus the reportPath below certs/checks, null without a public copy. */
  reportURL: string | null;
}

/**
 * Public URL of a report copy: `reportBaseUrl` is the public URL of certs/checks (the worker's --report-base-url),
 * and a reportPath certs/checks/<chainId>/<address>/<file> maps to <base>/<chainId>/<address>/<file>, as the
 * worker's reportURI. Paths outside certs/checks have no public copy: null.
 */
export function reportUrlOf(reportPath: string | undefined, reportBaseUrl: string | undefined): string | null {
  if (!reportPath || !reportBaseUrl) return null;
  const rel = reportPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!rel.startsWith('certs/checks/') || rel.split('/').includes('..')) return null;
  return `${reportBaseUrl.replace(/\/+$/, '')}/${rel.slice('certs/checks/'.length)}`;
}

export function webhookPayload(event: FeedEvent, sub: Pick<ActiveSubscription, 'id'>, reportBaseUrl?: string): WebhookPayload {
  return {
    v: 1,
    subscriptionId: sub.id.toString(),
    subject: event.subject,
    chainId: event.chainId,
    change: event.change ?? null,
    check: event.check ?? null,
    attestation: event.attestation ?? null,
    reportURL: reportUrlOf(event.check?.reportPath, reportBaseUrl),
  };
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual'; signal: AbortSignal }) => Promise<{
  status: number;
  body?: { cancel(): Promise<void> } | null;
}>;

export interface PostWebhookOptions {
  fetch: FetchLike;
  attempts?: number;
  backoffMs?: readonly number[];
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PostWebhookResult {
  ok: boolean;
  /** HTTP status of the last attempt that got a response. */
  status?: number;
  attempts: number;
  /** Why it failed, without the URL (it can be a secret). */
  error?: string;
}

/** Statuses worth another attempt: timeouts, rate limits and server errors. Other 4xx and 3xx are final. */
function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/**
 * POSTs `payload` as JSON to `url`: up to `attempts` tries (default 3) with `backoffMs` between them, each aborted
 * after `timeoutMs`. A 2xx answer is delivered. Redirects are not followed (a 3xx is a failure), so a webhook
 * cannot bounce the request to another host. Network errors, timeouts, 408, 425, 429 and 5xx are retried.
 */
export async function postWebhook(url: string, payload: WebhookPayload, opts: PostWebhookOptions): Promise<PostWebhookResult> {
  const attempts = opts.attempts ?? DEFAULT_WEBHOOK_ATTEMPTS;
  const backoff = opts.backoffMs ?? DEFAULT_WEBHOOK_BACKOFF_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = JSON.stringify(payload);
  let status: number | undefined;
  let error = 'not attempted';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await sleep(backoff[Math.min(attempt - 2, backoff.length - 1)] ?? 0);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await opts.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': WEBHOOK_USER_AGENT },
        body,
        redirect: 'manual',
        signal: ctl.signal,
      });
      await res.body?.cancel().catch(() => {});
      status = res.status;
      if (res.status >= 200 && res.status < 300) return { ok: true, status, attempts: attempt };
      error = `HTTP ${res.status}`;
      if (!retryable(res.status)) return { ok: false, status, attempts: attempt, error };
    } catch (err) {
      error = ctl.signal.aborted ? `no answer within ${timeoutMs} ms` : `request failed: ${(err as Error).name}`;
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, ...(status !== undefined ? { status } : {}), attempts, error };
}

export interface DeliverWebhooksOptions extends PostWebhookOptions {
  /** Public URL of certs/checks for reportURL. */
  reportBaseUrl?: string;
  allowLocalHttp?: boolean;
  concurrency?: number;
  /** Clock for the `at` of the alerted events. */
  now?: () => Date;
}

/**
 * Delivers one feed event to the webhooks of `subs`: only `changed` events are delivered (others return []), only
 * subscriptions on the event's subject and chain, and only subscribers with a registration whose URL passes
 * webhookUrlProblem and whose signature still verifies (the age is not checked again). Returns one `alerted` event
 * per POST, in subscription order; `seq` is the seq of the changed event it answers, the feed writer numbers it
 * when it appends. A failed delivery carries `reason`, never the URL.
 */
export async function deliverWebhookAlerts(
  event: FeedEvent,
  subs: readonly ActiveSubscription[],
  registrations: Readonly<Record<string, WebhookRegistration>>,
  opts: DeliverWebhooksOptions,
): Promise<FeedEvent[]> {
  if (event.kind !== 'changed') return [];
  const subject = event.subject.toLowerCase();
  const targets: Array<{ sub: ActiveSubscription; reg: WebhookRegistration }> = [];
  for (const sub of subs) {
    if (sub.subject.toLowerCase() !== subject || sub.subjectChainId !== BigInt(event.chainId)) continue;
    const reg = registrations[sub.subscriber.toLowerCase()];
    if (reg) targets.push({ sub, reg });
  }
  const now = opts.now ?? (() => new Date());
  const alerted = (sub: ActiveSubscription, ok: boolean, status?: number, reason?: string): FeedEvent => ({
    v: 1,
    seq: event.seq,
    at: now().toISOString(),
    kind: 'alerted',
    chainId: event.chainId,
    subject: event.subject,
    alert: { subscriptionId: sub.id.toString(), subscriber: sub.subscriber, channel: 'webhook', ok, ...(status !== undefined ? { status } : {}) },
    ...(reason ? { reason } : {}),
  });
  const out: FeedEvent[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      const { sub, reg } = targets[i]!;
      const check = await verifyWebhookRegistration(reg, { allowLocalHttp: opts.allowLocalHttp, ignoreAge: true });
      if (!check.ok) {
        out[i] = alerted(sub, false, undefined, `webhook registration refused: ${check.reason}`);
        continue;
      }
      const r = await postWebhook(reg.url, webhookPayload(event, sub, opts.reportBaseUrl), opts);
      out[i] = alerted(sub, r.ok, r.status, r.ok ? undefined : `${r.error} after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`);
    }
  };
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_WEBHOOK_CONCURRENCY, targets.length));
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
