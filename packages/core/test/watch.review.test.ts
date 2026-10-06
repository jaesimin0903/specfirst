import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { getAddress, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireIssuerLock,
  AttestationError,
  attestClassOf,
  batchedLogsReader,
  CHAIN_SUBJECT,
  checkReportHash,
  liveWatchEffects,
  LogsNodeBehindError,
  seedKnownVaults,
  sourcesFromFile,
  watchFuzzSeedOf,
  WatchStore,
  type ActiveSubscription,
  type RunStandardCheckInput,
  type StandardCheckReport,
} from '../src/index.js';
import {
  addr,
  cleanupHarnesses,
  depositLog,
  ERC4626,
  EVK_FACTORY,
  factoryLog,
  harness,
  hash,
  kinds,
  reportOf,
  setImplementationLog,
  SIGNALS,
  T0,
  upgradedLog,
  V2_FACTORY,
  type Harness,
} from './helpers/watchHarness.js';

afterEach(cleanupHarnesses);

const V = addr(0x7a01);
const W = addr(0x7a02);
const X = addr(0x7a03);
const Y = addr(0x7a04);
const later = (h: Harness, ms: number) => {
  h.clock.now = new Date(h.clock.now.getTime() + ms);
};
const sub = (id: bigint, subject: Address, startsAt = 0n): ActiveSubscription => ({ id, subscriber: addr(0x5b), subjectChainId: 143n, subject, standardId: ERC4626, startsAt, endsAt: 10n ** 12n });
const statusOf = async (h: Harness) => JSON.parse(await readFile(path.join(h.dir, '.specfirst/watch/143/status.json'), 'utf8')) as { attestBudget: Record<string, unknown> };
/** A vault the watcher knew before it started (certs/checks), checked at block 100. */
const seeded = (h: Harness, subject: Address, o: { beacon?: Address; attestationId?: string } = {}) => {
  const lower = subject.toLowerCase();
  h.store.vaults.vaults[lower] = {
    firstSeen: { source: 'backfill', block: '100', at: '2026-10-01T00:00:00.000Z' },
    deployBlock: null,
    lastCheck: { block: '100', at: '2026-10-01T00:00:00.000Z', reportPath: 'certs/checks/x.json', summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [], implementationKey: reportOf(subject, 1n).identity.implementationKey as Hex },
    lastAttestationId: o.attestationId ?? null,
    firstDepositBlock: null,
  };
  if (o.beacon) h.store.state.beacons[lower] = o.beacon.toLowerCase();
};

