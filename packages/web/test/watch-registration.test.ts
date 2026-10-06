import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { webhookMessage } from '../lib/subs/core';
import type { SubscriberStanding } from '../lib/subs/service';
import { localOriginProblem, localOriginsFor, registerWithPolicy, type RegistrationDeps } from '../lib/watch/registration';
import { inboxNote } from '../lib/watch/words';

/*
 * The web's policy around registerWebhook: an active subscription is required, at most N subscribers are stored
 * (an existing one may update), and a local URL is accepted only at this site's own origin.
 */

const NOW = 1_791_000_000;
const key = (n: number) => privateKeyToAccount(keccak256(toHex(`watch-web registration key ${n}`)));

async function reg(n: number, o: { url?: string; issued?: number } = {}) {
  const a = key(n);
  const url = o.url ?? `https://hooks.example.com/${n}`;
  const issued = o.issued ?? NOW;
  return { subscriber: a.address, url, issued, signature: await a.signMessage({ message: webhookMessage({ subscriber: a.address, url, issued }) }) };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sf-registration-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function deps(file: string, standing: SubscriberStanding | ((s: string) => SubscriberStanding), over: Partial<RegistrationDeps> = {}): RegistrationDeps {
  return { file, allowedLocalOrigins: [], now: NOW, standing: async (s) => (typeof standing === 'function' ? standing(s) : standing), ...over };
}

describe('registerWithPolicy', () => {
  it('stores for a subscriber with an active subscription and answers with the origin only', async () => {
    const file = path.join(dir, 'a.json');
    const r = await registerWithPolicy(await reg(1), deps(file, { state: 'active', ids: ['0'] }));
    expect(r).toEqual({ status: 200, body: { ok: true, webhook: { subscriber: key(1).address, origin: 'https://hooks.example.com', issued: NOW } } });
    expect(JSON.parse(await readFile(file, 'utf8')).webhooks[key(1).address.toLowerCase()].url).toBe('https://hooks.example.com/1');
  });

  it('no active subscription is 409, not deployed or unreadable is 503, and nothing is stored', async () => {
    const file = path.join(dir, 'b.json');
    expect((await registerWithPolicy(await reg(2), deps(file, { state: 'none' }))).status).toBe(409);
    const off = await registerWithPolicy(await reg(2), deps(file, { state: 'not-deployed' }));
    expect(off.status).toBe(503);
    expect(off.body).toMatchObject({ ok: false, error: expect.stringMatching(/subscriptions are not deployed/) });
    expect((await registerWithPolicy(await reg(2), deps(file, { state: 'error', error: 'rate limited' }))).status).toBe(503);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('checks the signature before reading the chain', async () => {
    let asked = 0;
    const bad = { ...(await reg(3)), url: 'https://hooks.example.com/changed' };
    const r = await registerWithPolicy(
      bad,
      deps(path.join(dir, 'c.json'), () => {
        asked++;
        return { state: 'active', ids: ['1'] };
      }),
    );
    expect(r.status).toBe(401);
    expect(asked).toBe(0);
  });

  it('caps the number of subscribers: a new one past the cap is 429, an existing one may still update', async () => {
    const file = path.join(dir, 'd.json');
    const d = deps(file, { state: 'active', ids: ['0'] }, { maxSubscribers: 2 });
    expect((await registerWithPolicy(await reg(10), d)).status).toBe(200);
    expect((await registerWithPolicy(await reg(11), d)).status).toBe(200);
    const third = await registerWithPolicy(await reg(12), d);
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ ok: false, error: expect.stringMatching(/for 2 subscribers/) });
    const update = await registerWithPolicy(await reg(10, { url: 'https://hooks.example.com/new', issued: NOW + 5 }), { ...d, now: NOW + 5 });
    expect(update.status).toBe(200);
    const stored = JSON.parse(await readFile(file, 'utf8')).webhooks;
    expect(Object.keys(stored)).toHaveLength(2);
    expect(stored[key(10).address.toLowerCase()].url).toBe('https://hooks.example.com/new');
  });

  it('an older registration than the stored one is 409', async () => {
    const file = path.join(dir, 'e.json');
    const d = deps(file, { state: 'active', ids: ['0'] });
    expect((await registerWithPolicy(await reg(20, { issued: NOW }), d)).status).toBe(200);
    expect((await registerWithPolicy(await reg(20, { issued: NOW - 30, url: 'https://hooks.example.com/old' }), d)).status).toBe(409);
  });

  it('a broken webhooks.json is 500 and is left as it was', async () => {
    const file = path.join(dir, 'f.json');
    await writeFile(file, '{"v":1,');
    expect((await registerWithPolicy(await reg(30), deps(file, { state: 'active', ids: ['0'] }))).status).toBe(500);
    expect(await readFile(file, 'utf8')).toBe('{"v":1,');
  });
});

describe('local webhooks', () => {
  it('the flag opens exactly the site origin; other local URLs stay refused', async () => {
    expect(localOriginsFor('http://localhost:3418/api/v1/watch/webhooks', { SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS: '1' })).toEqual(['http://localhost:3418']);
    expect(localOriginsFor('http://localhost:3418/x', {})).toEqual([]);
    const allowed = ['http://localhost:3418'];
    expect(localOriginProblem('http://localhost:3418/api/v1/watch/demo-hook', allowed)).toBeNull();
    expect(localOriginProblem('http://localhost:9999/hook', allowed)).toMatch(/only at this site's own origin/);
    expect(localOriginProblem('http://127.0.0.1:3418/hook', allowed)).toMatch(/only at this site's own origin/);
    expect(localOriginProblem('https://hooks.example.com/x', allowed)).toBeNull();
    const file = path.join(dir, 'g.json');
    const d = deps(file, { state: 'active', ids: ['0'] }, { allowedLocalOrigins: allowed });
    expect((await registerWithPolicy(await reg(40, { url: 'http://localhost:3418/api/v1/watch/demo-hook' }), d)).status).toBe(200);
    expect((await registerWithPolicy(await reg(41, { url: 'http://localhost:9999/hook' }), d)).status).toBe(400);
    expect((await registerWithPolicy(await reg(42, { url: 'http://localhost:3418/hook' }), { ...d, allowedLocalOrigins: [] })).status).toBe(400);
  });
});

describe('inbox titles', () => {
  it('a first outcome is a first result; "Result changed" is kept for real changes', () => {
    expect(inboxNote('change', 'new')).toBe('First result');
    expect(inboxNote('change', 'regressed')).toBe('Result changed');
    expect(inboxNote('change', 'changed')).toBe('Result changed');
    expect(inboxNote('first-check', null)).toBe('First check since you subscribed');
    expect(inboxNote('delivery', undefined)).toBe('Delivery');
  });
});
