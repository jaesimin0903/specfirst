import { readWebhooks, type RegisterWebhookResult } from '@specfirst/core/webhooks';
import type { WebhookRegistration } from '../subs/core';
import { watchFile } from './paths';

/*
 * <watch dir>/webhooks.json, where the web stores webhook registrations and the watcher's alert sink reads them
 * (ADR 0006, "Alerts"). The store is core's, from the Node-only @specfirst/core/webhooks (never the package root):
 * readWebhooks, and registerWebhook, the only way in (verified in full, latest per subscriber wins, written 0600
 * through a temp file). A webhook URL can be a secret (chat webhooks are), so the file is never served and the API
 * shows only a URL's origin. Server only.
 */

export { readWebhooks, registerWebhook, WEBHOOKS_JSON, WebhookStoreError, type RegisterWebhookResult } from '@specfirst/core/webhooks';

/* Web-only helpers. */

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
