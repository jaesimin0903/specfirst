import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createPublicClient, getAddress, http, toHex, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireIssuerLock,
  AttestationError,
  AttestationRegistryClient,
  attestClassOf,
  batchedLogsReader,
  CHAIN_SUBJECT,
  checkReportHash,
  classifiedErrorText,
  liveWatchEffects,
  LogsNodeBehindError,
  parseCheckReport,
  precheckErc4626,
  seedKnownVaults,
  sourcesFromFile,
  summarize,
  watchFuzzSeedOf,
  WatchStore,
  type ActiveSubscription,
  type RunStandardCheckInput,
  type StandardCheckReport,
} from '../src/index.js';
import {
  addr,
  attestParams,
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
    h.effects.attest = {
      ...h.effects.attest!,
      send: async () => {
        sends++;
        throw Object.assign(new Error('attest failed: The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.'), { name: 'RegistryError' });
      },
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

  it('R4 (H3, M1): a receipt that does not come is not sent again; the transaction is looked up, and counted once it is mined', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    h.registry.hold = true;
    const w = h.watcher();
    await w.pass({ drain: true });
    const sent = h.registry.sends[0]!;
    expect(h.store.state.attesting[V.toLowerCase()]).toMatchObject({ hash: sent.hash, nonce: 0, cls: 'factory', block: '2000', replaced: [], bumps: 0 });
    let feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'error:factory', 'changed:factory']);
    expect(feed[3]!.reason).toMatch(new RegExp(`^attest tx ${sent.hash} was sent, its receipt is looked up in the next pass: Timed out`));
    await w.pass();
    later(h, 60_000);
    await w.pass();
    expect(h.registry.sends).toHaveLength(1);
    expect(h.store.state.attestDay.used).toBe(0);
    h.registry.mine(sent.hash);
    await w.pass();
    feed = await h.feed();
    expect(feed.at(-1)).toMatchObject({ kind: 'attested', subject: V, reason: '[factory]; its receipt was found in a later pass', attestation: { id: '0', txHash: sent.hash, supersedes: null } });
    expect(h.registry.sends).toHaveLength(1);
    expect(h.store.state.attesting).toEqual({});
    expect(h.store.state.attestDay).toMatchObject({ used: 1, unsolicited: 1 });
    expect(h.store.state.gasCostWei).toBe('1');
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
    // The next day V's confirmed fail goes before W's first check (deferred attestations by class): W waits a day more.
    h.clock.now = new Date('2026-10-07T00:00:05.000Z');
    await w.pass();
    expect(h.registry.list.map((a) => a.subject)).toEqual([X, V, V]);
    expect(h.store.state.deferred[W.toLowerCase()]).toMatchObject({ cls: 'factory', notBefore: '2026-10-08T00:00:00.000Z' });
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
    await effects.runCheck(W, 30n, { seed: 7n });
    expect(seen.map((s) => s.seed)).toEqual([watchFuzzSeedOf(V), watchFuzzSeedOf(V), watchFuzzSeedOf(W), 7n]);
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
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'error:factory']);
    expect(feed[2]!.reason).toMatch(/^check failed \(attempt 1 of 3\), retrying from \S+: identity check refused the report: code at /);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck).toBeNull();
    expect(h.store.state.queue).toEqual([expect.objectContaining({ subject: V, attempts: 1 })]);
    h.effects.verifySubject = verify;
    later(h, 60_000);
    await w.pass();
    expect(kinds((await h.feed()).slice(3))).toEqual(['checked:factory', 'attested:factory', 'changed:factory']);
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

