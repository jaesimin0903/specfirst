// webhooks.json in the watch directory and the watcher's webhook AlertSink (docs/adr/0006, Alerts). Node only: it
// reads and writes files. The message, verification and delivery it builds on are in alerts.ts.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deliverWebhookAlerts,
  emptyWebhooksFile,
  verifyWebhookRegistration,
  webhooksFileSchema,
  webhookRegistrationSchema,
  type DeliverWebhooksOptions,
  type FetchLike,
  type VerifyWebhookOptions,
  type WebhookRegistration,
  type WebhookVerification,
  type WebhooksFile,
} from './alerts.js';
import type { AlertSink } from './hooks.js';

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

async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, content);
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

export type SaveWebhookResult = { stored: true; previous: WebhookRegistration | null } | { stored: false; current: WebhookRegistration };

/**
 * Stores a registration the caller has verified, replacing the subscriber's previous one only when it was issued at
 * the same time or later (latest per subscriber wins; an older registration replayed within its window does not
 * undo a newer one). The file is rewritten through a temp file and rename.
 */
export async function saveWebhookRegistration(file: string, registration: WebhookRegistration): Promise<SaveWebhookResult> {
  const r = webhookRegistrationSchema.parse(registration);
  return serialized(file, async () => {
    const store = await readWebhooks(file);
    const key = r.subscriber.toLowerCase();
    const previous = store.webhooks[key] ?? null;
    if (previous && previous.issued > r.issued) return { stored: false, current: previous };
    store.webhooks[key] = r;
    await writeAtomic(file, `${JSON.stringify(webhooksFileSchema.parse(store), null, 2)}\n`);
    return { stored: true, previous };
  });
}

export type RegisterWebhookResult = Exclude<WebhookVerification, { ok: true }> | ({ ok: true; registration: WebhookRegistration } & SaveWebhookResult);

/** Verifies a registration (verifyWebhookRegistration) and stores it when it passes: what the web API calls. */
export async function registerWebhook(file: string, input: unknown, opts: VerifyWebhookOptions = {}): Promise<RegisterWebhookResult> {
  const v = await verifyWebhookRegistration(input, { ...opts, ignoreAge: false });
  if (!v.ok) return v;
  return { ok: true, registration: v.registration, ...(await saveWebhookRegistration(file, v.registration)) };
}

export interface WebhookAlertSinkOptions extends Omit<DeliverWebhooksOptions, 'fetch'> {
  /** `<watch dir>/webhooks.json`, read again for every event so new registrations apply without a restart. */
  webhooksFile: string;
  /** Default: the global fetch. */
  fetch?: FetchLike;
  /** Public URL of certs/checks for the payload's reportURL. */
  reportBaseUrl?: string;
}

/**
 * The watcher's webhook AlertSink: for each `changed` event, POSTs the ADR payload to the registered webhook of
 * every given subscription on that subject (deliverWebhookAlerts: 3 attempts with backoff, a timeout, no
 * redirects) and returns the `alerted` events. A missing webhooks.json means nobody registered: no alerts. A
 * broken one throws, so the watcher logs an error instead of silently dropping alerts.
 */
export function createWebhookAlertSink(opts: WebhookAlertSinkOptions): AlertSink {
  const fetchFn = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  return {
    async deliver(event, subs) {
      if (event.kind !== 'changed' || subs.length === 0) return [];
      const { webhooks } = await readWebhooks(opts.webhooksFile);
      return deliverWebhookAlerts(event, subs, webhooks, { ...opts, fetch: fetchFn });
    },
  };
}
