// Webhook alerts (docs/adr/0006, Alerts): the message a subscriber signs to register a webhook, its verification,
// the webhooks.json schema, the payload, and the delivery with retries. Only viem and zod are imported, so the
// web can build the message for the wallet and verify registrations from `@specfirst/core/subs`; the file store,
// the DNS check and the watcher's sink are in webhooks.ts (Node).
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { ActiveSubscription } from '../watch/hooks.js';
import type { FeedAttestation, FeedChange, FeedCheck, FeedEvent } from '../watch/schema.js';

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
/** Subscribers one event is delivered to; the rest are recorded as not delivered. */
export const DEFAULT_WEBHOOK_MAX_TARGETS = 25;
/** Time one event may take to deliver, all subscribers and retries included. */
export const DEFAULT_WEBHOOK_DEADLINE_MS = 20_000;
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
 * The url is signed as given; a registration only verifies when it is printable ASCII in canonical form
 * (webhookUrlProblem), so the signed text is the URL that is called.
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

function ipv4Octets(s: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** The eight 16-bit groups of an IPv6 address (zone dropped, a dotted IPv4 tail allowed), or null. */
function ipv6Groups(s: string): number[] | null {
  let str = s.toLowerCase().replace(/%.*$/, '');
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(str);
  if (dotted) {
    const o = ipv4Octets(dotted[2]!);
    if (!o) return null;
    tail.push((o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!);
    str = dotted[1]!.endsWith('::') ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string | undefined) => (part ? part.split(':') : []).map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN));
  const head = parse(halves[0]);
  const rest = parse(halves[1]);
  if ([...head, ...rest].some(Number.isNaN)) return null;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1 ? given !== 8 : given > 7) return null;
  return [...head, ...new Array<number>(8 - given).fill(0), ...rest, ...tail];
}

/**
 * True for an address a webhook must not reach, and for anything that is not an IP address at all. IPv4: 0/8,
 * 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15, 224/3. IPv6: ::/96 (unspecified, loopback
 * and IPv4-compatible), ::ffff:0:0/96 (IPv4-mapped), 64:ff9b::/96 (NAT64), fc00::/7, fe80::/10, fec0::/10, ff00::/8.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Octets(ip);
  if (v4) {
    const [a, b] = [v4[0]!, v4[1]!];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const g = ipv6Groups(ip);
  if (!g) return true;
  const zeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0);
  return (
    zeroUpTo(6) ||
    (zeroUpTo(5) && g[5] === 0xffff) ||
    (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) ||
    (g[0]! & 0xfe00) === 0xfc00 ||
    (g[0]! & 0xffc0) === 0xfe80 ||
    (g[0]! & 0xffc0) === 0xfec0 ||
    (g[0]! & 0xff00) === 0xff00
  );
}

/** The URL parser's hostname without a trailing dot or IPv6 brackets. */
export function bareHostname(u: URL): string {
  return u.hostname.replace(/\.$/, '').replace(/^\[(.*)\]$/, '$1');
}

/** True when the host is an IP address literal (no DNS involved). */
export function isIpLiteral(u: URL): boolean {
  return ipv4Octets(bareHostname(u)) !== null || u.hostname.startsWith('[');
}

function privateHost(u: URL): boolean {
  const host = bareHostname(u);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIpLiteral(u) && isPrivateAddress(host);
}

export interface WebhookUrlOptions {
  /**
   * Exact origins allowed in spite of the rules below, e.g. ['http://localhost:3418'] for a local demo receiver.
   * Default none. They skip the https, private host and DNS checks; nothing else is relaxed.
   */
  allowedLocalOrigins?: readonly string[];
}

/** True when `u` is http(s) and its origin is exactly one of the allowed local origins. */
export function isAllowedLocalOrigin(u: URL, opts: WebhookUrlOptions = {}): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return (opts.allowedLocalOrigins ?? []).includes(u.origin);
}

/** Throws unless every entry is exactly an http(s) origin, as `new URL(x).origin` writes it ("http://localhost:3418"). */
export function checkAllowedLocalOrigins(origins: readonly string[] = []): void {
  for (const o of origins) {
    let origin: string | undefined;
    try {
      const u = new URL(o);
      if (u.protocol === 'http:' || u.protocol === 'https:') origin = u.origin;
    } catch {
      origin = undefined;
    }
    if (origin !== o) throw new Error(`allowed local origin "${o}" is not an exact http(s) origin such as http://localhost:3418`);
  }
}

