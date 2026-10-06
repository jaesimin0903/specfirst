import { bareHostname, isIpLiteral, isPrivateAddress, verifyWebhookRegistration, webhookUrlProblem, type WebhookVerification } from '../subs/core';
import type { SubscriberStanding } from '../subs/service';
import { serialized } from './atomic';
import { publicWebhook, readWebhooks, registerStatus, registerWebhook } from './webhooks';

/*
 * The web's policy around core's registerWebhook (team decision on webhooks.json growth): a URL is stored only for
 * a subscriber holding an active subscription on the configured CheckSubscriptions, and the file keeps at most
 * MAX_WEBHOOK_SUBSCRIBERS subscribers (a subscriber already in it may always update). Local URLs are accepted only
 * at this site's own origin when SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1, through core's allowedLocalOrigins (exact
 * origins); the watcher delivers to them only when started with the same --webhook-local-origin. Server only.
 */

export const MAX_WEBHOOK_SUBSCRIBERS = 1000;

export interface RegistrationDeps {
  file: string;
  /** Exact origins a local or private webhook may have (core's allowedLocalOrigins); [] refuses them. */
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

const fail = (status: number, error: string, reason?: string): RegistrationResponse => ({ status, body: { ok: false, ...(reason ? { reason } : {}), error } });

function isLocalHost(u: URL): boolean {
  const host = bareHostname(u);
  return host === 'localhost' || host.endsWith('.localhost') || (isIpLiteral(u) && isPrivateAddress(host));
}

/**
 * What to tell someone whose local URL core refused only because its origin is not allowed (core says "not https" or
 * "points at a private or loopback address"): where a local webhook may live on this server. null for any other
 * refusal, which keeps core's message.
 */
export function localUrlMessage(url: unknown, allowed: readonly string[]): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!isLocalHost(u) || allowed.includes(u.origin) || webhookUrlProblem(url, { allowedLocalOrigins: [u.origin] }) !== null) return null;
  return allowed.length
    ? `url may be local only at this site's own origin, ${allowed.join(', ')}`
    : 'url points at a local address; this server takes local webhooks only at its own origin, and only with SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1';
}

/** A refused verification as a response: core's reason code, and its message unless localUrlMessage says more. */
function refused(v: Exclude<WebhookVerification, { ok: true }>, url: unknown, allowed: readonly string[]): RegistrationResponse {
  const status = v.reason === 'signature' ? 401 : 400;
  return fail(status, (v.reason === 'url' ? localUrlMessage(url, allowed) : null) ?? v.message, v.reason);
}

export async function registerWithPolicy(input: unknown, deps: RegistrationDeps): Promise<RegistrationResponse> {
  const opts = { now: deps.now, allowedLocalOrigins: deps.allowedLocalOrigins };
  const url = (input as { url?: unknown } | null)?.url;
  const v = await verifyWebhookRegistration(input, opts);
  if (!v.ok) return refused(v, url, deps.allowedLocalOrigins);
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
    if (!r.ok) return refused(r, url, deps.allowedLocalOrigins);
    const status = registerStatus(r);
    if (!r.stored) return fail(status, 'a newer registration for this subscriber is already stored');
    return { status: 200, body: { ok: true, webhook: { subscriber: r.registration.subscriber, ...publicWebhook(r.registration)! } } };
  });
}
