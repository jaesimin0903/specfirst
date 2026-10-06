// webhooks.json in the watch directory, the delivery-time DNS check and the watcher's webhook AlertSink (docs/adr/0006,
// Alerts). Node only: it reads and writes files and resolves host names. The message, verification and delivery it
// builds on are in alerts.ts.
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  checkAllowedLocalOrigins,
  deliverWebhookAlerts,
  emptyWebhooksFile,
  verifyWebhookRegistration,
  webhooksFileSchema,
  type DeliverWebhooksOptions,
  type FetchLike,
  type WebhookRegistration,
  type WebhookUrlOptions,
  type WebhookVerification,
  type WebhooksFile,
} from './alerts.js';
import type { AlertSink } from '../watch/hooks.js';

export const WEBHOOKS_JSON = 'webhooks.json';

export class WebhookStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookStoreError';
  }
}

/** Reads and validates webhooks.json; a missing file is an empty store. */
export async function readWebhooks(file: string): Promise<WebhooksFile> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyWebhooksFile();
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new WebhookStoreError(`webhooks ${file} is not readable JSON: ${(err as Error).message}`);
  }
  const parsed = webhooksFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new WebhookStoreError(`webhooks ${file} is invalid: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** Writes `file` readable by its owner only (0600): a temp file, written and fsynced, then renamed over it. */
async function writePrivateAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(content);
    await fh.sync();
  } catch (err) {
    await fh.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await fh.close();
  await rename(tmp, file);
}

/** One read-modify-write at a time per file within this process, so two registrations never lose each other. */
const queues = new Map<string, Promise<unknown>>();
function serialized<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(file);
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  queues.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

export type RegisterWebhookResult =
  | Exclude<WebhookVerification, { ok: true }>
  | { ok: true; registration: WebhookRegistration; stored: true; previous: WebhookRegistration | null }
  | { ok: true; registration: WebhookRegistration; stored: false; current: WebhookRegistration };

export interface RegisterWebhookOptions extends WebhookUrlOptions {
  /** Unix seconds (default: the local clock). */
  now?: number;
}

/**
 * The only way into webhooks.json, for the web API: verifies the registration in full (verifyWebhookRegistration,
 * the issued window included) and stores it. It replaces the subscriber's stored registration only when it was
 * issued at the same time or later (latest per subscriber wins; an older registration replayed within its window
 * does not undo a newer one; stored: false then).
 */
export async function registerWebhook(file: string, input: unknown, opts: RegisterWebhookOptions = {}): Promise<RegisterWebhookResult> {
  checkAllowedLocalOrigins(opts.allowedLocalOrigins);
  const v = await verifyWebhookRegistration(input, { ...opts, ignoreAge: false });
  if (!v.ok) return v;
  const r = v.registration;
  return serialized(file, async () => {
    const store = await readWebhooks(file);
    const key = r.subscriber.toLowerCase();
    const previous = store.webhooks[key] ?? null;
    if (previous && previous.issued > r.issued) return { ok: true as const, registration: r, stored: false as const, current: previous };
    store.webhooks[key] = r;
    await writePrivateAtomic(file, `${JSON.stringify(webhooksFileSchema.parse(store), null, 2)}\n`);
    return { ok: true as const, registration: r, stored: true as const, previous };
  });
}

/** Every address `hostname` resolves to (node:dns lookup, all families), for the delivery-time private address check. */
export async function lookupWebhookHost(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);
}

export interface WebhookAlertSinkOptions extends Omit<DeliverWebhooksOptions, 'fetch' | 'resolveHost'> {
  /** `<watch dir>/webhooks.json`, read again for every event so new registrations apply without a restart. */
  webhooksFile: string;
  /** Default: the global fetch. */
  fetch?: FetchLike;
  /** Default: lookupWebhookHost (node:dns). */
  resolveHost?: DeliverWebhooksOptions['resolveHost'];
  /** Public URL of certs/checks for the payload's reportURL. */
  reportBaseUrl?: string;
}

/**
 * The watcher's webhook AlertSink: for each `changed` event, POSTs the ADR payload once to the registered webhook of
 * every subscriber among the given subscriptions on that subject (deliverWebhookAlerts: at most 25 subscribers, 20 s
 * for the whole event, 3 attempts with backoff, no redirects, the DNS check) and returns the `alerted` events. A
 * missing webhooks.json means nobody registered: no alerts. A broken one throws, so the watcher logs an error
 * instead of silently dropping alerts. allowedLocalOrigins must be exact http(s) origins; a bad one throws here.
 */
export function createWebhookAlertSink(opts: WebhookAlertSinkOptions): AlertSink {
  checkAllowedLocalOrigins(opts.allowedLocalOrigins);
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const resolveHost = opts.resolveHost ?? lookupWebhookHost;
  return {
    async deliver(event, subs) {
      if (event.kind !== 'changed' || subs.length === 0) return [];
      const { webhooks } = await readWebhooks(opts.webhooksFile);
      return deliverWebhookAlerts(event, subs, webhooks, { ...opts, fetch: fetchFn, resolveHost });
    },
  };
}
