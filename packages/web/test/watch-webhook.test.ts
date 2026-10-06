import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyWebhookRegistration, webhookMessage, webhookUrlProblem, WEBHOOK_MAX_AGE_SEC } from '../lib/subs/core';
import { publicWebhook, readWebhooks, registerStatus, registerWebhook, webhookOf } from '../lib/watch/webhooks';

/*
 * Webhook registration (ADR 0006, "Alerts"), with the stand-ins for @specfirst/core/subs and the core root's
 * webhooks.json helpers: the exact EIP-191 text, the URL rules, freshness, and the file the watcher reads. The keys
 * are derived from fixed strings, test only.
 */

const account = privateKeyToAccount(keccak256(toHex('watch-web test key A')));
const other = privateKeyToAccount(keccak256(toHex('watch-web test key B')));
const NOW = 1_791_000_000;
const URL_OK = 'https://hooks.example.com/specfirst?k=1';

async function signed(o: { url?: string; issued?: number; by?: typeof account; subscriber?: string } = {}) {
  const subscriber = o.subscriber ?? account.address;
  const url = o.url ?? URL_OK;
  const issued = o.issued ?? NOW;
  const signature = await (o.by ?? account).signMessage({ message: webhookMessage({ subscriber, url, issued }) });
  return { subscriber, url, issued, signature };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'sf-webhooks-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('webhookMessage', () => {
  it('is exactly the ADR text, with the subscriber checksummed', () => {
    expect(webhookMessage({ subscriber: account.address.toLowerCase(), url: URL_OK, issued: NOW })).toBe(
      `Specfirst alerts webhook\nsubscriber: ${account.address}\nurl: ${URL_OK}\nissued: ${NOW}`,
    );
    expect(() => webhookMessage({ subscriber: account.address, url: URL_OK, issued: 1.5 })).toThrow(/unix seconds/);
  });
});