describe('the reviewer repros, as regressions', { timeout: 60_000 }, () => {
  it('R1 (H2): fifty Upgraded of one rejected emitter cost one probe; the next fifty, nothing but a fingerprint', async () => {
    const h = await harness();
    h.chain.notVaults.add(X.toLowerCase());
    let probes = 0;
    const precheck = h.effects.precheck;
    h.effects.precheck = async (s, b) => {
      probes++;
      return precheck(s, b);
    };
    for (let i = 0; i < 50; i++) h.chain.logs.push({ ...upgradedLog(X, 1995n), logIndex: i });
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass();
    expect(probes).toBe(1);
    expect(kinds(await h.feed())).toEqual(['detected:upgrade', 'probe-rejected:upgrade']);
    for (let i = 0; i < 50; i++) h.chain.logs.push({ ...upgradedLog(X, 2005n), logIndex: i });
    h.chain.head = 2020n;
    await w.pass();
    expect(probes).toBe(1);
    expect(await h.feed()).toHaveLength(2);
    // One read at the rejection, one for the second flood: the code did not change, so no probe.
    expect(h.chain.fingerprintReads).toBe(2);
  });

  it('R2 (H1, M3): a vault that flips its result and logs Upgraded is not re-checked without a real change; with real changes every time, nothing is confirmed and nothing attested', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass({ drain: true });
    let block = 2010n;
    const flip = async (i: number, realUpgrade: boolean) => {
      h.chain.failing.set(V.toLowerCase(), i % 2 === 0 ? ['deposit'] : []);
      if (realUpgrade) h.chain.fingerprints.set(V.toLowerCase(), hash(0x100 + i));
      block += 20n;
      h.chain.logs.push(upgradedLog(V, block - 15n));
      h.chain.head = block;
      later(h, 120_000);
      await w.pass({ drain: true });
    };
    for (let i = 0; i < 45; i++) await flip(i, false);
    expect(h.checks).toHaveLength(1);
    for (let i = 0; i < 20; i++) await flip(i, true);
    const feed = await h.feed();
    expect(h.checks.length).toBeGreaterThan(10);
    expect(feed.filter((e) => e.kind === 'attested')).toHaveLength(1);
    expect(feed.filter((e) => e.kind === 'changed')).toHaveLength(1);
    expect(h.store.state.attestDay.used).toBe(1);
    expect(feed.filter((e) => e.kind === 'checked').slice(1).every((e) => /^pending confirmation|the change pending since block \d+ was not confirmed/.test(e.reason!))).toBe(true);
  });

  it('R3 (H3): a send that keeps failing without a revert waits longer each time and writes one error line an hour', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    let sends = 0;
    h.effects.attest = async () => {
      sends++;
      throw Object.assign(new Error('attest failed: The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.'), { name: 'RegistryError' });
    };
    const w = h.watcher();
    await w.pass({ drain: true });
    for (let i = 0; i < 20; i++) {
      later(h, 15_000);
      await w.pass();
    }
    const feed = await h.feed();
    // Tried at once, then after one and two more minutes (the next try would be four minutes later).
    expect(sends).toBe(3);
    expect(feed.filter((e) => e.kind === 'error')).toHaveLength(1);
    expect(h.store.state.deferred[V.toLowerCase()]).toMatchObject({ failures: 3, notBefore: '2026-10-06T12:07:00.000Z' });
  });

  it('R4 (H3): a receipt lost while the transaction is still pending is not sent again; the registry decides once it lands', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const real = h.effects.attest!;
    let pending: Parameters<typeof real>[0] | null = null;
    let calls = 0;
    h.effects.attest = async (p) => {
      calls++;
      if (calls === 1) {
        pending = p;
        throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
      }
      return real(p);
    };
    const w = h.watcher();
    await w.pass({ drain: true });
    await w.pass();
    expect(calls).toBe(1);
    await real(pending!);
    later(h, 60_000);
    await w.pass();
    expect(calls).toBe(1);
    expect(h.registry.list.filter((x) => x.subject === V)).toHaveLength(1);
    expect(h.store.state.deferred).toEqual({});
  });

  it('R5 (L2): rejections older than the retry window are pruned', async () => {
    const h = await harness();
    for (let i = 0; i < 30; i++) {
      const a = addr(0x9000 + i);
      h.chain.notVaults.add(a.toLowerCase());
      h.chain.logs.push({ ...depositLog(a, 1995n), logIndex: i });
    }
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass();
    await w.pass();
    expect(Object.keys(h.store.state.rejected)).toHaveLength(30);
    later(h, 10 * 86_400_000);
    h.chain.head = 2100n;
    await w.pass();
    expect(Object.keys(h.store.state.rejected)).toHaveLength(0);
  });
});

