import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyWebhookRegistration, webhookMessage, WEBHOOK_MAX_AGE_SEC } from '../lib/watch/core';
import { parseWebhooksFile, registerWebhook, urlProblem, withWebhook } from '../lib/watch/webhooks';

/*
 * Webhook registration (ADR 0006, "Alerts"): the exact EIP-191 text, the checks the API makes before storing a
 * URL, and the file the watcher reads. The keys are derived from fixed strings, test only.
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
  });
});

describe('verifyWebhookRegistration', () => {
  it('accepts a fresh signature by the subscriber, also with a lowercase address', async () => {
    expect(await verifyWebhookRegistration(await signed(), { now: NOW + 30 })).toEqual({ ok: true, subscriber: account.address });
    expect((await verifyWebhookRegistration({ ...(await signed()), subscriber: account.address.toLowerCase() }, { now: NOW })).ok).toBe(true);
  });

  it('rejects another signer, a changed URL, a stale or future time, and http', async () => {
    expect(await verifyWebhookRegistration(await signed({ by: other }), { now: NOW })).toMatchObject({
      ok: false,
      reason: 'signature is not by the subscriber',
    });
    expect(await verifyWebhookRegistration({ ...(await signed()), url: 'https://evil.example.com/' }, { now: NOW })).toMatchObject({ ok: false });
    expect(await verifyWebhookRegistration(await signed(), { now: NOW + WEBHOOK_MAX_AGE_SEC + 1 })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/older than 10 minutes/),
    });
    expect(await verifyWebhookRegistration(await signed(), { now: NOW + WEBHOOK_MAX_AGE_SEC })).toMatchObject({ ok: true });
    expect(await verifyWebhookRegistration(await signed({ issued: NOW + 600 }), { now: NOW })).toMatchObject({ ok: false, reason: 'issued is in the future' });
    expect(await verifyWebhookRegistration(await signed({ url: 'http://hooks.example.com/' }), { now: NOW })).toMatchObject({
      ok: false,
      reason: 'url must be https',
    });
    expect(await verifyWebhookRegistration({ ...(await signed()), signature: '0x1234' as `0x${string}` }, { now: NOW })).toMatchObject({ ok: false });
  });

  it('http is allowed for localhost only, and only when the flag is on', async () => {
    const local = await signed({ url: 'http://localhost:3418/api/v1/watch/demo-hook' });
    expect((await verifyWebhookRegistration(local, { now: NOW })).ok).toBe(false);
    expect((await verifyWebhookRegistration(local, { now: NOW, allowLocalHttp: true })).ok).toBe(true);
    expect((await verifyWebhookRegistration(await signed({ url: 'http://10.0.0.5/hook' }), { now: NOW, allowLocalHttp: true })).ok).toBe(false);
    expect((await verifyWebhookRegistration(await signed({ url: 'http://[::1]/hook' }), { now: NOW, allowLocalHttp: true })).ok).toBe(false);
  });
});

describe('the web URL rules', () => {
  it('refuses credentials, private hosts and very long URLs', () => {
    expect(urlProblem(URL_OK, false)).toBeNull();
    expect(urlProblem('https://user:pw@hooks.example.com/', false)).toMatch(/user name or password/);
    for (const h of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://10.1.2.3/x',
      'https://192.168.0.2/x',
      'https://172.20.0.1/x',
      'https://169.254.169.254/x',
      'https://[::1]/x',
      'https://box.internal/x',
    ]) {
      expect(urlProblem(h, false), h).toMatch(/local or private/);
    }
    expect(urlProblem('https://172.32.0.1/x', false)).toBeNull();
    expect(urlProblem(`https://hooks.example.com/${'a'.repeat(2100)}`, false)).toMatch(/longer than/);
    expect(urlProblem('ftp://hooks.example.com/', false)).toBe('url must be https');
    expect(urlProblem('http://localhost:3418/x', true)).toBeNull();
    expect(urlProblem('http://hooks.example.com/', true)).toBe('http is allowed for localhost only');
    expect(urlProblem('http://[::1]:3418/x', true)).toBe('http is allowed for localhost only');
    expect(urlProblem('https://10.0.0.1/x', true)).toMatch(/local or private/);
    expect(urlProblem('https://hooks.example.com/a b', false)).toMatch(/whitespace/);
    expect(urlProblem('https://hooks.example.com/a\nissued: 1', false)).toMatch(/whitespace/);
  });
});

describe('webhooks.json', () => {
  it('stores the latest registration per subscriber, atomically, and refuses an older one', async () => {
    const file = path.join(dir, 'webhooks.json');
    const first = await registerWebhook(await signed({ issued: NOW }), { file, now: NOW, localHttp: false });
    expect(first).toMatchObject({ ok: true });
    const newer = await registerWebhook(await signed({ issued: NOW + 60, url: 'https://hooks.example.com/v2' }), { file, now: NOW + 60, localHttp: false });
    expect(newer).toMatchObject({ ok: true });
    const older = await registerWebhook(await signed({ issued: NOW + 30 }), { file, now: NOW + 60, localHttp: false });
    expect(older).toMatchObject({ ok: false, status: 409 });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.v).toBe(1);
    expect(Object.keys(raw.webhooks)).toEqual([account.address.toLowerCase()]);
    expect(raw.webhooks[account.address.toLowerCase()]).toMatchObject({ subscriber: account.address, url: 'https://hooks.example.com/v2', issued: NOW + 60 });
    expect(parseWebhooksFile(raw)[account.address.toLowerCase()]!.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('answers 400 for bad input and 401 for a wrong signer, and writes nothing', async () => {
    const file = path.join(dir, 'w2.json');
    expect(await registerWebhook(null, { file, now: NOW })).toMatchObject({ ok: false, status: 400 });
    expect(await registerWebhook({ ...(await signed()), url: 'https://127.0.0.1/' }, { file, now: NOW, localHttp: false })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await registerWebhook(await signed({ by: other }), { file, now: NOW, localHttp: false })).toMatchObject({ ok: false, status: 401 });
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('keeps the newest entries when the file is full', () => {
    const e = (n: number) => ({ subscriber: `0x${n.toString(16).padStart(40, '0')}`, url: URL_OK, issued: NOW + n, signature: `0x${'1'.repeat(130)}` });
    let all = {};
    for (let n = 1; n <= 5; n++) all = withWebhook(all, e(n), 3);
    expect(
      Object.values(all)
        .map((x) => (x as { issued: number }).issued)
        .sort(),
    ).toEqual([NOW + 3, NOW + 4, NOW + 5]);
  });
});