describe('verifyWebhookRegistration', () => {
  it('accepts a fresh signature by the subscriber, also with a lowercase address, and returns it checksummed', async () => {
    const ok = await verifyWebhookRegistration(await signed(), { now: NOW + 30 });
    expect(ok).toMatchObject({ ok: true, registration: { subscriber: account.address, url: URL_OK, issued: NOW } });
    const lower = await verifyWebhookRegistration({ ...(await signed()), subscriber: account.address.toLowerCase() }, { now: NOW });
    expect(lower).toMatchObject({ ok: true, registration: { subscriber: account.address } });
  });

  it('names why it refuses: signature, url, stale, future, invalid', async () => {
    expect(await verifyWebhookRegistration(await signed({ by: other }), { now: NOW })).toMatchObject({ ok: false, reason: 'signature' });
    expect(await verifyWebhookRegistration({ ...(await signed()), url: 'https://evil.example.com/' }, { now: NOW })).toMatchObject({
      ok: false,
      reason: 'signature',
    });
    expect(await verifyWebhookRegistration(await signed(), { now: NOW + WEBHOOK_MAX_AGE_SEC + 1 })).toMatchObject({ ok: false, reason: 'stale' });
    expect(await verifyWebhookRegistration(await signed(), { now: NOW + WEBHOOK_MAX_AGE_SEC })).toMatchObject({ ok: true });
    expect(await verifyWebhookRegistration(await signed({ issued: NOW + 61 }), { now: NOW })).toMatchObject({ ok: false, reason: 'future' });
    expect(await verifyWebhookRegistration(await signed({ url: 'http://hooks.example.com/' }), { now: NOW })).toMatchObject({ ok: false, reason: 'url' });
    expect(await verifyWebhookRegistration({ ...(await signed()), extra: 1 }, { now: NOW })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await verifyWebhookRegistration(null, { now: NOW })).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('local http opens localhost and 127.0.0.1 only, and only with the flag', async () => {
    const local = await signed({ url: 'http://localhost:3418/api/v1/watch/demo-hook' });
    expect((await verifyWebhookRegistration(local, { now: NOW })).ok).toBe(false);
    expect((await verifyWebhookRegistration(local, { now: NOW, allowLocalHttp: true })).ok).toBe(true);
    expect((await verifyWebhookRegistration(await signed({ url: 'http://10.0.0.5/hook' }), { now: NOW, allowLocalHttp: true })).ok).toBe(false);
    expect((await verifyWebhookRegistration(await signed({ url: 'http://[::1]/hook' }), { now: NOW, allowLocalHttp: true })).ok).toBe(false);
  });
});

describe('the URL rules', () => {
  it('https to a public host only; no credentials, whitespace, private or CGNAT hosts, or very long URLs', () => {
    expect(webhookUrlProblem(URL_OK)).toBeNull();
    expect(webhookUrlProblem('https://user:pw@hooks.example.com/')).toBe('carries credentials');
    for (const h of [
      'https://localhost/x',
      'https://a.localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://192.168.0.2/x',
      'https://172.20.0.1/x',
      'https://169.254.169.254/x',
      'https://100.64.0.1/x',
      'https://[::1]/x',
      'https://0.0.0.0/x',
    ]) {
      expect(webhookUrlProblem(h), h).toBe('points at a private or loopback address');
    }
    expect(webhookUrlProblem('https://172.32.0.1/x')).toBeNull();
    expect(webhookUrlProblem(`https://hooks.example.com/${'a'.repeat(2100)}`)).toMatch(/longer than 2048/);
    expect(webhookUrlProblem('https://hooks.example.com/a b')).toMatch(/whitespace/);
    expect(webhookUrlProblem('https://hooks.example.com/a\nissued: 1')).toMatch(/whitespace/);
    expect(webhookUrlProblem('ftp://hooks.example.com/')).toBe('not https');
    expect(webhookUrlProblem('http://localhost:3418/x', { allowLocalHttp: true })).toBeNull();
    expect(webhookUrlProblem('https://127.0.0.1/x', { allowLocalHttp: true })).toBeNull();
    expect(webhookUrlProblem('http://hooks.example.com/', { allowLocalHttp: true })).toBe('not https');
  });
});

describe('webhooks.json', () => {
  it('stores the latest registration per subscriber, atomically; an older one is not stored', async () => {
    const file = path.join(dir, 'webhooks.json');
    const first = await registerWebhook(file, await signed({ issued: NOW }), { now: NOW });
    expect(first).toMatchObject({ ok: true, stored: true, previous: null });
    const newer = await registerWebhook(file, await signed({ issued: NOW + 60, url: 'https://hooks.example.com/v2' }), { now: NOW + 60 });
    expect(newer).toMatchObject({ ok: true, stored: true, previous: { issued: NOW } });
    const older = await registerWebhook(file, await signed({ issued: NOW + 30 }), { now: NOW + 60 });
    expect(older).toMatchObject({ ok: true, stored: false, current: { issued: NOW + 60 } });
    expect(registerStatus(older)).toBe(409);
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.v).toBe(1);
    expect(Object.keys(raw.webhooks)).toEqual([account.address.toLowerCase()]);
    expect(raw.webhooks[account.address.toLowerCase()]).toMatchObject({ subscriber: account.address, url: 'https://hooks.example.com/v2', issued: NOW + 60 });
    expect((await readWebhooks(file)).webhooks[account.address.toLowerCase()]!.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(publicWebhook(await webhookOf(account.address, file))).toEqual({ origin: 'https://hooks.example.com', issued: NOW + 60 });
  });

  it('a refused registration writes nothing and maps to 400 or 401', async () => {
    const file = path.join(dir, 'w2.json');
    const bad = await registerWebhook(file, { ...(await signed()), url: 'https://127.0.0.1/' }, { now: NOW });
    expect(bad).toMatchObject({ ok: false, reason: 'url' });
    expect(registerStatus(bad)).toBe(400);
    const wrong = await registerWebhook(file, await signed({ by: other }), { now: NOW });
    expect(registerStatus(wrong)).toBe(401);
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('a missing file is an empty store; a broken one throws, and webhookOf reads it as none', async () => {
    expect(await readWebhooks(path.join(dir, 'none.json'))).toEqual({ v: 1, webhooks: {} });
    const broken = path.join(dir, 'broken.json');
    await writeFile(broken, '{"v":1,"webhooks":');
    await expect(readWebhooks(broken)).rejects.toThrow(/not readable JSON/);
    expect(await webhookOf(account.address, broken)).toBeNull();
    await expect(registerWebhook(broken, await signed(), { now: NOW })).rejects.toThrow(/not readable JSON/);
  });
});
