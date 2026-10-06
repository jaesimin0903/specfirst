import { getAddress } from 'viem';
import { z } from 'zod';
import { verifyWebhookRegistration, type WebhookRegistration } from './core';
import { readJsonOrNull, serialized, writeJsonAtomic } from './atomic';
import { watchFile } from './paths';

/*
 * Webhook registrations (ADR 0006, "Alerts"): verified here, stored in <watch dir>/webhooks.json for the watcher,
 * latest per subscriber. File shape: { v: 1, webhooks: { <lowercase subscriber>: { subscriber, url, issued,
 * signature } } }. Server only.
 */

const entrySchema = z.object({
  subscriber: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  url: z.string(),
  issued: z.number().int().positive(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export type StoredWebhook = z.infer<typeof entrySchema>;

export const MAX_WEBHOOK_URL = 2048;
/** Registrations kept; past it the oldest by issued are dropped, so the file cannot grow without bound. */
export const MAX_WEBHOOKS = 1000;

/** SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1 lets http://localhost URLs register, for the demo receiver on a dev machine. */
export function allowLocalHttp(env: Record<string, string | undefined> = process.env): boolean {
  return env.SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS?.trim() === '1';
}

function isPrivateIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (isPrivateIpv4(h)) return true;
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    return v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:');
  }
  return false;
}

/**
 * The web's own rules on top of the ADR's: no credentials in the URL, a bounded length, and no loopback, private
 * or link-local host unless local http is allowed (then only localhost names). A public name that resolves to a
 * private address is the watcher's to refuse when it delivers.
 */
export function urlProblem(raw: string, localHttp: boolean): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return 'url is required';
  if (raw.length > MAX_WEBHOOK_URL) return `url is longer than ${MAX_WEBHOOK_URL} characters`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'url is not a URL';
  }
  if (u.username || u.password) return 'url must not carry a user name or password';
  if (u.protocol === 'http:') return localHttp && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ? null : localHttp ? 'http is allowed for localhost only' : 'url must be https';
  if (u.protocol !== 'https:') return 'url must be https';
  if (isLocalHost(u.hostname) && !localHttp) return 'url points at a local or private host';
  return null;
}

export function parseWebhooksFile(raw: unknown): Record<string, StoredWebhook> {
  const r = raw as { v?: unknown; webhooks?: unknown } | null;
  if (!r || r.v !== 1 || !r.webhooks || typeof r.webhooks !== 'object' || Array.isArray(r.webhooks)) return {};
  const out: Record<string, StoredWebhook> = {};
  for (const [k, v] of Object.entries(r.webhooks as Record<string, unknown>)) {
    const e = entrySchema.safeParse(v);
    if (e.success && k.toLowerCase() === e.data.subscriber.toLowerCase()) out[k.toLowerCase()] = e.data;
  }
  return out;
}

export async function readWebhooks(file: string = watchFile.webhooks()): Promise<Record<string, StoredWebhook>> {
  return parseWebhooksFile(await readJsonOrNull(file));
}

export async function webhookOf(subscriber: string, file: string = watchFile.webhooks()): Promise<StoredWebhook | null> {
  return (await readWebhooks(file))[subscriber.toLowerCase()] ?? null;
}

/** Adds or replaces one entry; keeps the newest MAX_WEBHOOKS by issued. Pure. */
export function withWebhook(all: Record<string, StoredWebhook>, entry: StoredWebhook, max: number = MAX_WEBHOOKS): Record<string, StoredWebhook> {
  const next = { ...all, [entry.subscriber.toLowerCase()]: entry };
  const keys = Object.keys(next);
  if (keys.length <= max) return next;
  const keep = keys.sort((a, b) => next[b]!.issued - next[a]!.issued).slice(0, max);
  return Object.fromEntries(keep.sort().map((k) => [k, next[k]!]));
}

export type RegisterResult = { ok: true; webhook: StoredWebhook } | { ok: false; status: number; reason: string };

export async function registerWebhook(
  input: unknown,
  o: { file?: string; now?: number; localHttp?: boolean } = {},
): Promise<RegisterResult> {
  const body = input as Partial<WebhookRegistration> | null;
  if (!body || typeof body !== 'object') return { ok: false, status: 400, reason: 'expected a JSON object { subscriber, url, issued, signature }' };
  const localHttp = o.localHttp ?? allowLocalHttp();
  const bad = urlProblem(body.url as string, localHttp);
  if (bad) return { ok: false, status: 400, reason: bad };
  const reg = { subscriber: String(body.subscriber ?? ''), url: body.url as string, issued: Number(body.issued), signature: String(body.signature ?? '') as `0x${string}` };
  const v = await verifyWebhookRegistration(reg, { now: o.now, allowLocalHttp: localHttp });
  if (!v.ok) return { ok: false, status: v.reason.startsWith('signature is not') || v.reason.startsWith('signature does not') ? 401 : 400, reason: v.reason };
  const file = o.file ?? watchFile.webhooks();
  const entry: StoredWebhook = { subscriber: getAddress(v.subscriber), url: reg.url, issued: reg.issued, signature: reg.signature };
  return serialized(file, async () => {
    const all = parseWebhooksFile(await readJsonOrNull(file));
    const current = all[entry.subscriber.toLowerCase()];
    if (current && current.issued > entry.issued) return { ok: false, status: 409, reason: 'a newer registration for this subscriber is already stored' } as RegisterResult;
    await writeJsonAtomic(file, { v: 1, webhooks: withWebhook(all, entry) });
    return { ok: true, webhook: entry } as RegisterResult;
  });
}