describe('H1: what is attested, and how much', { timeout: 60_000 }, () => {
  it('the policy classes', () => {
    const none = { subscribed: false, firstSinceSubscription: false, confirmedChange: false, factoryVault: false, firstCheck: false, firstDeposit: false, hasFail: false, hasValidAttestation: false };
    expect(attestClassOf({ ...none, subscribed: true, firstSinceSubscription: true })).toEqual({ cls: 'subscribed', why: 'first check since a subscription started' });
    expect(attestClassOf({ ...none, subscribed: true, confirmedChange: true })).toMatchObject({ cls: 'subscribed' });
    expect(attestClassOf({ ...none, subscribed: true })).toMatchObject({ cls: null, why: 'an unchanged re-check is not attested' });
    expect(attestClassOf({ ...none, factoryVault: true, firstCheck: true })).toMatchObject({ cls: 'factory' });
    expect(attestClassOf({ ...none, factoryVault: true, firstDeposit: true })).toEqual({ cls: 'factory', why: 'first-deposit re-check of a vault a factory announced' });
    expect(attestClassOf({ ...none, firstDeposit: true })).toEqual({ cls: null, why: 'the first-deposit re-check of a vault no factory announced is not attested' });
    expect(attestClassOf({ ...none, firstCheck: true })).toEqual({ cls: null, why: 'an unsolicited candidate that passes is not attested' });
    expect(attestClassOf({ ...none, firstCheck: true, hasFail: true })).toMatchObject({ cls: 'fail' });
    expect(attestClassOf({ ...none, confirmedChange: true, hasValidAttestation: true })).toMatchObject({ cls: 'attested-change' });
    expect(attestClassOf({ ...none, confirmedChange: true })).toMatchObject({ cls: null });
  });

  it('an unsolicited Deposit candidate that passes is recorded, not attested; one whose failure is confirmed is (fail); a seeded first-deposit re-check is not', async () => {
    const h = await harness();
    seeded(h, X);
    h.chain.failing.set(Y.toLowerCase(), ['previewDeposit']);
    h.chain.logs.push(depositLog(W, 1995n, 0), depositLog(Y, 1995n, 1), depositLog(X, 1996n, 2));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass({ drain: true });
    const reasons = Object.fromEntries((await h.feed()).filter((e) => e.kind === 'checked').map((e) => [e.subject, e.reason]));
    expect(reasons[W]).toBe('not attested [policy]: an unsolicited candidate that passes is not attested');
    expect(reasons[Y]).toBe('pending confirmation [confirm]: a failed property in a first check; nothing follows until a second check at a later block agrees');
    expect(reasons[X]).toBe('not attested [policy]: the first-deposit re-check of a vault no factory announced is not attested');
    expect(h.registry.list).toHaveLength(0);
    later(h, 120_000);
    h.chain.head = 2100n;
    await w.pass({ drain: true });
    const confirmed = (await h.feed()).filter((e) => e.subject === Y).slice(-3);
    expect(kinds(confirmed)).toEqual(['checked:deposit', 'attested:deposit', 'changed:deposit']);
    expect(confirmed[0]!.reason).toBe('confirmed by a second check at block 2090 after block 2000; attesting [fail]: a property fails, confirmed by a second check; no attestation of the subject yet');
    expect(confirmed[1]!.reason).toBe('[fail]');
    expect(h.registry.list.map((a) => a.subject)).toEqual([Y]);
  });

  it('budgets: per subject per day, the unsolicited budget below the total, subscribed attestations beyond the unsolicited one', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n, 0), factoryLog(W, 1995n, 1), factoryLog(X, 1995n, 2));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ maxUnsolicitedPerDay: 1, maxAttestPerSubjectPerDay: 1 }, { subscriptions: { active: async () => [sub(1n, X)] } });
    await w.pass({ drain: true });
    const reasons = Object.fromEntries((await h.feed()).filter((e) => e.kind === 'checked').map((e) => [e.subject, e.reason]));
    // X is subscribed: checked first and attested as subscribed; V takes the one unsolicited attestation; W waits.
    expect(reasons[X]).toBe('attesting [subscribed]: first check since a subscription started; no attestation of the subject yet');
    expect(reasons[V]).toBe('attesting [factory]: first check of a vault a factory announced; no attestation of the subject yet');
    expect(reasons[W]).toBe('attestation deferred [factory]: 1 of 1 unsolicited attestations made today; no attestation of the subject yet');
    expect((await statusOf(h)).attestBudget).toMatchObject({ perDay: 15, usedToday: 2, unsolicitedPerDay: 1, unsolicitedUsedToday: 1, perSubjectPerDay: 1 });

    // V regresses (a real upgrade), confirmed: its own cap of one a day holds it until tomorrow.
    h.chain.failing.set(V.toLowerCase(), ['deposit']);
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(V, 2005n));
    h.chain.head = 2020n;
    await w.pass({ drain: true });
    later(h, 120_000);
    h.chain.head = 2100n;
    await w.pass({ drain: true });
    const last = (await h.feed()).filter((e) => e.subject === V && e.kind === 'checked').at(-1)!;
    expect(last.reason).toMatch(/attestation deferred \[fail\]: 1 of 1 attestations of this subject made today; /);
    expect(h.store.state.deferred[V.toLowerCase()]).toMatchObject({ cls: 'fail', notBefore: '2026-10-07T00:00:00.000Z' });
    expect(h.registry.list).toHaveLength(2);
    h.clock.now = new Date('2026-10-07T00:00:05.000Z');
    await w.pass();
    expect(h.registry.list.map((a) => a.subject)).toEqual([X, V, W]);
  });

  it('the balance floor: nothing is sent below it, status.json says why, and deferred attestations go once the issuer is funded', async () => {
    const h = await harness();
    h.chain.balance = 100_000_000_000_000_000n;
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass({ drain: true });
    const checked = (await h.feed()).find((e) => e.kind === 'checked')!;
    expect(checked.reason).toBe('attestation deferred [factory]: issuer balance 0.1 MON is below the floor of 0.3 MON: nothing is sent; no attestation of the subject yet');
    expect((await statusOf(h)).attestBudget).toMatchObject({ balanceWei: '100000000000000000', minBalanceWei: '300000000000000000', paused: 'issuer balance 0.1 MON is below the floor of 0.3 MON: nothing is sent' });
    later(h, 30 * 60_000);
    await w.pass();
    expect(h.registry.list).toHaveLength(0);
    h.chain.balance = 2n * 10n ** 18n;
    later(h, 31 * 60_000);
    await w.pass();
    expect(h.registry.list.map((a) => a.subject)).toEqual([V]);
    expect((await statusOf(h)).attestBudget).toMatchObject({ balanceWei: '2000000000000000000', paused: null });
  });

  it('SetImplementation of the EVK factory queues its vaults subscribed first, then attested ones, then the rest', async () => {
    const h = await harness();
    const [A, B, C] = [addr(0xa1), addr(0xb1), addr(0xc1)];
    seeded(h, C, { beacon: EVK_FACTORY });
    seeded(h, B, { beacon: EVK_FACTORY, attestationId: '5' });
    seeded(h, A, { beacon: EVK_FACTORY });
    h.chain.logs.push(setImplementationLog(1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    await h.watcher({}, { subscriptions: { active: async () => [sub(1n, A)] } }).pass();
    expect((await h.feed()).filter((e) => e.kind === 'queued' && e.source === 'implementation').map((e) => e.subject)).toEqual([A, B, C]);
    expect(h.checks.map((c) => c.subject)).toEqual([A]);
  });
});

