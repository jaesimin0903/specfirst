/*
 * The part of the alert subscriptions the web uses (ADR 0006): the CheckSubscriptions ABI, the day accounting of the
 * contract, and the webhook message, URL rules, registration schema and verification. They come from
 * @specfirst/core/subs, which imports only viem and zod, so client components can use them too; every other web
 * module imports them from here. The webhooks.json store is Node only (lib/watch/webhooks.ts).
 */
export * from '@specfirst/core/subs';