describe('M1, M2 and L1 on the shared primitives', { timeout: 60_000 }, () => {
  /** A JSON-RPC stub: eth_call gets `call()` (an error or a result), eth_getCode some code, the rest a number. */
  const stubRpc = async (call: () => { error: { code: number; message: string; data?: Hex } } | { result: Hex }, run: (url: string) => Promise<void>) => {
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const { id, method } = JSON.parse(body) as { id: number; method: string };
        const answer = method === 'eth_call' ? call() : { result: method === 'eth_getCode' ? '0x6001' : '0x8f' };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...answer }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    } finally {
      server.close();
    }
  };
  const viemClient = (url: string) => createPublicClient({ transport: http(url, { retryCount: 0 }) });
  const nodeError = { error: { code: -32603, message: 'Error getting block by number' } };

  it('M2: a probe the node answers with -32603 "Error getting block by number" is probed again, not rejected, and the feed blames the node', async () => {
    let served = false;
    await stubRpc(
      () => (served ? { result: `0x${'0a55e7'.padStart(64, '0')}` } : nodeError),
      async (url) => {
        const h = await harness();
        const client = viemClient(url);
        h.effects.precheck = (subject, block) => precheckErc4626(client, subject, block);
        h.chain.logs.push(factoryLog(V, 1995n));
        h.store.state.cursor = '1991';
        h.chain.head = 2010n;
        const w = h.watcher();
        await w.pass();
        const feed = await h.feed();
        expect(kinds(feed)).toEqual(['detected:factory', 'error:factory']);
        expect(feed[1]!.reason).toBe('probe failed (attempt 1), not a verdict, probing again from 2026-10-06T12:05:00.000Z: RPC node error on asset(): Error getting block by number');
        expect(h.store.state.rejected).toEqual({});
        expect(h.store.state.probing[V.toLowerCase()]).toMatchObject({ failures: 1 });
        served = true;
        later(h, 5 * 60_000);
        await w.pass();
        expect(h.store.state.probing).toEqual({});
        expect(kinds((await h.feed()).slice(2, 4))).toEqual(['queued:factory', 'checked:factory']);
      },
    );
  });

  it('feed text names what failed first: a revert only when the contract answered, else the node, a rate limit or the transport', async () => {
    const textOf = async (answer: Parameters<typeof stubRpc>[0]) => {
      let text = '';
      await stubRpc(answer, async (url) => {
        text = classifiedErrorText(await precheckErc4626(viemClient(url), V, 7n).then(() => null, (e: unknown) => e));
      });
      return text;
    };
    // What errorText says for the first: "The contract function "asset" reverted with the following reason:".
    expect(await textOf(() => nodeError)).toBe('RPC node error on asset(): Error getting block by number');
    expect(await textOf(() => ({ error: { code: -32000, message: 'header not found' } }))).toBe('RPC node error on asset(): header not found');
    expect(await textOf(() => ({ error: { code: 429, message: 'Too many requests' } }))).toBe('rate limit on asset(): Too many requests');
    expect(classifiedErrorText(await precheckErc4626(viemClient('http://127.0.0.1:1'), V, 7n).then(() => null, (e: unknown) => e))).toBe('transport failure: fetch failed');
    // A revert, also one sent with -32603, is the contract's answer; precheck turns it into a reason, the text says revert.
    await stubRpc(
      () => ({ error: { code: -32603, message: 'execution reverted', data: '0x' } }),
      async (url) => {
        const err = await viemClient(url)
          .readContract({ address: V, abi: [{ type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'asset' })
          .then(() => null, (e: unknown) => e);
        expect(classifiedErrorText(err)).toMatch(/^revert on asset\(\): The contract function "asset" reverted/);
      },
    );
  });

  it('a node error under the attest simulation is tried again with a line that blames the node, not refused as a revert', async () => {
    await stubRpc(
      () => nodeError,
      async (url) => {
        const h = await harness();
        const viemRegistry = new AttestationRegistryClient(addr(0x7e9), viemClient(url) as never, { account: { address: addr(0x155) } } as never);
        h.registry.failNext = await viemRegistry.sendAttest(attestParams(V, 2000n)).then(() => null, (e: Error) => e);
        expect(h.registry.failNext!.message).toMatch(/^attest failed: The contract function "attest" reverted/);
        h.chain.logs.push(factoryLog(V, 1995n));
        h.store.state.cursor = '1991';
        h.chain.head = 2010n;
        const w = h.watcher();
        await w.pass({ drain: true });
        const feed = await h.feed();
        expect(feed.find((e) => e.kind === 'error')!.reason).toBe('attest failed, tried again from 2026-10-06T12:01:00.000Z: RPC node error on attest(): Error getting block by number');
        expect(h.store.state.deferred[V.toLowerCase()]).toMatchObject({ failures: 1 });
        later(h, 60_000);
        await w.pass();
        expect((await h.feed()).at(-1)).toMatchObject({ kind: 'attested', subject: V });
      },
    );
  });

  it('L1: an attestation mined although its receipt errored is found in the next pass and counted against the budgets and the gas', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    h.registry.loseReceipt = true;
    const w = h.watcher();
    await w.pass({ drain: true });
    expect(h.registry.list).toHaveLength(1);
    expect(h.store.state.attestDay.used).toBe(0);
    await w.pass();
    expect(h.registry.sends).toHaveLength(1);
    expect(h.store.state.attestDay).toMatchObject({ used: 1, unsolicited: 1 });
    expect(h.store.state.perSubject[V.toLowerCase()]).toMatchObject({ used: 1 });
    expect(h.store.state.gasCostWei).toBe('1');
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastAttestationId).toBe('0');
    expect((await h.feed()).filter((e) => e.kind === 'attested')).toHaveLength(1);
  });

  it('M1: a watcher stopped while it waited for the receipt finds the transaction in state.json at restart and sends nothing new', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    h.registry.hold = true;
    // The first watcher never gets its receipt: the process is gone while it waits.
    const attester = h.effects.attest!;
    let waiting!: () => void;
    const waited = new Promise<void>((r) => (waiting = r));
    h.effects.attest = {
      ...attester,
      wait: () => {
        waiting();
        return new Promise<never>(() => {});
      },
    };
    void h.watcher().pass({ drain: true });
    await waited;
    const sent = h.registry.sends[0]!;
    h.registry.mine(sent.hash);
    await h.reload();
    expect(h.store.state.attesting[V.toLowerCase()]).toMatchObject({ hash: sent.hash, nonce: 0 });
    h.effects.attest = attester;
    await h.watcher().pass({ drain: true });
    expect(h.registry.sends).toHaveLength(1);
    expect(h.registry.list).toHaveLength(1);
    const attested = (await h.feed()).filter((e) => e.kind === 'attested');
    expect(attested).toEqual([expect.objectContaining({ subject: V, attestation: { id: '0', txHash: sent.hash, supersedes: null } })]);
    expect(h.store.state.attesting).toEqual({});
  });

  it('M1: a dropped transaction is sent again with its nonce while that nonce is unused, with a new one once another transaction used it', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    h.registry.hold = true;
    const w = h.watcher();
    await w.pass({ drain: true });
    h.registry.drop(h.registry.sends[0]!.hash);
    await w.pass();
    expect(h.registry.sends.map((x) => x.nonce)).toEqual([0, 0]);
    expect(h.registry.list.map((a) => a.subject)).toEqual([V]);

    h.chain.logs.push(factoryLog(W, 2005n));
    h.chain.head = 2020n;
    h.registry.hold = true;
    await w.pass({ drain: true });
    expect(h.registry.sends[2]!.nonce).toBe(1);
    h.registry.drop(h.registry.sends[2]!.hash, true);
    await w.pass();
    expect(h.registry.sends.map((x) => x.nonce)).toEqual([0, 0, 1, 2]);
    expect(h.registry.list.map((a) => a.subject)).toEqual([V, W]);
    const attested = (await h.feed()).filter((e) => e.kind === 'attested');
    expect(attested.map((e) => e.attestation!.txHash)).toEqual([h.registry.sends[1]!.hash, h.registry.sends[3]!.hash]);
    expect(h.store.state.attestDay.used).toBe(2);
  });

  it('M1: nothing is sent while the issuer has pending transactions on the node or the watcher has one unresolved', async () => {
    const h = await harness();
    let pendingOnNode = true;
    h.effects.attest = { ...h.effects.attest!, hasPending: async () => pendingOnNode || h.registry.hasPending() };
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass({ drain: true });
    expect(h.registry.sends).toHaveLength(0);
    expect((await h.feed()).find((e) => e.kind === 'checked')!.reason).toMatch(/^attestation deferred \[factory\]: the issuer has transactions the node has not mined; /);
    pendingOnNode = false;
    later(h, 60_000);
    h.registry.hold = true;
    h.chain.logs.push(factoryLog(W, 2005n));
    h.chain.head = 2020n;
    await w.pass({ drain: true });
    // V's deferred attestation went out and waits for its receipt; W's waits behind it.
    expect(h.registry.sends).toHaveLength(1);
    const v = h.registry.sends[0]!;
    expect((await h.feed()).filter((e) => e.kind === 'checked' && e.subject === W)[0]!.reason).toMatch(
      new RegExp(`^attestation deferred \\[factory\\]: attest tx ${v.hash} sent earlier is not mined yet; `),
    );
    h.registry.mine(v.hash);
    later(h, 60_000);
    await w.pass();
    expect(h.registry.sends).toHaveLength(2);
    expect(h.registry.list.map((a) => a.subject)).toEqual([V, W]);
  });

  it('M1: a transaction that reverts when mined counts its gas and is decided again; a later attestation of another issuer supersedes it', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    h.registry.hold = true;
    const w = h.watcher({ errorEveryMs: 0 });
    await w.pass({ drain: true });
    const sent = h.registry.sends[0]!;
    h.registry.attest(attestParams(V, 2005n));
    h.registry.mine(sent.hash);
    await w.pass();
    expect(h.store.state.gasCostWei).toBe('1');
    expect(h.store.state.attestDay.used).toBe(0);
    expect((await h.feed()).at(-1)!.reason).toBe(`attest tx ${sent.hash} reverted (1 of 3), decided again from 2026-10-06T12:01:00.000Z`);
    expect(h.store.state.deferred[V.toLowerCase()]).toMatchObject({ failures: 1, notBefore: '2026-10-06T12:01:00.000Z' });
    later(h, 60_000);
    await w.pass();
    expect(h.store.state.deferred).toEqual({});
    expect(h.registry.sends).toHaveLength(1);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastAttestationId).toBe('0');
    expect(h.store.state.queue).toEqual([expect.objectContaining({ subject: V, attempts: 1 })]);
  });
});