/**
 * Why `url` cannot be a webhook, or null when it can: at most 2048 characters of printable ASCII, in canonical form
 * (`new URL(url).href === url`, so what was signed is what is called), no credentials, https, and a host that is
 * not localhost, *.localhost or a private, loopback, link-local or otherwise internal IP address (trailing dot
 * ignored). allowedLocalOrigins are let through after the first three rules.
 */
export function webhookUrlProblem(url: string, opts: WebhookUrlOptions = {}): string | null {
  if (url.length > WEBHOOK_MAX_URL_LENGTH) return `longer than ${WEBHOOK_MAX_URL_LENGTH} characters`;
  if (!/^[\x21-\x7e]+$/.test(url)) return 'contains characters other than printable ASCII';
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'not a URL';
  }
  if (u.href !== url) return 'not in canonical form (send new URL(url).href)';
  if (u.username || u.password) return 'carries credentials';
  if (isAllowedLocalOrigin(u, opts)) return null;
  if (u.protocol !== 'https:') return 'not https';
  if (privateHost(u)) return 'points at a private or loopback address';
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

export interface VerifyWebhookOptions extends WebhookUrlOptions {
  /** Unix seconds (default: the local clock). */
  now?: number;
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

/**
 * What a webhook POST is about: `change`, a `changed` event of a check (change set); `first-check`, the `checked`
 * event of the first check after the subscription started, delivered once (change null when nothing changed); or
 * `price-drop`, a `changed` event whose change is a confirmed fall of the share value (change carries the numbers;
 * check, attestation and reportURL are null).
 */
export type WebhookAlertKind = 'change' | 'first-check' | 'price-drop';

/** The payload kind of a feed event a webhook gets. */
export function webhookKindOf(event: FeedEvent): WebhookAlertKind {
  if (event.kind === 'checked') return 'first-check';
  return event.change?.kind === 'price-drop' ? 'price-drop' : 'change';
}

/**
 * The payload's idempotency key: `<kind>:<chainId>:<subject lowercase>:<block>`, the block being the reference block
 * a drop was measured from (fromBlock) or the block of the check. A retried POST, or the same drop or change found
 * again after a restart, carries the same key, so a receiver that keeps the keys it has handled can drop repeats.
 */
export function webhookKeyOf(event: FeedEvent): string {
  const kind = webhookKindOf(event);
  const block = event.change?.kind === 'price-drop' ? event.change.fromBlock : (event.check?.block ?? `seq${event.seq}`);
  return `${kind}:${event.chainId}:${event.subject.toLowerCase()}:${block}`;
}

/**
 * The JSON body POSTed to a webhook for one `changed` event (a change of the result, or a fall of the share value),
 * or for the first check after a subscription started (ADR 0006). One POST per subscriber: subscriptionIds lists the
 * active subscriptions it holds on the subject that the event is for, subscriptionId is the lowest of them. v stays
 * 1 with kinds and fields added (price-drop, key): a receiver dispatches on kind and ignores kinds and fields it does
 * not know.
 */
export interface WebhookPayload {
  v: 1;
  kind: WebhookAlertKind;
  /** Idempotency key (webhookKeyOf); added with price-drop, so a receiver can drop repeats. */
  key: string;
  subscriptionId: string;
  subscriptionIds: string[];
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

/** The payload for one subscriber holding `ids` (sorted here) on the event's subject; a `checked` event is a first check. */
export function webhookPayload(event: FeedEvent, ids: readonly bigint[], reportBaseUrl?: string): WebhookPayload {
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(String);
  if (sorted.length === 0) throw new Error('a webhook payload needs at least one subscription id');
  return {
    v: 1,
    kind: webhookKindOf(event),
    key: webhookKeyOf(event),
    subscriptionId: sorted[0]!,
    subscriptionIds: sorted,
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
  /** Stops the delivery: no new attempt starts and the one in flight is aborted. */
  signal?: AbortSignal;
}

export interface PostWebhookResult {
  ok: boolean;
  /** HTTP status of the last attempt that got a response. */
  status?: number;
  attempts: number;
  /** Why it failed, without the URL (it can be a secret). */
  error?: string;
  /** True when `signal` stopped it. */
  aborted?: boolean;
}

/** Statuses worth another attempt: timeouts, rate limits and server errors. Other 4xx and 3xx are final. */
function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Waits `ms`, or less when `signal` aborts first. */
async function pause(ms: number, sleep: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return;
  let onAbort = () => {};
  const aborted = new Promise<void>((r) => {
    onAbort = () => r();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([sleep(ms), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * POSTs `payload` as JSON to `url`: up to `attempts` tries (default 3) with `backoffMs` between them, each aborted
 * after `timeoutMs`, all of it stopped by `signal`. A 2xx answer is delivered. Redirects are not followed (a 3xx is
 * a failure), so a webhook cannot bounce the request to another host. Network errors, timeouts, 408, 425, 429 and
 * 5xx are retried.
 */
export async function postWebhook(url: string, payload: WebhookPayload, opts: PostWebhookOptions): Promise<PostWebhookResult> {
  const attempts = opts.attempts ?? DEFAULT_WEBHOOK_ATTEMPTS;
  const backoff = opts.backoffMs ?? DEFAULT_WEBHOOK_BACKOFF_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signal = opts.signal;
  const body = JSON.stringify(payload);
  let status: number | undefined;
  let error = 'not attempted';
  let made = 0;
  const result = (ok: boolean, aborted = false): PostWebhookResult => ({
    ok,
    ...(status !== undefined ? { status } : {}),
    attempts: made,
    ...(ok ? {} : { error }),
    ...(aborted ? { aborted } : {}),
  });
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await pause(backoff[Math.min(attempt - 2, backoff.length - 1)] ?? 0, sleep, signal);
    if (signal?.aborted) return result(false, true);
    made = attempt;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const onAbort = () => ctl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
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
      if (res.status >= 200 && res.status < 300) return result(true);
      error = `HTTP ${res.status}`;
      if (!retryable(res.status)) return result(false);
    } catch (err) {
      if (signal?.aborted) return result(false, true);
      error = ctl.signal.aborted ? `no answer within ${timeoutMs} ms` : `request failed: ${(err as Error).name}`;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return result(false);
}

export interface DeliverWebhooksOptions extends PostWebhookOptions, WebhookUrlOptions {
  /** Public URL of certs/checks for reportURL. */
  reportBaseUrl?: string;
  concurrency?: number;
  /** Subscribers per event (default DEFAULT_WEBHOOK_MAX_TARGETS); the rest get a failed alerted event. */
  maxTargets?: number;
  /** Time for the whole event (default DEFAULT_WEBHOOK_DEADLINE_MS); what is not delivered by then has failed. */
  deadlineMs?: number;
  /**
   * Resolves a host name to its addresses before the POST (webhooks.ts passes node:dns lookup). A host with no
   * address or with any private one is refused. Not called for IP literals and allowedLocalOrigins. Without it
   * there is no DNS check.
   */
  resolveHost?: (hostname: string) => Promise<readonly string[]>;
  /** Clock for the `at` of the alerted events. */
  now?: () => Date;
}

/** `p`'s value, or `aborted` when `signal` aborts first. */
function unlessAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<{ value: T } | { aborted: true }> {
  if (signal.aborted) return Promise.resolve({ aborted: true });
  let onAbort = () => {};
  const aborted = new Promise<{ aborted: true }>((r) => {
    onAbort = () => r({ aborted: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([p.then((value) => ({ value })), aborted]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * Feed events a webhook gets: a change (of the result, or a fall of the share value), and the first check after a
 * subscription started (the watcher hands the sink a `checked` event only for that, with the subscriptions it is
 * the first check of).
 */
export function isWebhookEvent(event: FeedEvent): boolean {
  return event.kind === 'changed' || (event.kind === 'checked' && event.check !== undefined);
}

/**
 * Delivers one feed event to webhooks: only `changed` events and the `checked` event of a first check after a
 * subscription started (others return []; isWebhookEvent), only subscriptions on the event's subject and chain,
 * one POST per subscriber (all its given subscription ids in the payload), only to subscribers with a
 * registration whose URL passes webhookUrlProblem, whose signature still verifies (the age is not checked again)
 * and whose host does not resolve to a private address (resolveHost). At most `maxTargets` subscribers are tried;
 * the rest get a failed alerted event. The whole event has `deadlineMs`: when it passes, the POSTs in flight are
 * aborted and the subscribers not reached yet are recorded as failed, so one event never holds the watcher longer.
 * Returns one `alerted` event per subscriber with a registration, in order of first appearance; its subscriptionId
 * is the subscriber's lowest id, `seq` is the seq of the event it answers (the feed writer numbers it when it
 * appends), and a failure carries `reason`, never the URL.
 */
export async function deliverWebhookAlerts(
  event: FeedEvent,
  subs: readonly ActiveSubscription[],
  registrations: Readonly<Record<string, WebhookRegistration>>,
  opts: DeliverWebhooksOptions,
): Promise<FeedEvent[]> {
  if (!isWebhookEvent(event)) return [];
  const subject = event.subject.toLowerCase();
  const groups = new Map<string, { subscriber: Address; ids: bigint[] }>();
  for (const sub of subs) {
    if (sub.subject.toLowerCase() !== subject || sub.subjectChainId !== BigInt(event.chainId)) continue;
    const key = sub.subscriber.toLowerCase();
    const group = groups.get(key) ?? { subscriber: sub.subscriber, ids: [] };
    if (!group.ids.includes(sub.id)) group.ids.push(sub.id);
    groups.set(key, group);
  }
  const targets = [...groups].filter(([key]) => registrations[key]).map(([key, g]) => ({ ...g, ids: [...g.ids].sort((a, b) => (a < b ? -1 : 1)), reg: registrations[key]! }));
  const maxTargets = opts.maxTargets ?? DEFAULT_WEBHOOK_MAX_TARGETS;
  const deadlineMs = opts.deadlineMs ?? DEFAULT_WEBHOOK_DEADLINE_MS;
  const now = opts.now ?? (() => new Date());
  const alerted = (t: { subscriber: Address; ids: bigint[] }, ok: boolean, status?: number, reason?: string): FeedEvent => ({
    v: 1,
    seq: event.seq,
    at: now().toISOString(),
    kind: 'alerted',
    chainId: event.chainId,
    subject: event.subject,
    alert: { subscriptionId: t.ids[0]!.toString(), subscriber: t.subscriber, channel: 'webhook', ok, ...(status !== undefined ? { status } : {}) },
    ...(reason ? { reason } : {}),
  });
  const tried = targets.slice(0, maxTargets);
  const out: FeedEvent[] = new Array(tried.length);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), deadlineMs);
  const late = `delivery deadline of ${deadlineMs} ms passed`;

  const deliverOne = async (t: (typeof tried)[number]): Promise<FeedEvent> => {
    const check = await verifyWebhookRegistration(t.reg, { allowedLocalOrigins: opts.allowedLocalOrigins, ignoreAge: true });
    if (!check.ok) return alerted(t, false, undefined, `webhook registration refused: ${check.reason}`);
    const u = new URL(t.reg.url);
    if (opts.resolveHost && !isAllowedLocalOrigin(u, opts) && !isIpLiteral(u)) {
      const looked = await unlessAborted(
        opts.resolveHost(bareHostname(u)).then(
          (addresses) => ({ addresses }),
          () => ({ addresses: null }),
        ),
        deadline.signal,
      );
      if ('aborted' in looked) return alerted(t, false, undefined, `${late} before delivery`);
      const { addresses } = looked.value;
      if (addresses === null) return alerted(t, false, undefined, 'webhook host lookup failed');
      if (addresses.length === 0) return alerted(t, false, undefined, 'webhook host does not resolve');
      if (addresses.some(isPrivateAddress)) return alerted(t, false, undefined, 'webhook host resolves to a private address');
    }
    const r = await postWebhook(t.reg.url, webhookPayload(event, t.ids, opts.reportBaseUrl), { ...opts, signal: deadline.signal });
    if (r.ok) return alerted(t, true, r.status);
    const after = `after ${r.attempts} attempt${r.attempts === 1 ? '' : 's'}`;
    return alerted(t, false, r.status, r.aborted ? (r.attempts === 0 ? `${late} before delivery` : `${late} ${after}`) : `${r.error} ${after}`);
  };

  let next = 0;
  const worker = async () => {
    while (next < tried.length) {
      const i = next++;
      out[i] = deadline.signal.aborted ? alerted(tried[i]!, false, undefined, `${late} before delivery`) : await deliverOne(tried[i]!);
    }
  };
  try {
    const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_WEBHOOK_CONCURRENCY, tried.length));
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    clearTimeout(timer);
  }
  const over = targets.slice(maxTargets).map((t) => alerted(t, false, undefined, `over the cap of ${maxTargets} webhooks per event`));
  return [...out, ...over];
}
