import { verifyWebhookRegistration } from '../subs/core';
import type { SubscriberStanding } from '../subs/service';
import { serialized } from './atomic';
import { publicWebhook, readWebhooks, registerStatus, registerWebhook } from './webhooks';

/*
 * The web's policy around registerWebhook (team decision on webhooks.json growth): a URL is stored only for a
 * subscriber holding an active subscription on the configured CheckSubscriptions, and the file keeps at most
 * MAX_WEBHOOK_SUBSCRIBERS subscribers (a subscriber already in it may always update). Local URLs are accepted only
 * for this site's own origin when SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1, the exact-origin rule core is moving to.
 * Server only.
 */

export const MAX_WEBHOOK_SUBSCRIBERS = 1000;

export interface RegistrationDeps {
  file: string;
  /** Exact origins a local (localhost, 127.0.0.1) webhook may have; [] refuses local URLs. */
  allowedLocalOrigins: readonly string[];
  standing(subscriber: string): Promise<SubscriberStanding>;
  /** unix seconds */
  now?: number;
  maxSubscribers?: number;
}

export interface RegistrationResponse {
  status: number;
  body: { ok: true; webhook: { subscriber: string; origin: string; issued: number } } | { ok: false; reason?: string; error: string };
}

/** The site's own origin when SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1, else nothing. */
export function localOriginsFor(requestUrl: string, env: Record<string, string | undefined> = process.env): string[] {
  if (env.SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS?.trim() !== '1') return [];
  try {
    return [new URL(requestUrl).origin];
  } catch {
    return [];
  }
}

/** A URL to localhost or 127.0.0.1 whose origin is not allowed exactly; null when it is fine on this count. */
export function localOriginProblem(url: unknown, allowed: readonly string[]): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') return null;
  return allowed.includes(u.origin)
    ? null
    : allowed.length
      ? `url may be local only at this site's own origin, ${allowed.join(', ')}`
      : 'url points at a private or loopback address';
}

const fail = (status: number, error: string, reason?: string): RegistrationResponse => ({ status, body: { ok: false, ...(reason ? { reason } : {}), error } });

export async function registerWithPolicy(input: unknown, deps: RegistrationDeps): Promise<RegistrationResponse> {
  const local = localOriginProblem((input as { url?: unknown } | null)?.url, deps.allowedLocalOrigins);
  if (local) return fail(400, local, 'url');
  const opts = { now: deps.now, allowLocalHttp: deps.allowedLocalOrigins.length > 0 };
  const v = await verifyWebhookRegistration(input, opts);
  if (!v.ok) return fail(v.reason === 'signature' ? 401 : 400, v.message, v.reason);
  const subscriber = v.registration.subscriber;

  const standing = await deps.standing(subscriber);
  if (standing.state === 'not-deployed')
    return fail(503, 'subscriptions are not deployed on this server, so there is nothing to alert on and no webhook is stored');
  if (standing.state === 'error')
    return fail(503, `could not read CheckSubscriptions to confirm an active subscription (${standing.error}); try again shortly`);
  if (standing.state === 'none') return fail(409, `${subscriber} holds no active subscription; subscribe to a vault first, then register a webhook`);

  const max = deps.maxSubscribers ?? MAX_WEBHOOK_SUBSCRIBERS;
  // One registration at a time through this route, so the cap cannot be passed by two at once. The key differs
  // from the one registerWebhook serializes on, which runs inside.
  return serialized(`${deps.file}#register`, async () => {
    let known: Record<string, unknown>;
    try {
      known = (await readWebhooks(deps.file)).webhooks;
    } catch {
      return fail(500, 'webhooks.json on this server is unreadable, so nothing was stored');
    }
    if (!known[subscriber.toLowerCase()] && Object.keys(known).length >= max) {
      return fail(429, `this server already holds webhooks for ${max} subscribers; new ones are refused for now`);
    }
    const r = await registerWebhook(deps.file, input, opts);
    const status = registerStatus(r);
    if (!r.ok) return fail(status, r.message, r.reason);
    if (!r.stored) return fail(status, 'a newer registration for this subscriber is already stored');
    return { status: 200, body: { ok: true, webhook: { subscriber: r.registration.subscriber, ...publicWebhook(r.registration)! } } };
  });
}