describe('the re-review repros, as regressions', { timeout: 60_000 }, () => {
  /** V found through its factory and checked once (attested as factory) at block 2000. */
  const known = async (h: Harness, config: Parameters<Harness['watcher']>[0] = {}, hooks?: Parameters<Harness['watcher']>[1]) => {
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher(config, hooks);
    await w.pass({ drain: true });
    return w;
  };
  const checksOf = (h: Harness, subject: Address) => h.checks.filter((c) => c.subject === subject).length;

  it('N1: a real upgrade of a known vault is checked even when unknown emitters use up the probes of the pass', async () => {
    const h = await harness();
    const w = await known(h);
    for (let i = 0; i < 25; i++) {
      const a = addr(0x9000 + i);
      h.chain.notVaults.add(a.toLowerCase());
      h.chain.logs.push({ ...upgradedLog(a, 2015n), logIndex: i });
    }
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xbeef));
    h.chain.logs.push(upgradedLog(V, 2016n));
    h.chain.head = 2030n;
    later(h, 10 * 60_000);
    await w.pass({ drain: true });
    expect(checksOf(h, V)).toBe(2);
    expect(Object.keys(h.store.state.probing)).toHaveLength(5);
  });

  it('N1: a fingerprint read that fails carries the signal to a later pass instead of counting as "nothing changed"', async () => {
    const h = await harness();
    const w = await known(h);
    const fingerprint = h.effects.fingerprint!;
    h.effects.fingerprint = async (subject, block) => {
      if (subject === V) throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
      return fingerprint(subject, block);
    };
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xbeef));
    h.chain.logs.push(upgradedLog(V, 2016n));
    h.chain.head = 2030n;
    later(h, 10 * 60_000);
    await w.pass({ drain: true });
    expect(checksOf(h, V)).toBe(1);
    expect(h.store.state.upgrades[V.toLowerCase()]).toEqual({ source: 'upgrade', block: '2016', txHash: hash(2018), failures: 1, notBefore: '2026-10-06T12:15:00.000Z' });
    expect((await h.feed()).at(-1)!.reason).toBe('fingerprint not read, the signal is looked at again from 2026-10-06T12:15:00.000Z: transport failure: fetch failed');
    h.effects.fingerprint = fingerprint;
    later(h, 5 * 60_000);
    await w.pass({ drain: true });
    expect(checksOf(h, V)).toBe(2);
    expect(h.store.state.upgrades).toEqual({});
  });

  it('N1: an Upgraded naming an implementation the last check did not run queues the vault without a read', async () => {
    const h = await harness();
    h.chain.beacons.set(V.toLowerCase(), addr(0xbeac));
    const w = await known(h);
    expect(h.store.state.implementations[V.toLowerCase()]).toBe(addr(0x1111).toLowerCase());
    const reads = h.chain.fingerprintReads;
    h.chain.logs.push(upgradedLog(V, 2016n, addr(0x2222)));
    h.chain.head = 2030n;
    later(h, 10 * 60_000);
    await w.pass();
    expect(h.chain.fingerprintReads).toBe(reads + 1);
    expect((await h.feed()).find((e) => e.kind === 'queued' && e.source === 'upgrade')!.reason).toBe('the event names an implementation the last check did not run');
    expect(checksOf(h, V)).toBe(2);
  });

  it('N2: a stable new failure is confirmed while another count moves between the checks', async () => {
    const h = await harness();
    const w = await known(h);
    h.chain.failing.set(V.toLowerCase(), ['deposit']);
    const run = h.effects.runCheck;
    let n = 0;
    h.effects.runCheck = async (subject, block, opts) => {
      const r = await run(subject, block, opts);
      if (subject !== V) return r;
      n++;
      const results = r.results.map((x, i) => (i === 5 && n % 2 === 0 ? { ...x, status: 'inconclusive' as const, reason: '`vm.assume` rejected too many inputs (4096 allowed)' } : x));
      return parseCheckReport(JSON.stringify({ ...r, results, summary: summarize(results) }));
    };
    let block = 2010n;
    for (let i = 0; i < 3; i++) {
      h.chain.fingerprints.set(V.toLowerCase(), hash(0x100 + i));
      block += 20n;
      h.chain.logs.push(upgradedLog(V, block - 15n));
      h.chain.head = block;
      later(h, 3 * 60_000);
      await w.pass({ drain: true });
    }
    const feed = (await h.feed()).filter((e) => e.subject === V);
    expect(feed.find((e) => e.kind === 'changed' && e.change!.kind === 'regressed')).toBeDefined();
    expect(feed.filter((e) => e.kind === 'attested')).toHaveLength(2);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck!.failed).toEqual(['deposit']);
  });

  it('N2: checks that never agree on the failed properties are recorded as unstable, attested and alerted, not dropped', async () => {
    const h = await harness();
    const w = await known(h);
    const properties = ['deposit', 'mint', 'withdraw', 'redeem'];
    let block = 2010n;
    for (let i = 0; i < 4; i++) {
      h.chain.failing.set(V.toLowerCase(), [properties[i]!]);
      h.chain.fingerprints.set(V.toLowerCase(), hash(0x100 + i));
      block += 20n;
      h.chain.logs.push(upgradedLog(V, block - 15n));
      h.chain.head = block;
      later(h, 3 * 60_000);
      await w.pass({ drain: true });
    }
    const feed = (await h.feed()).filter((e) => e.subject === V);
    const last = feed.filter((e) => e.kind === 'checked').at(-1)!;
    expect(last.reason).toMatch(/^unstable: 4 checks in a row did not agree on the failed properties, the latest is recorded; attesting \[fail\]: /);
    expect(kinds(feed.slice(-3))).toEqual(['checked:upgrade', 'attested:upgrade', 'changed:upgrade']);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck!.failed).toEqual(['redeem']);
    expect(h.store.state.pending).toEqual({});
  });

  it('N3: an attest pending for ten minutes is sent again with its nonce and a higher fee, at most three times; status says why nothing else goes', async () => {
    const h = await harness();
    h.registry.hold = true;
    const w = await known(h);
    for (let i = 0; i < 2; i++) h.chain.logs.push(factoryLog(addr(0x8000 + i), 2015n, i));
    h.chain.head = 2030n;
    await w.pass({ drain: true });
    const first = h.registry.sends[0]!.hash;
    expect(w.status().attestBudget.paused).toBe(`attest tx ${first} sent at 2026-10-06T12:00:00.000Z is not mined yet: nothing else is sent until it is`);
    for (let i = 0; i < 5; i++) {
      later(h, 11 * 60_000);
      await w.pass();
    }
    expect(h.registry.replacements.map((r) => r.replaces)).toEqual([first, h.registry.replacements[0]!.hash, h.registry.replacements[1]!.hash]);
    const a = h.store.state.attesting[V.toLowerCase()]!;
    expect(a).toMatchObject({ hash: h.registry.replacements[2]!.hash, nonce: 0, bumps: 3, replaced: [first, h.registry.replacements[0]!.hash, h.registry.replacements[1]!.hash] });
    expect(w.status().attestBudget.paused).toMatch(/is not mined yet \(fee raised 3 times, the most it is\): nothing else is sent until it is$/);
    expect(h.registry.sends).toHaveLength(1);
    h.registry.mine(a.hash as Hex);
    later(h, 60_000);
    await w.pass();
    const attested = (await h.feed()).filter((e) => e.kind === 'attested');
    expect(attested[0]).toMatchObject({ subject: V, attestation: { txHash: a.hash } });
    expect(attested.slice(1).map((e) => e.subject).sort()).toEqual([addr(0x8000), addr(0x8001)]);
    expect(w.status().attestBudget.paused).toBeNull();
  });

  it('N3: the lower-fee send a replacement was for can be the one mined; it is found and counted', async () => {
    const h = await harness();
    h.registry.hold = true;
    const w = await known(h);
    const first = h.registry.sends[0]!.hash;
    later(h, 11 * 60_000);
    await w.pass();
    expect(h.registry.replacements).toHaveLength(1);
    h.registry.txs.get(first)!.state = 'pending';
    h.registry.mine(first);
    await w.pass();
    expect((await h.feed()).filter((e) => e.kind === 'attested').map((e) => e.attestation!.txHash)).toEqual([first]);
    expect(h.store.state.attesting).toEqual({});
    expect(h.store.state.attestDay.used).toBe(1);
  });

  it('N4: a resend with a recorded nonce that fails forgets the nonce; the next send takes a fresh one', async () => {
    const h = await harness();
    h.registry.hold = true;
    const send = h.effects.attest!.send;
    const nonces: Array<number | undefined> = [];
    let flaky = false;
    h.effects.attest = {
      ...h.effects.attest!,
      send: async (p, o) => {
        nonces.push(o.nonce);
        if (flaky) {
          flaky = false;
          throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
        }
        if (o.nonce !== undefined && h.registry.minedNonce > o.nonce) throw Object.assign(new Error('attest failed: nonce too low'), { name: 'RegistryError' });
        return send(p, o);
      },
    };
    const w = await known(h);
    h.registry.drop(h.registry.sends[0]!.hash);
    flaky = true;
    later(h, 60_000);
    await w.pass();
    expect(h.store.state.deferred[V.toLowerCase()]!.nonce).toBeUndefined();
    h.registry.minedNonce = 1;
    for (let i = 0; i < 3; i++) {
      later(h, 10 * 60_000);
      await w.pass();
    }
    expect(nonces).toEqual([undefined, 0, undefined]);
    expect((await h.feed()).filter((e) => e.kind === 'attested')).toHaveLength(1);
  });

  it('N5: a confirmation whose check entry is dropped does not stop the subscribed cadence', async () => {
    const h = await harness();
    const w = await known(h, { subscribedMinutes: 60 }, { subscriptions: { active: async () => [sub(1n, V)] } });
    h.chain.failing.set(V.toLowerCase(), ['deposit']);
    later(h, 61 * 60_000);
    h.chain.head = 2100n;
    await w.pass({ drain: true });
    expect(h.store.state.pending[V.toLowerCase()]).toBeDefined();
    h.chain.checkErrors.set(V.toLowerCase(), 3);
    for (let i = 0; i < 4; i++) {
      later(h, 10 * 60_000);
      h.chain.head += 50n;
      await w.pass({ drain: true });
    }
    expect(h.store.state.pending).toEqual({});
    const n = h.checks.length;
    for (let i = 0; i < 6; i++) {
      later(h, 60 * 60_000);
      h.chain.head += 50n;
      await w.pass({ drain: true });
    }
    expect(h.checks.length - n).toBeGreaterThanOrEqual(5);
  });

  it('N6: the seed rotates with the sweep cycle; a confirmation reuses the seed of the check it confirms', async () => {
    const h = await harness();
    const seeds: bigint[] = [];
    const run = h.effects.runCheck;
    h.effects.runCheck = async (subject, block, opts) => {
      seeds.push(opts!.seed);
      return parseCheckReport(JSON.stringify({ ...(await run(subject, block, opts)), seed: toHex(opts!.seed, { size: 32 }) }));
    };
    const w = await known(h, { confirmDelayMs: 0 });
    const cycle = Math.floor(T0.getTime() / 86_400_000);
    expect(seeds).toEqual([watchFuzzSeedOf(V, 'erc4626', cycle)]);
    // A regression found late in the cycle; its confirmation runs in the next cycle with the same seed.
    h.clock.now = new Date('2026-10-06T23:59:00.000Z');
    h.chain.failing.set(V.toLowerCase(), ['deposit']);
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(V, 2015n));
    h.chain.head = 2030n;
    await w.pass({ drain: true });
    h.clock.now = new Date('2026-10-07T00:01:00.000Z');
    h.chain.head = 2040n;
    await w.pass({ drain: true });
    expect(seeds.slice(1)).toEqual([watchFuzzSeedOf(V, 'erc4626', cycle), watchFuzzSeedOf(V, 'erc4626', cycle)]);
    expect(watchFuzzSeedOf(V, 'erc4626', cycle + 1)).not.toBe(watchFuzzSeedOf(V, 'erc4626', cycle));
    // The next check, not a confirmation, takes the new cycle's seed.
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf3));
    h.chain.logs.push(upgradedLog(V, 2045n));
    h.chain.head = 2060n;
    await w.pass({ drain: true });
    expect(seeds.at(-1)).toBe(watchFuzzSeedOf(V, 'erc4626', cycle + 1));
  });

  it('L8: when OlderThanLatest is not read again, the check is superseded: no last check, no change, no alert', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const latest = h.effects.latestAttestation;
    h.registry.beforeAttest = (p) => {
      h.registry.beforeAttest = null;
      h.registry.attest({ ...attestParams(p.subject, 2004n) });
      h.effects.latestAttestation = async () => {
        throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
      };
    };
    const w = h.watcher();
    await w.pass({ drain: true });
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'queued:factory']);
    expect(feed[3]!.reason).toBe('superseded: the registry refused this check as older than its latest attestation (OlderThanLatest), which could not be read again; checking again at a new block');
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck).toBeNull();
    h.effects.latestAttestation = latest;
  });

  it('L8: `supersedes` comes from the receipt, not from the registry read before the send', async () => {
    const h = await harness();
    const w = await known(h);
    h.chain.failing.set(V.toLowerCase(), ['deposit']);
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(V, 2015n));
    h.chain.head = 2030n;
    later(h, 3 * 60_000);
    await w.pass({ drain: true });
    // Between the decision (latest: 0) and the send another issuer attests an earlier block than this check.
    h.registry.beforeAttest = (p) => {
      h.registry.beforeAttest = null;
      h.registry.attest({ ...attestParams(p.subject, p.blockNumber - 1n), failCount: 1, passCount: 29, failedBitmap: 1n << 5n, passedBitmap: ((1n << 30n) - 1n) ^ (1n << 5n) });
    };
    later(h, 3 * 60_000);
    h.chain.head = 2050n;
    await w.pass({ drain: true });
    const attested = (await h.feed()).filter((e) => e.kind === 'attested').at(-1)!;
    expect(attested.attestation).toMatchObject({ id: '2', supersedes: '1' });
  });

  it('L8: the identity is checked before any report becomes the last check, also one the policy does not attest', async () => {
    const h = await harness();
    h.chain.logs.push(depositLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    h.effects.verifySubject = async () => {
      throw new AttestationError('code at 0x... hashes to 0xaa, the report says 0xbb');
    };
    const w = h.watcher();
    await w.pass({ drain: true });
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:deposit', 'queued:deposit', 'error:deposit']);
    expect(feed[2]!.reason).toMatch(/identity check refused the report: code at /);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck).toBeNull();
  });

  it('M6: a subscription read the time box gave up on is waited on again, never started twice; only the first pass waits', async () => {
    const h = await harness();
    let calls = 0;
    const w = h.watcher(
      { subscriptionRefreshMs: 0, subscriptionTimeoutMs: 50 },
      {
        subscriptions: {
          active: () => {
            calls++;
            return new Promise<never>(() => {});
          },
        },
      },
    );
    const started = Date.now();
    await w.pass();
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    for (let i = 0; i < 4; i++) {
      await w.pass();
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(calls).toBe(1);
  });
});

