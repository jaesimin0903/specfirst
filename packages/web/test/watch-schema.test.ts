import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { feedEventSchema, feedKindSchema, feedSourceSchema, watchStatusSchema, watchVaultsSchema, type FeedEvent } from '../lib/watch/core';
import { parseFeedText, parseWatchStatus, parseWatchVaults } from '../lib/watch/read';

/*
 * lib/watch/core.ts re-exports @specfirst/core/watch. These pin the shapes ADR 0006 fixes, as the web reads them,
 * on the synthetic fixtures under test/fixtures/watch.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(here, 'fixtures/watch/143');
const feedText = readFileSync(path.join(DIR, 'feed.ndjson'), 'utf8');
const status = JSON.parse(readFileSync(path.join(DIR, 'status.json'), 'utf8'));
const vaults = JSON.parse(readFileSync(path.join(DIR, 'vaults.json'), 'utf8'));

const base: FeedEvent = { v: 1, seq: 7, at: '2026-10-06T09:00:00.000Z', kind: 'detected', chainId: 143, subject: '0xFEeD000000000000000000000000000000000001' };

describe('feed.ndjson events', () => {
  const { events, skipped } = parseFeedText(feedText);

  it('the fixture parses: every line but the two bad ones, every kind and the sources ADR 0006 lists', () => {
    expect(skipped).toBe(2);
    expect(events).toHaveLength(33);
    expect(new Set(events.map((e) => e.kind))).toEqual(new Set(feedKindSchema.options));
    expect(feedKindSchema.options).toEqual(['detected', 'probe-rejected', 'queued', 'checked', 'attested', 'changed', 'alerted', 'error']);
    expect(feedSourceSchema.options).toEqual([
      'factory',
      'deposit',
      'upgrade',
      'beacon-upgrade',
      'implementation',
      'first-deposit',
      'sweep',
      'subscribed',
      'backfill',
      'price-drop',
    ]);
    expect(events.map((e) => e.seq)).toEqual([...events.keys()].map((i) => i + 1));
  });

  it('keeps the nested shapes: check, attestation, change and alert', () => {
    const checked = events.find((e) => e.kind === 'checked')!;
    expect(Object.keys(checked.check!).sort()).toEqual(['block', 'durationMs', 'failed', 'implementationKey', 'reportHash', 'reportPath', 'summary']);
    const attested = events.find((e) => e.kind === 'attested' && e.attestation?.supersedes)!;
    expect(attested.attestation).toEqual({
      id: expect.stringMatching(/^\d+$/),
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      supersedes: expect.stringMatching(/^\d+$/),
    });
    const fresh = events.find((e) => e.change?.kind === 'new')!;
    expect(fresh.change).toMatchObject({ kind: 'new', from: null });
    const failedDelivery = events.find((e) => e.alert && !e.alert.ok)!;
    expect(failedDelivery.alert).toMatchObject({ channel: 'webhook', ok: false, status: 500 });
  });

  it('accepts the minimal line and rejects lines that break the ADR shape', () => {
    expect(feedEventSchema.safeParse(base).success).toBe(true);
    const bad: Array<[string, unknown]> = [
      ['v 2', { ...base, v: 2 }],
      ['seq as a string', { ...base, seq: '7' }],
      ['seq 0 (seq counts from 1)', { ...base, seq: 0 }],
      ['lowercase address, not checksummed', { ...base, subject: base.subject.toLowerCase() }],
      ['block with a leading zero', { ...base, block: '0110977300' }],
      ['an extra field', { ...base, note: 'hi' }],
      ['unknown kind', { ...base, kind: 'teleported' }],
      ['short address', { ...base, subject: '0xfeed' }],
      ['unknown source', { ...base, source: 'rumor' }],
      ['block as a number', { ...base, block: 110977300 }],
      ['time without zone', { ...base, at: '2026-10-06 09:00' }],
      ['change kind', { ...base, change: { kind: 'worse', from: null, to: { summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [] } } }],
      ['price-drop with a check change shape', { ...base, change: { kind: 'price-drop', from: null, to: { summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [] } } }],
      ['price-drop without its blocks', { ...base, change: { kind: 'price-drop', fromAssetsPerShare: '2', toAssetsPerShare: '1', dropBps: 5000 } }],
      ['alert channel', { ...base, alert: { subscriptionId: '1', subscriber: base.subject, channel: 'sms', ok: true } }],
      [
        'report hash length',
        {
          ...base,
          check: {
            block: '1',
            summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 },
            failed: [],
            implementationKey: null,
            reportPath: 'x.json',
            reportHash: '0x12',
            durationMs: 1,
          },
        },
      ],
    ];
    for (const [why, line] of bad) expect(feedEventSchema.safeParse(line).success, why).toBe(false);
  });

  it('a share value drop is a changed event whose change carries both values and both blocks', () => {
    const change = { kind: 'price-drop', fromAssetsPerShare: '1000000', toAssetsPerShare: '995800', dropBps: 42, fromBlock: '110977300', toBlock: '110977400' } as const;
    const line = { ...base, kind: 'changed', source: 'price-drop', block: '110977400', change };
    expect(feedEventSchema.parse(line).change).toEqual(change);
    expect(parseFeedText(`${JSON.stringify({ ...line, seq: 1 })}\n`)).toMatchObject({ events: [{ change }], skipped: 0 });
  });
});

describe('status.json', () => {
  it('the fixture matches; gasCostWei is optional in the strict schema, any other extra field is refused', () => {
    expect(watchStatusSchema.safeParse(status).success).toBe(true);
    const p = parseWatchStatus(status);
    expect(p.status?.running?.stage).toBe('checking');
    expect(p.gasCostWei).toBe(208000000000000000n);
    const { gasCostWei: _gas, ...withoutGas } = status;
    expect(parseWatchStatus(withoutGas)).toMatchObject({ gasCostWei: null, detail: null });
    expect(parseWatchStatus({ ...status, gasCostWei: '0x10' }).detail).toMatch(/^gasCostWei:/);
    expect(parseWatchStatus({ ...status, extra: 1 }).status).toBeNull();
    expect(parseWatchStatus({ ...status, running: { ...status.running, source: 'rumor' } }).detail).toMatch(/^running\.source:/);
  });

  it('names the first field that is off', () => {
    const p = parseWatchStatus({ ...status, running: { ...status.running, stage: 'napping' } });
    expect(p.status).toBeNull();
    expect(p.detail).toMatch(/^running\.stage:/);
    expect(parseWatchStatus({ ...status, queue: 'none' }).detail).toMatch(/^queue:/);
  });
});

describe('vaults.json', () => {
  it('the fixture matches; one bad entry is skipped and the rest kept', () => {
    expect(watchVaultsSchema.safeParse(vaults).success).toBe(true);
    const broken = {
      v: 1,
      vaults: {
        ...vaults.vaults,
        '0x0000000000000000000000000000000000000bad': { firstSeen: { source: 'rumor' } },
        NOTANADDRESS: vaults.vaults[Object.keys(vaults.vaults)[0]!],
      },
    };
    const p = parseWatchVaults(broken)!;
    expect(Object.keys(p.vaults)).toHaveLength(6);
    expect(p.skipped).toBe(2);
    expect(parseWatchVaults({ v: 2, vaults: {} })).toBeNull();
    expect(parseWatchVaults([])).toBeNull();
  });
});
