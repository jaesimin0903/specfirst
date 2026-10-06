import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  emptyWebhooksFile,
  verifyWebhookRegistration,
  webhookRegistrationSchema,
  webhooksFileSchema,
  type VerifyWebhookOptions,
  type WebhookRegistration,
  type WebhookVerification,
  type WebhooksFile,
} from '../subs/core';
import { serialized } from './atomic';
import { watchFile } from './paths';

/*
 * <watch dir>/webhooks.json, where the web stores webhook registrations and the watcher reads them (ADR 0006,
 * "Alerts"). The first part stands in for the Node helpers @specfirst/core exports from its root on
 * feat/subscriptions (subs/webhooks.ts: readWebhooks, saveWebhookRegistration, registerWebhook), same names and
 * behavior, so the swap is an import change. A webhook URL can be a secret (chat webhooks are), so the file is
 * never served and the API shows only a URL's origin. Server only.
 */

export class WebhookStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookStoreError';
  }
}

/** Reads and validates webhooks.json; a missing file is an empty store, a broken one throws. */
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

export type SaveWebhookResult = { stored: true; previous: WebhookRegistration | null } | { stored: false; current: WebhookRegistration };

/**
 * Stores a verified registration, replacing the subscriber's previous one only when it was issued at the same
 * time or later, so an older registration replayed within its window cannot undo a newer one.
 */
export async function saveWebhookRegistration(file: string, registration: WebhookRegistration): Promise<SaveWebhookResult> {
  const r = webhookRegistrationSchema.parse(registration);
  return serialized(path.resolve(file), async () => {
    const store = await readWebhooks(file);
    const key = r.subscriber.toLowerCase();
    const previous = store.webhooks[key] ?? null;
    if (previous && previous.issued > r.issued) return { stored: false, current: previous } as SaveWebhookResult;
    store.webhooks[key] = r;
    await writeAtomic(file, `${JSON.stringify(webhooksFileSchema.parse(store), null, 2)}\n`);
    return { stored: true, previous } as SaveWebhookResult;
  });
}

export type RegisterWebhookResult = Exclude<WebhookVerification, { ok: true }> | ({ ok: true; registration: WebhookRegistration } & SaveWebhookResult);

/** Verifies a registration and stores it when it passes: what the web API calls. */
export async function registerWebhook(file: string, input: unknown, opts: VerifyWebhookOptions = {}): Promise<RegisterWebhookResult> {
  const v = await verifyWebhookRegistration(input, { ...opts, ignoreAge: false });
  if (!v.ok) return v;
  return { ok: true, registration: v.registration, ...(await saveWebhookRegistration(file, v.registration)) };
}

/* Web-only helpers, kept when the part above becomes an import from @specfirst/core. */

/** The subscriber's registration, or null when there is none or the file cannot be read. */
export async function webhookOf(subscriber: string, file: string = watchFile.webhooks()): Promise<WebhookRegistration | null> {
  try {
    return (await readWebhooks(file)).webhooks[subscriber.toLowerCase()] ?? null;
  } catch {
    return null;
  }
}

/** What the API may show of a registration: the URL's origin and when it was signed, never the full URL. */
export function publicWebhook(w: Pick<WebhookRegistration, 'url' | 'issued'> | null): { origin: string; issued: number } | null {
  if (!w) return null;
  try {
    return { origin: new URL(w.url).origin, issued: w.issued };
  } catch {
    return { origin: 'unreadable URL', issued: w.issued };
  }
}

/** HTTP status for a refused registration: 401 for a wrong signature, 409 when a newer one is stored, else 400. */
export function registerStatus(r: RegisterWebhookResult): number {
  if (!r.ok) return r.reason === 'signature' ? 401 : 400;
  return r.stored ? 200 : 409;
}