describe('the final check, as regressions', { timeout: 60_000 }, () => {
  it('an unstable outcome without a failing property is recorded and alerted, not attested', async () => {
    const h = await harness();
    const delivered: string[] = [];
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({}, { subscriptions: { active: async () => [sub(1n, V)] }, alerts: { deliver: async (event) => (delivered.push(`${event.kind}:${event.change?.kind ?? ''}`), []) } });
    await w.pass({ drain: true });
    // Every later check leaves another number of properties inconclusive, none failing: the counts never agree.
    const run = h.effects.runCheck;
    let n = 0;
    h.effects.runCheck = async (subject, block, opts) => {
      const r = await run(subject, block, opts);
      n++;
      const results = r.results.map((x, i) => (i < n ? { ...x, status: 'inconclusive' as const, reason: '`vm.assume` rejected too many inputs (4096 allowed)' } : x));
      return parseCheckReport(JSON.stringify({ ...r, results, summary: summarize(results) }));
    };
    let block = 2010n;
    for (let i = 0; i < 4; i++) {
      h.chain.fingerprints.set(V.toLowerCase(), hash(0x100 + i));
      block += 20n;
      h.chain.logs.push(upgradedLog(V, block - 15n));
      h.chain.head = block;
      later(h, 3 * 60_000);
      await w.pass({ drain: true });
    }
    const feed = (await h.feed()).filter((e) => e.subject === V);
    expect(feed.filter((e) => e.kind === 'checked').at(-1)!.reason).toBe(
      'unstable: 4 checks in a row did not agree on the counts, the latest is recorded; not attested [policy]: an unstable outcome without a failing property is not attested',
    );
    expect(feed.at(-1)).toMatchObject({ kind: 'changed', change: { kind: 'changed' } });
    expect(delivered).toEqual(['changed:new', 'changed:changed']);
    expect(h.registry.list).toHaveLength(1);
  });

  it('fails of candidates no factory announced use at most 3 of the 10 unsolicited attestations a day; factory vaults keep the rest', async () => {
    const h = await harness();
    const candidates = [0, 1, 2, 3].map((i) => addr(0x6000 + i));
    for (const [i, c] of candidates.entries()) {
      h.chain.failing.set(c.toLowerCase(), ['deposit']);
      h.chain.logs.push(depositLog(c, 1995n, i));
    }
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ confirmDelayMs: 0 });
    await w.pass({ drain: true });
    h.chain.head = 2020n;
    await w.pass({ drain: true });
    const reasons = (await h.feed()).filter((e) => e.kind === 'checked' && e.reason!.startsWith('confirmed')).map((e) => e.reason!.split('; ')[1]);
    expect(reasons.filter((r) => r.startsWith('attesting [fail]'))).toHaveLength(3);
    expect(reasons.filter((r) => r.startsWith('attestation deferred [fail]: 3 of 3 attestations of fails of candidates no factory announced made today'))).toHaveLength(1);
    expect(h.store.state.attestDay).toMatchObject({ used: 3, unsolicited: 3, candidateFails: 3 });
    expect(Object.values(h.store.state.deferred)).toEqual([expect.objectContaining({ cls: 'fail', candidate: true, notBefore: '2026-10-07T00:00:00.000Z' })]);
    // A factory vault the same day still has the unsolicited budget.
    h.chain.logs.push(factoryLog(W, 2025n));
    h.chain.head = 2040n;
    await w.pass({ drain: true });
    expect((await h.feed()).filter((e) => e.kind === 'attested').map((e) => e.subject)).toEqual([...candidates.slice(0, 3), W]);
    expect((await statusOf(h)).attestBudget).toMatchObject({ candidateFailsPerDay: 3, candidateFailsUsedToday: 3, unsolicitedUsedToday: 4 });
  });
});