describe('H2: floods', { timeout: 60_000 }, () => {
  it('probes are capped per pass and the rest carried to the next; each topic is read on its own; the files are written once per pass', async () => {
    const h = await harness();
    for (let i = 0; i < 25; i++) {
      const a = addr(0x8000 + i);
      h.chain.notVaults.add(a.toLowerCase());
      h.chain.logs.push({ ...depositLog(a, 1995n), logIndex: i });
    }
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    let probes = 0;
    const precheck = h.effects.precheck;
    h.effects.precheck = async (s, b) => {
      probes++;
      return precheck(s, b);
    };
    let saves = 0;
    const save = h.store.save.bind(h.store);
    h.store.save = async (status) => {
      saves++;
      return save(status);
    };
    const w = h.watcher();
    await w.pass();
    // Twenty probes, the cap; the other five candidates wait in `probing` for the next pass.
    expect(probes).toBe(20);
    expect(Object.keys(h.store.state.probing)).toHaveLength(5);
    expect(saves).toBeLessThanOrEqual(3);
    expect(h.chain.getLogsTopics.every((t) => t.length === 1)).toBe(true);
    expect(new Set(h.chain.getLogsTopics.map((t) => t[0])).size).toBe(9);
    await w.pass();
    expect(probes).toBe(25);
    expect(h.store.state.probing).toEqual({});
    expect((await h.feed()).filter((e) => e.kind === 'probe-rejected')).toHaveLength(25);
  });

  it('a block the node refuses even alone is passed over with an error line, the cursor moves on and other topics of that block are read', async () => {
    const h = await harness();
    const depositTopic = depositLog(V, 1n).topics[0]!;
    const getLogs = h.effects.getLogs;
    h.effects.getLogs = async (from, to, topics) => {
      if (topics[0] === depositTopic && from <= 1995n && to >= 1995n) throw Object.assign(new Error('query returned more than 10000 results'), { code: -32005 });
      return getLogs(from, to, topics);
    };
    h.chain.logs.push(depositLog(W, 1995n, 0), factoryLog(V, 1995n, 1));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const r = await h.watcher().pass();
    expect(r.cursor).toBe(2001n);
    const feed = await h.feed();
    const unreadable = feed.find((e) => e.kind === 'error')!;
    expect(unreadable).toMatchObject({ subject: CHAIN_SUBJECT, block: '1995' });
    expect(unreadable.reason).toMatch(/^block 1995: the node refuses getLogs of ERC-4626 Deposit even for one block, passed over/);
    expect(feed.some((e) => e.kind === 'detected' && e.subject === V)).toBe(true);
    expect(feed.some((e) => e.subject === W)).toBe(false);
  });
});

describe('M3 to M6, L1 to L8', { timeout: 60_000 }, () => {
  it('M3: the live check gets a seed of its own subject and keeps that subject\'s forge failures', async () => {
    const seen: RunStandardCheckInput[] = [];
    const effects = liveWatchEffects({
      subjectClient: {} as never,
      subjectChainId: 143,
      subjectRpcUrl: 'http://127.0.0.1:1',
      projectDir: '/tmp/project',
      runs: 4,
      reportBaseUrl: 'https://example.org/checks',
      registry: null,
      attest: false,
      runCheck: async (input) => {
        seen.push(input);
        return reportOf(input.address, input.blockNumber!);
      },
    });
    await effects.runCheck(V, 10n);
    await effects.runCheck(V, 20n);
    await effects.runCheck(W, 20n);
    expect(seen.map((s) => s.seed)).toEqual([watchFuzzSeedOf(V), watchFuzzSeedOf(V), watchFuzzSeedOf(W)]);
    expect(watchFuzzSeedOf(V)).not.toBe(watchFuzzSeedOf(W));
    expect(seen[0]!.failurePersistDir).toBe(`/tmp/project/.specfirst/watch/143/forge-failures/${V.toLowerCase()}`);
    expect(seen[0]!.timeoutSec).toBe(600);
  });

  it('M5: a timeout cools the vault down for every signal, the subscribed cadence and the sweep, doubling; a check that completes ends it', async () => {
    const h = await harness();
    h.chain.timeouts.add(V.toLowerCase());
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const subs = [sub(1n, V)];
    const w = h.watcher({ subscribedMinutes: 1, sweepPerHour: 6, sweepHours: 1 }, { subscriptions: { active: async () => subs } });
    await w.pass({ drain: true });
    expect(h.store.state.cooldowns[V.toLowerCase()]).toEqual({ until: '2026-10-06T13:00:00.000Z', timeouts: 1 });
    // A real upgrade, the subscribed cadence and the sweep within the hour: nothing is queued.
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(V, 2005n));
    h.chain.head = 2020n;
    later(h, 30 * 60_000);
    await w.pass({ drain: true });
    expect(h.store.state.queue).toEqual([]);
    expect((await h.feed()).filter((e) => e.kind === 'error')).toHaveLength(1);
    // After the hour the subscribed cadence queues it; it times out again: two hours now.
    later(h, 31 * 60_000);
    await w.pass({ drain: true });
    expect(h.store.state.cooldowns[V.toLowerCase()]).toEqual({ until: '2026-10-06T15:01:00.000Z', timeouts: 2 });
    h.chain.timeouts.delete(V.toLowerCase());
    later(h, 2 * 3_600_000);
    await w.pass({ drain: true });
    expect(h.store.state.cooldowns).toEqual({});
    expect(h.checks.map((c) => c.subject)).toEqual([V]);
  });

  it('M6: a subscription read that hangs never holds a pass after the first, which waits only its time box', async () => {
    const h = await harness();
    h.store.state.cursor = '1991';
    let calls = 0;
    const source = {
      active: (): Promise<ActiveSubscription[]> => {
        calls++;
        return calls === 1 ? Promise.resolve([sub(1n, V)]) : new Promise(() => {});
      },
    };
    seeded(h, V);
    const w = h.watcher({ subscriptionTimeoutMs: 5_000, subscriptionRefreshMs: 0, subscribedMinutes: 1 }, { subscriptions: source });
    await w.pass();
    expect(h.checks.map((c) => c.subject)).toEqual([V]);
    later(h, 2 * 60_000);
    const started = Date.now();
    await w.pass();
    // The hanging second read is not waited for (its time box is five seconds): the last result is used.
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(calls).toBe(2);
    expect(h.checks.map((c) => c.subject)).toEqual([V, V]);

    // Without any result yet, the first pass waits for the read, but only its time box.
    const fresh = await harness();
    fresh.store.state.cursor = '1991';
    const hanging = fresh.watcher({ subscriptionTimeoutMs: 100 }, { subscriptions: { active: () => new Promise(() => {}) } });
    const t = Date.now();
    const r = await hanging.pass();
    expect(Date.now() - t).toBeGreaterThanOrEqual(90);
    expect(r.failed).toEqual([]);
    expect(fresh.events.some((e) => e.type === 'watch-error' && e.step === 'subscriptions' && /not read within 100 ms/.test(e.error))).toBe(true);
  });

  it('L1: a newer report found in certs/checks at start goes through the change decision, the confirmation and the policy', async () => {
    const h = await harness();
    const write = async (r: StandardCheckReport) => {
      const rel = `certs/checks/143/${r.address.toLowerCase()}/${r.blockNumber}-${checkReportHash(r).slice(2, 18)}.json`;
      await mkdir(path.dirname(path.join(h.dir, rel)), { recursive: true });
      await writeFile(path.join(h.dir, rel), JSON.stringify(r));
      return rel;
    };
    await write(reportOf(V, 100n, { startedAt: '2026-10-01T00:00:00.000Z' }));
    expect(await seedKnownVaults(h.dir, h.store)).toMatchObject({ added: 1, adopt: [] });
    const desk = await write(reportOf(V, 1500n, { fail: ['previewDeposit'], startedAt: '2026-10-06T11:00:00.000Z' }));
    const seededAgain = await seedKnownVaults(h.dir, h.store);
    expect(seededAgain.adopt).toEqual([{ subject: V.toLowerCase(), reportPath: desk }]);
    h.store.state.cursor = '1991';
    h.chain.failing.set(V.toLowerCase(), ['previewDeposit']);
    const w = h.watcher({}, undefined, undefined, { adopt: seededAgain.adopt });
    await w.pass();
    const first = await h.feed();
    expect(kinds(first)).toEqual(['checked:backfill', 'queued:backfill']);
    expect(first[0]!.reason).toBe(
      'adopted from certs/checks (a check made outside the watcher); pending confirmation [confirm]: regressed against the last check; nothing follows until a second check at a later block agrees',
    );
    later(h, 120_000);
    await w.pass();
    const after = (await h.feed()).slice(2);
    expect(kinds(after)).toEqual(['checked:backfill', 'attested:backfill', 'changed:backfill']);
    expect(after[0]!.reason).toMatch(/^confirmed by a second check at block 1990 after block 1500; attesting \[fail\]/);
  });

  it('L3: start-up repair cuts a partial last feed line and removes temp files, only for the lock holder', async () => {
    const h = await harness();
    const dir = path.join(h.dir, '.specfirst/watch/143');
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ v: 1, seq: 1, at: T0.toISOString(), kind: 'detected', chainId: 143, subject: V });
    await writeFile(path.join(dir, 'feed.ndjson'), `${line}\n{"v":1,"seq":2,"at"`);
    await writeFile(path.join(dir, '.state.json.tmp-123-abcdef01'), '{');
    await WatchStore.load(h.dir, 143);
    expect(await readFile(path.join(dir, 'feed.ndjson'), 'utf8')).toBe(`${line}\n{"v":1,"seq":2,"at"`);
    const store = await WatchStore.load(h.dir, 143, { repair: true });
    expect(await readFile(path.join(dir, 'feed.ndjson'), 'utf8')).toBe(`${line}\n`);
    expect(store.state.seq).toBe(1);
    await expect(readFile(path.join(dir, '.state.json.tmp-123-abcdef01'), 'utf8')).rejects.toThrow();
  });

  it('L5: a sources file whose factory event does not decode its fixture log is refused; undecodable factory events are error lines, at most hourly', async () => {
    const f = SIGNALS.factories.find((x) => x.source === 'Morpho VaultV2Factory')!;
    const file = (vault: string) => ({
      v: 1,
      chainId: 143,
      sources: [{ name: 'V2', signal: 'factory', address: V2_FACTORY, event: 'event CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)', vault: 'newVaultV2' }],
      fixtures: [{ source: 'V2', block: f.block, vault, log: { topics: f.log.topics, data: f.log.data } }],
    });
    expect(sourcesFromFile(file(f.vault), 143).fixtures[0]!.vault).toBe(getAddress(f.vault.toLowerCase()));
    expect(() => sourcesFromFile(file(addr(1)), 143)).toThrow(/source "V2" does not decode its fixture at block \d+: expected 0x0+1, got 0x/);
    // The same file with the vault argument pointing at the owner decodes the wrong address: refused.
    const wrongArg = file(f.vault);
    wrongArg.sources[0]!.vault = 'owner';
    expect(() => sourcesFromFile(wrongArg, 143)).toThrow(/does not decode its fixture/);

    const h = await harness();
    const bad = factoryLog(V, 1995n);
    h.chain.logs.push({ ...bad, topics: bad.topics.slice(0, 2) }, { ...bad, topics: bad.topics.slice(0, 2), logIndex: 1, blockNumber: 1996n });
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass();
    h.chain.logs.push({ ...bad, topics: bad.topics.slice(0, 2), blockNumber: 2005n });
    h.chain.head = 2020n;
    later(h, 10 * 60_000);
    await w.pass();
    const errors = (await h.feed()).filter((e) => e.kind === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ subject: V2_FACTORY, block: '1995' });
    expect(errors[0]!.reason).toBe('a CreateVaultV2 event of Morpho VaultV2Factory does not decode to a vault address (newVaultV2); passed over');
  });

  it('L6: pass() never throws: an unexpected failure is recorded and the caller is asked to back off', async () => {
    const h = await harness();
    h.store.state.cursor = '1991';
    const save = h.store.save.bind(h.store);
    let fail = true;
    h.store.save = async (status) => {
      if (fail) {
        fail = false;
        throw new Error('EIO: the disk is gone');
      }
      return save(status);
    };
    const r = await h.watcher().pass();
    expect(r).toMatchObject({ idle: true, failed: ['pass'], checked: 0 });
    expect(h.events.some((e) => e.type === 'watch-error' && e.step === 'pass' && e.error === 'EIO: the disk is gone')).toBe(true);
    const feed = await h.feed();
    expect(feed).toEqual([expect.objectContaining({ kind: 'error', subject: CHAIN_SUBJECT, reason: 'pass failed, backing off: EIO: the disk is gone' })]);
  });

  it('L7: a getLogs node behind the head node caps the range at its own head', async () => {
    const h = await harness();
    h.chain.logsHead = 1995n;
    h.chain.logs.push(factoryLog(V, 1994n), factoryLog(W, 1999n, 1));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    const r = await w.pass();
    expect(r.cursor).toBe(1996n);
    expect((await h.feed()).filter((e) => e.kind === 'detected').map((e) => e.subject)).toEqual([V]);
    h.chain.logsHead = null;
    expect((await w.pass()).cursor).toBe(2001n);
    expect((await h.feed()).filter((e) => e.kind === 'detected').map((e) => e.subject)).toEqual([V, W]);
  });

  it('L7: batchedLogsReader asks the head and the logs of one node in one request', async () => {
    const bodies: unknown[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const batch = JSON.parse(body) as Array<{ id: number; method: string }>;
        bodies.push(batch);
        const answer = batch.map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.method === 'eth_blockNumber' ? '0x10' : [] }));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const read = batchedLogsReader([`http://127.0.0.1:${(server.address() as AddressInfo).port}`], { rps: 1000 });
      expect(await read(1n, 16n, [hash(1)])).toEqual([]);
      await expect(read(1n, 32n, [hash(1)])).rejects.toBeInstanceOf(LogsNodeBehindError);
      await expect(read(1n, 32n, [hash(1)])).rejects.toMatchObject({ head: 16n });
      expect(bodies.every((b) => Array.isArray(b) && b.map((x: { method: string }) => x.method).sort().join() === 'eth_blockNumber,eth_getLogs')).toBe(true);
    } finally {
      server.close();
    }
  });

  it('L8: a report the identity check refuses is not the last check, emits no change, and the vault is checked again', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const verify = h.effects.verifySubject;
    h.effects.verifySubject = async () => {
      throw new AttestationError('code at 0x... hashes to 0xaa, the report says 0xbb');
    };
    const w = h.watcher();
    await w.pass({ drain: true });
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'error:factory']);
    expect(feed[3]!.reason).toMatch(/^check failed \(attempt 1 of 3\), retrying from \S+: identity check refused the report: code at /);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck).toBeNull();
    expect(h.store.state.queue).toEqual([expect.objectContaining({ subject: V, attempts: 1 })]);
    h.effects.verifySubject = verify;
    later(h, 60_000);
    await w.pass();
    expect(kinds((await h.feed()).slice(4))).toEqual(['checked:factory', 'attested:factory', 'changed:factory']);
  });

  it('M4: one watcher per issuer key for the user, whatever its project', async () => {
    const h = await harness();
    const lockDirPath = path.join(h.dir, 'locks');
    const release = await acquireIssuerLock(V, { dir: lockDirPath, pid: 111, isAlive: () => true });
    await expect(acquireIssuerLock(V.toLowerCase(), { dir: lockDirPath, pid: 222, isAlive: (p) => p === 111 })).rejects.toThrow(new RegExp(`another watcher signing as ${V} \\(pid 111\\) is running`));
    const other = await acquireIssuerLock(W, { dir: lockDirPath, pid: 222, isAlive: () => true });
    await other();
    await release();
    const again = await acquireIssuerLock(V, { dir: lockDirPath, pid: 222, isAlive: () => true });
    await again();
  });
});
