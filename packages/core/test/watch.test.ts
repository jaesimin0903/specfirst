import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireWatchLock,
  attestDecision,
  builtinSources,
  changeOf,
  checkReportHash,
  createWebhookAlertSink,
  decodeSignal,
  DEMO_FACTORY_ADDRESS,
  LEGACY_DEMO_FACTORY_ADDRESS,
  demoTokenAbi,
  demoTokenBytecode,
  demoVaultAbi,
  demoVaultFactoryAbi,
  demoVaultFactoryBytecode,
  enqueue,
  feedEventSchema,
  FORK_ERROR_NOTE,
  GENERIC_SOURCES,
  isRangeError,
  LogWindow,
  MONAD_MAINNET_SOURCE_FIXTURES,
  MONAD_MAINNET_SOURCES,
  nextEntry,
  outcomeOfAttestation,
  outcomeOfReport,
  parseCheckReport,
  parseFeed,
  priorityOf,
  QUEUE_PRIORITY,
  rangeLimitOf,
  readLogWindows,
  registerWebhook,
  seedKnownVaults,
  signalTopics,
  sourcesFromFile,
  StandardCheckTimeoutError,
  standardIdOf,
  summarize,
  verifySourceFixture,
  WATCH_DIR,
  Watcher,
  webhookMessage,
  WEBHOOKS_JSON,
  WatchError,
  watchStateSchema,
  watchStatusSchema,
  WatchStore,
  watchVaultsSchema,
  type ActiveSubscription,
  type AlertSink,
  type Attestation,
  type AttestParams,
  type FeedEvent,
  type QueueEntry,
  type SignalLog,
  type StandardCheckReport,
  type WatchConfig,
  type WatchEffects,
  type WatchEvent,
  type WatchSource,
} from '../src/index.js';
import * as browserWatch from '../src/watch/index.js';
import {
  MORPHO,
  SIGNALS,
  DEMO_SOURCES,
  ERC4626,
  T0,
  hash,
  addr,
  EVK_FACTORY,
  V2_FACTORY,
  IMPL,
  signalLog,
  source,
  factoryLog,
  depositLog,
  upgradedLog,
  setImplementationLog,
  reportOf,
  FakeRegistry,
  rangeError,
  harness,
  UPGRADE_CANDIDATE_SOURCES,
  kinds,
  attestParams,
  cleanupHarnesses,
  trackDir,
  type Harness,
  type RecordedLog,
} from './helpers/watchHarness.js';

const here = path.dirname(fileURLToPath(import.meta.url));

afterEach(cleanupHarnesses);

/** A VaultDeployed log of the demo factory's ABI, without its emitter. */
function encodeVaultDeployed(vault: Address, asset: Address): { topics: Hex[]; data: Hex } {
  return { topics: encodeEventTopics({ abi: demoVaultFactoryAbi, eventName: 'VaultDeployed', args: { vault, asset } }) as Hex[], data: '0x' };
}


describe('browser-safe @specfirst/core/watch', () => {
  it('imports only viem, zod and its own browser-safe modules', () => {
    const modules = ['index.ts', 'schema.ts', 'hooks.ts', 'sources.ts', 'price.ts'];
    for (const m of modules) {
      const src = readFileSync(path.join(here, '../src/watch', m), 'utf8');
      const imports = [...src.matchAll(/from '([^']+)'/g)].map((x) => x[1]!);
      for (const i of imports) expect(['viem', 'zod', './schema.js', './hooks.js', './sources.js', './price.js'], `${m} imports ${i}`).toContain(i);
    }
    const pkg = JSON.parse(readFileSync(path.join(here, '../package.json'), 'utf8')) as { exports: Record<string, { import: string }> };
    expect(pkg.exports['./watch']!.import).toBe('./dist/watch/index.js');
  });

  it('exports the schemas, the hooks and the sources, the same objects as the package root', () => {
    expect(browserWatch.feedEventSchema).toBe(feedEventSchema);
    for (const name of ['watchStatusSchema', 'watchVaultsSchema', 'parseFeed', 'FEED_KINDS', 'FEED_SOURCES', 'NO_ALERTS', 'NO_SUBSCRIPTIONS', 'builtinSources', 'decodeSignal', 'WATCH_DIR_ENV', 'priceStep', 'dropPercentText']) {
      expect(browserWatch).toHaveProperty(name);
    }
  });
});

describe('watcher file schemas (docs/adr/0006 Interfaces)', () => {
  const event = {
    v: 1,
    seq: 1,
    at: '2026-10-06T12:00:00.000Z',
    kind: 'changed',
    chainId: 143,
    subject: getAddress('0xbd6d56b5b1b535b92d4a0a8c0a9e6cfd9b545167'),
    source: 'factory',
    block: '110930586',
    txHash: hash(1),
    factory: { address: V2_FACTORY, name: 'Morpho VaultV2Factory' },
    check: { block: '110930600', summary: { pass: 29, fail: 1, inconclusive: 0, notApplicable: 0 }, failed: ['previewDeposit'], implementationKey: hash(2), reportPath: 'certs/checks/143/0xbd/1-2.json', reportHash: hash(3), durationMs: 1000 },
    attestation: { id: '20', txHash: hash(4), supersedes: null },
    change: { kind: 'new', from: null, to: { summary: { pass: 29, fail: 1, inconclusive: 0, notApplicable: 0 }, failed: ['previewDeposit'] } },
  };

  it('feed events: the ADR shape, checksummed subjects, decimal blocks, strict fields', () => {
    expect(feedEventSchema.parse(event)).toEqual(event);
    expect(feedEventSchema.parse({ ...event, kind: 'alerted', alert: { subscriptionId: '0', subscriber: addr(9), channel: 'webhook', ok: true, status: 200 } }).alert?.status).toBe(200);
    for (const bad of [
      { ...event, subject: event.subject.toLowerCase() },
      { ...event, block: 110930586 },
      { ...event, block: '0110930586' },
      { ...event, kind: 'refunded' },
      { ...event, source: 'desk' },
      { ...event, extra: 1 },
      { ...event, v: 2 },
      { ...event, seq: 0 },
      { ...event, change: { ...event.change, kind: 'worse' } },
    ]) {
      expect(feedEventSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parseFeed skips a line still being written and counts invalid lines without hiding the rest', () => {
    const line = JSON.stringify(event);
    expect(parseFeed(`${line}\n${JSON.stringify({ ...event, seq: 2 })}\n`).events.map((e) => e.seq)).toEqual([1, 2]);
    expect(parseFeed(`${line}\n{"v":1,"seq":2,"at`)).toEqual({ events: [feedEventSchema.parse(event)], invalid: 0 });
    expect(parseFeed(`not json\n${line}\n{"v":1}\n\n`)).toMatchObject({ invalid: 2, events: [{ seq: 1 }] });
    // A subject that is not an address at all is an invalid line, not a thrown error.
    expect(parseFeed(`${JSON.stringify({ ...event, subject: '0xfeed' })}\n${line}\n`)).toMatchObject({ invalid: 1, events: [{ seq: 1 }] });
  });

  it('vaults.json keys are lowercase addresses', () => {
    const vault = { firstSeen: { source: 'backfill', block: '1', at: '2026-10-06T12:00:00.000Z' }, deployBlock: null, lastCheck: null, lastAttestationId: null, firstDepositBlock: null };
    expect(watchVaultsSchema.safeParse({ v: 1, vaults: { [addr(5).toLowerCase()]: vault } }).success).toBe(true);
    expect(watchVaultsSchema.safeParse({ v: 1, vaults: { [addr(0xabcdef)]: vault } }).success).toBe(false);
    expect(watchVaultsSchema.safeParse({ v: 1, vaults: { [addr(5).toLowerCase()]: { ...vault, firstSeen: { ...vault.firstSeen, source: 'desk' } } } }).success).toBe(false);
  });
});

describe('signal sources (docs/adr/0006 Signals)', () => {
  it('unknown Upgraded and BeaconUpgraded emitters are not candidates by default, only Deposit emitters are', async () => {
    expect(Object.fromEntries(GENERIC_SOURCES.map((s) => [s.name, s.candidates]))).toEqual({
      'ERC-4626 Deposit': true,
      'EIP-1967 Upgraded': false,
      'EIP-1967 BeaconUpgraded': false,
    });
    const h = await harness();
    for (let i = 0; i < 5; i++) h.chain.logs.push({ ...upgradedLog(addr(0x7000 + i), 1995n), logIndex: i });
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    await h.watcher().pass();
    expect(await h.feed()).toEqual([]);
    expect(h.store.state.probing).toEqual({});
  });

  it('the built-in topics are the ADR table, computed from the event signatures', () => {
    const byName = Object.fromEntries([...MONAD_MAINNET_SOURCES, ...GENERIC_SOURCES].map((s) => [s.name, s.topic0]));
    expect(byName).toEqual({
      'Euler EVK GenericFactory': '0x04e664079117e113faa9684bc14aecb41651cbf098b14eda271248c6d0cda57c',
      'Morpho VaultV2Factory': '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e',
      'MetaMorpho V1.1 factory': '0xed8c95d05909b0f217f3e68171ef917df4b278d5addfe4dda888e90279be7d1d',
      'Euler Earn factory': '0x2ecfce4fdb2055c9639b56f59c2a14eeafce06a51d93d898155bc11b6141896f',
      'Neverland static wrapper factory': '0x7397831292236fdc8043acf7b9d21183e46fd54f9b06bd34210068f95dd378d6',
      'Euler EVK GenericFactory implementation': '0xddebe6de740fe0dd01cc33ffa314d11c6ac6acbbe50b80513c4c360ae7aa4f04',
      'ERC-4626 Deposit': '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
      'EIP-1967 Upgraded': '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
      'EIP-1967 BeaconUpgraded': '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e',
    });
    expect(builtinSources(10143).sources.map((s) => s.signal)).toEqual(['deposit', 'upgrade', 'beacon-upgrade']);
    expect(signalTopics(builtinSources(143).sources)).toHaveLength(9);
  });

  it('every factory decodes its recorded mainnet creation log to the fixture vault', () => {
    const { sources, fixtures } = builtinSources(143);
    expect(SIGNALS.factories.map((f) => `${f.source}@${f.block}`)).toEqual(fixtures.map((f) => `${f.source}@${f.block}`));
    for (const f of SIGNALS.factories) {
      const s = decodeSignal(signalLog(f.log), sources);
      expect(s, f.source).not.toBeNull();
      expect(s!.source.name).toBe(f.source);
      expect(s!.source.signal).toBe('factory');
      expect(s!.subject).toBe(getAddress(f.vault.toLowerCase()));
      expect(s!.block).toBe(BigInt(f.block));
    }
  });

  it('verifySourceFixture finds each ADR fixture among the logs of its factory at its block', async () => {
    const { sources } = builtinSources(143);
    const logs = SIGNALS.factories.map((f) => signalLog(f.log));
    const getLogs = async (q: { address: Address; topic0: Hex; block: bigint }) => logs.filter((l) => l.address === q.address && l.topics[0] === q.topic0 && l.blockNumber === q.block);
    for (const fixture of MONAD_MAINNET_SOURCE_FIXTURES) expect(await verifySourceFixture(fixture, sources, getLogs), fixture.source).toMatchObject({ ok: true });
    expect(await verifySourceFixture({ ...MONAD_MAINNET_SOURCE_FIXTURES[1]!, vault: addr(1) }, sources, getLogs)).toMatchObject({ ok: false });
  });

  it('generic signals name their emitter; SetImplementation names the beacon', () => {
    const { sources } = builtinSources(143);
    const dep = decodeSignal(signalLog(SIGNALS.generic.deposit.log), sources)!;
    expect(dep).toMatchObject({ subject: getAddress(SIGNALS.generic.deposit.subject!), source: { signal: 'deposit' } });
    const up = decodeSignal(signalLog(SIGNALS.generic.upgraded.log), sources)!;
    expect(up).toMatchObject({ subject: getAddress(SIGNALS.generic.upgraded.subject!), source: { signal: 'upgrade' } });
    const impl = decodeSignal(signalLog(SIGNALS.generic.implementation.log), sources)!;
    expect(impl).toMatchObject({ subject: EVK_FACTORY, source: { name: 'Euler EVK GenericFactory implementation', signal: 'implementation' } });
    expect(SIGNALS.generic.implementation.log.topics[1]).toBe(`0x${'0'.repeat(24)}${SIGNALS.generic.implementation.implementation!.slice(2)}`);
  });

  it('ignores other topics and other emitters, and a factory event that does not decode', () => {
    const { sources } = builtinSources(143);
    const f = signalLog(SIGNALS.factories[1]!.log);
    expect(decodeSignal({ ...f, topics: [hash(9), ...f.topics.slice(1)] }, sources)).toBeNull();
    // The same CreateVaultV2 topic from another emitter is not the factory.
    expect(decodeSignal({ ...f, address: addr(77) }, sources)).toBeNull();
    // Too few topics for the indexed vault argument.
    expect(decodeSignal({ ...f, topics: f.topics.slice(0, 2) }, sources)).toBeNull();
    // SetImplementation from another emitter is nothing.
    expect(decodeSignal({ ...signalLog(SIGNALS.generic.implementation.log), address: addr(78) }, sources)).toBeNull();
  });

  it('the demo sources file names DemoVaultFactory at its CREATE2 address, keeps the factory before setLoss, and keeps testnet contracts from becoming candidates', async () => {
    const json = JSON.parse(await readFile(DEMO_SOURCES, 'utf8'));
    const { sources } = sourcesFromFile(json, 10143);
    expect(sources[0]).toMatchObject({ name: 'Specfirst DemoVaultFactory', signal: 'factory', address: DEMO_FACTORY_ADDRESS, vault: 'vault' });
    expect(sources[1]).toMatchObject({ name: 'Specfirst DemoVaultFactory before setLoss', signal: 'factory', address: LEGACY_DEMO_FACTORY_ADDRESS, vault: 'vault', topic0: sources[0]!.topic0 });
    expect(DEMO_FACTORY_ADDRESS).not.toBe(LEGACY_DEMO_FACTORY_ADDRESS);
    // Both factories emit the same event: each log is taken from the factory that emitted it.
    const log = (factory: Address) => ({ ...encodeVaultDeployed(addr(0xd1), addr(0xa5)), address: factory, blockNumber: 1n, transactionHash: hash(1), logIndex: 0 });
    expect(decodeSignal(log(LEGACY_DEMO_FACTORY_ADDRESS), sources)).toMatchObject({ subject: addr(0xd1), source: { name: 'Specfirst DemoVaultFactory before setLoss' } });
    expect(decodeSignal(log(DEMO_FACTORY_ADDRESS), sources)).toMatchObject({ subject: addr(0xd1), source: { name: 'Specfirst DemoVaultFactory' } });
    expect(sources.slice(2).map((s) => [s.name, s.signal, s.candidates])).toEqual([
      ['ERC-4626 Deposit', 'deposit', false],
      ['EIP-1967 Upgraded', 'upgrade', false],
      ['EIP-1967 BeaconUpgraded', 'beacon-upgrade', false],
    ]);
    expect(() => sourcesFromFile(json, 143)).toThrow(/for chain 10143, the subject chain is 143/);
  });

  it('refuses a sources file with a wrong topic0, a vault argument that is not an address, a factory without address, duplicates', () => {
    const base = { v: 1, chainId: 31337, sources: [{ name: 'f', signal: 'factory', address: addr(1), event: 'event VaultDeployed(address indexed vault, address indexed asset)', vault: 'vault' }] };
    expect(sourcesFromFile(base, 31337).sources[0]!.topic0).toBe('0x09d75e12e349f79020715b0ea7b2c707e8acf1889b6d6f1337fce7f4e1b9e5c7');
    const s0 = base.sources[0]!;
    for (const [sources, msg] of [
      [[{ ...s0, topic0: hash(1) }], /is not the selector/],
      [[{ ...s0, vault: 'nope' }], /vault must name an argument/],
      [[{ ...s0, event: 'event X(uint256 indexed vault)' }], /is uint256, not address/],
      [[{ ...s0, address: null }], /needs the factory's address/],
      [[{ ...s0, signal: 'deposit' }], /only factory sources name a vault argument/],
      [[{ ...s0, signal: 'implementation', vault: null, address: null }], /needs the beacon's address/],
      [[s0, s0], /two sources are named "f"/],
      [[{ ...s0, event: 'function x()' }], /is not an event signature/],
    ] as const) {
      expect(() => sourcesFromFile({ ...base, sources }, 31337)).toThrow(msg);
    }
    expect(() => sourcesFromFile({ ...base, fixtures: [{ source: 'g', block: '1', vault: addr(2) }] }, 31337)).toThrow(/fixture names source "g"/);
    expect(() => sourcesFromFile({ ...base, extra: 1 }, 31337)).toThrow(/not a sources file/);
  });
});

describe('getLogs windows', () => {
  it('recognizes the range errors of the Monad RPCs and reads the limit', () => {
    expect(isRangeError(rangeError(100n))).toBe(true);
    expect(rangeLimitOf(rangeError(100n))).toBe(100n);
    const rpc3 = Object.assign(new Error('RPC Request failed.'), { name: 'RpcRequestError', cause: { code: -32062, message: 'Block range is too large' } });
    expect(isRangeError(rpc3)).toBe(true);
    expect(rangeLimitOf(rpc3)).toBeNull();
    expect(isRangeError(Object.assign(new Error('Invalid params'), { code: -32602, details: 'block range too large' }))).toBe(true);
    expect(isRangeError(new Error('query returned more than 10000 results'))).toBe(true);
    expect(isRangeError(Object.assign(new Error('HTTP request failed.'), { status: 429 }))).toBe(false);
    expect(isRangeError(new Error('invalid block range: fromBlock is after toBlock'))).toBe(false);
  });

  it('LogWindow shrinks to the named limit or a tenth, never below one block, and grows back', () => {
    const w = new LogWindow(10_000n, 3);
    expect(w.shrink(rangeError(100n))).toBe(true);
    expect(w.size).toBe(100n);
    expect(w.shrink(new Error('Block range is too large'))).toBe(true);
    expect(w.size).toBe(10n);
    w.shrink(new Error('Block range is too large'));
    expect(w.size).toBe(1n);
    expect(w.shrink(new Error('Block range is too large'))).toBe(false);
    for (let i = 0; i < 3; i++) w.succeeded();
    expect(w.size).toBe(2n);
    // Ten more doublings, then capped at the maximum.
    for (let i = 0; i < 30; i++) w.succeeded();
    expect(w.size).toBe(2048n);
    for (let i = 0; i < 30; i++) w.succeeded();
    expect(w.size).toBe(10_000n);
  });

  it('readLogWindows covers every block once, shrinking after a range error, and hands over windows before a failure', async () => {
    const calls: Array<[bigint, bigint]> = [];
    const seen: bigint[] = [];
    const window = new LogWindow(1000n);
    const next = await readLogWindows({
      getLogs: async (from, to) => {
        calls.push([from, to]);
        if (to - from > 100n) throw rangeError(100n);
        return [];
      },
      topics: [hash(1)],
      from: 500n,
      to: 799n,
      window,
      onWindow: async ({ fromBlock, toBlock }) => {
        for (let b = fromBlock; b <= toBlock; b++) seen.push(b);
      },
    });
    expect(next).toBe(800n);
    expect(calls[0]).toEqual([500n, 799n]);
    expect(calls.slice(1)).toEqual([
      [500n, 599n],
      [600n, 699n],
      [700n, 799n],
    ]);
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);

    const handed: bigint[] = [];
    let n = 0;
    await expect(
      readLogWindows({
        getLogs: async () => {
          if (++n === 3) throw new Error('fetch failed');
          return [];
        },
        topics: [hash(1)],
        from: 0n,
        to: 99n,
        window: new LogWindow(10n),
        onWindow: async ({ toBlock }) => {
          handed.push(toBlock);
        },
      }),
    ).rejects.toThrow('fetch failed');
    expect(handed).toEqual([9n, 19n]);
  });
});

describe('queue and attest rule (pure)', () => {
  const entry = (subject: Address, source: QueueEntry['source'], candidate: boolean, at: string): QueueEntry => ({ subject, source, priority: priorityOf(source, candidate), enqueuedAt: at, attempts: 0 });

  it('priorities follow the ADR: subscribed, candidate, upgrade or implementation, first-deposit, sweep', () => {
    expect(priorityOf('subscribed', false)).toBe(QUEUE_PRIORITY.subscribed);
    expect(priorityOf('factory', true)).toBe(QUEUE_PRIORITY.candidate);
    expect(priorityOf('deposit', true)).toBe(QUEUE_PRIORITY.candidate);
    expect(priorityOf('upgrade', false)).toBe(QUEUE_PRIORITY.upgrade);
    expect(priorityOf('implementation', false)).toBe(QUEUE_PRIORITY.upgrade);
    expect(priorityOf('first-deposit', false)).toBe(QUEUE_PRIORITY.firstDeposit);
    expect(priorityOf('sweep', false)).toBe(QUEUE_PRIORITY.sweep);
    const q: QueueEntry[] = [];
    expect(enqueue(q, entry(addr(1), 'sweep', false, '2026-10-06T00:00:01.000Z'))).toBe('added');
    expect(enqueue(q, entry(addr(2), 'first-deposit', false, '2026-10-06T00:00:02.000Z'))).toBe('added');
    expect(enqueue(q, entry(addr(3), 'factory', true, '2026-10-06T00:00:03.000Z'))).toBe('added');
    expect(enqueue(q, entry(addr(4), 'upgrade', false, '2026-10-06T00:00:00.000Z'))).toBe('added');
    expect(nextEntry(q, T0)!.subject).toBe(addr(3));
    // One entry per subject: a higher priority raises it, a lower one keeps it.
    expect(enqueue(q, entry(addr(1), 'subscribed', false, '2026-10-06T00:00:09.000Z'))).toBe('raised');
    expect(enqueue(q, entry(addr(3), 'sweep', false, '2026-10-06T00:00:09.000Z'))).toBe('kept');
    expect(q).toHaveLength(4);
    expect(nextEntry(q, T0)).toMatchObject({ subject: addr(1), source: 'subscribed' });
    q[0]!.notBefore = '2026-10-07T00:00:00.000Z';
    expect(nextEntry(q, T0)!.subject).toBe(addr(3));
  });

  const att = (o: Partial<Attestation>): { id: bigint; attestation: Attestation } => {
    const report = reportOf(addr(5), 100n);
    return {
      id: 7n,
      attestation: {
        status: 1,
        blockNumber: 100n,
        passCount: 30,
        failCount: 0,
        inconclusiveCount: 0,
        notApplicableCount: 0,
        failedBitmap: 0n,
        implementationKey: report.identity.implementationKey as Hex,
        ...o,
      } as Attestation,
    };
  };

  it('attestDecision: attest without a Valid attestation or when counts, failures or the implementation key differ', () => {
    const ok = outcomeOfReport(reportOf(addr(5), 120n));
    const broken = outcomeOfReport(reportOf(addr(5), 120n, { fail: ['previewDeposit'] }));
    expect(broken.failed).toEqual(['previewDeposit']);
    expect(attestDecision(ok, null, 120n)).toEqual({ attest: true, supersedes: null, reason: 'no attestation of the subject yet' });
    expect(attestDecision(ok, att({ status: 3 }), 120n)).toEqual({ attest: true, supersedes: null, reason: 'the latest attestation 7 is Revoked' });
    expect(attestDecision(ok, att({}), 120n)).toEqual({ attest: false, reason: 'unchanged since attestation 7' });
    expect(attestDecision(broken, att({}), 120n)).toEqual({ attest: true, supersedes: 7n, reason: 'counts, failed differ from attestation 7' });
    expect(attestDecision(ok, att({ implementationKey: hash(9) }), 120n)).toMatchObject({ attest: true, supersedes: 7n, reason: 'implementation key differ from attestation 7' });
    // Same counts, another failed property: bit 5 is previewDeposit, bit 6 deposit.
    const other = att({ passCount: 29, failCount: 1, failedBitmap: 1n << 6n });
    expect(outcomeOfAttestation(other.attestation).failed).toEqual(['deposit']);
    expect(attestDecision(broken, other, 120n)).toMatchObject({ attest: true, reason: 'failed differ from attestation 7' });
    expect(attestDecision(broken, att({ passCount: 29, failCount: 1, failedBitmap: 1n << 5n }), 120n)).toMatchObject({ attest: false });
    // The registry refuses an older block while the latest is Valid.
    expect(attestDecision(broken, att({ blockNumber: 130n }), 120n)).toEqual({
      attest: false,
      reason: 'attestation 7 is for a later block (130) than this check (120)',
      newer: { id: 7n, block: 130n },
    });
    // Whoever issued it: the issuer is not part of the rule.
    expect(attestDecision(ok, att({ issuer: addr(0xdead) }), 120n)).toMatchObject({ attest: false, reason: 'unchanged since attestation 7' });
  });

  it('changeOf: new, regressed, recovered, changed, implementation, or nothing', () => {
    const ok = outcomeOfReport(reportOf(addr(5), 1n));
    const one = outcomeOfReport(reportOf(addr(5), 1n, { fail: ['previewDeposit'] }));
    const other = outcomeOfReport(reportOf(addr(5), 1n, { fail: ['deposit'] }));
    expect(changeOf(null, ok)).toMatchObject({ kind: 'new', from: null, to: { summary: { pass: 30 }, failed: [] } });
    expect(changeOf(ok, one)).toMatchObject({ kind: 'regressed', from: { failed: [] }, to: { failed: ['previewDeposit'] } });
    expect(changeOf(one, other)!.kind).toBe('regressed');
    expect(changeOf(one, ok)!.kind).toBe('recovered');
    expect(changeOf(ok, { ...ok, summary: { pass: 29, fail: 0, inconclusive: 1, notApplicable: 0 } })!.kind).toBe('changed');
    expect(changeOf(ok, { ...ok, implementationKey: hash(9) })!.kind).toBe('implementation');
    expect(changeOf(ok, { ...ok })).toBeNull();
  });
});

describe('WatchStore files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-store-'));
    trackDir(dir);
  });

  it('starts empty, saves state, vaults and status atomically, and reloads them', async () => {
    const store = await WatchStore.load(dir, 143);
    expect(store.dir).toBe(path.join(dir, '.specfirst/watch/143'));
    expect(store.state).toMatchObject({ v: 1, chainId: 143, cursor: null, seq: 0, queue: [] });
    store.state.cursor = '42';
    store.vaults.vaults[addr(7).toLowerCase()] = { firstSeen: { source: 'factory', block: '41', at: T0.toISOString() }, deployBlock: '41', lastCheck: null, lastAttestationId: null, firstDepositBlock: null };
    await store.save();
    expect(existsSync(store.statusPath)).toBe(false);
    const again = await WatchStore.load(dir, 143);
    expect(again.state.cursor).toBe('42');
    expect(Object.keys(again.vaults.vaults)).toEqual([addr(7).toLowerCase()]);
    expect(watchStateSchema.parse(JSON.parse(await readFile(again.statePath, 'utf8'))).cursor).toBe('42');
  });

  it('refuses a state of another chain and invalid files', async () => {
    const other = await WatchStore.load(dir, 10143);
    await other.save();
    await mkdir(path.join(dir, '.specfirst/watch/143'), { recursive: true });
    await writeFile(path.join(dir, '.specfirst/watch/143/state.json'), await readFile(other.statePath, 'utf8'));
    await expect(WatchStore.load(dir, 143)).rejects.toThrow(/is for chain 10143, not 143/);
    await writeFile(path.join(dir, '.specfirst/watch/143/state.json'), '{"v":1}');
    await expect(WatchStore.load(dir, 143)).rejects.toThrow(WatchError);
    await rm(path.join(dir, '.specfirst/watch/143/state.json'));
    await writeFile(path.join(dir, '.specfirst/watch/143/vaults.json'), JSON.stringify({ v: 1, vaults: { [addr(0xabcdef)]: {} } }));
    await expect(WatchStore.load(dir, 143)).rejects.toThrow(/watch vaults .* is invalid/);
  });

  it('append stamps v and seq, counts the kinds of the last day, and seq continues after the feed when the state is behind', async () => {
    const store = await WatchStore.load(dir, 143);
    const e = { at: T0.toISOString(), chainId: 143, subject: addr(7) };
    const out = await store.append([{ ...e, kind: 'detected', source: 'factory' }, { ...e, kind: 'queued', source: 'factory' }], T0);
    expect(out.map((x) => [x.v, x.seq])).toEqual([
      [1, 1],
      [1, 2],
    ]);
    expect(store.state.recent).toEqual([{ kind: 'detected', at: T0.toISOString() }]);
    await expect(store.append([{ ...e, kind: 'detected', subject: addr(0xabc).toLowerCase() as Address }], T0)).rejects.toThrow();
    expect(store.state.seq).toBe(2);
    await store.save();
    await store.append([{ ...e, kind: 'checked' }], T0);
    // state.json still says seq 2 (no save after the third line): the feed's tail wins on load.
    const again = await WatchStore.load(dir, 143);
    expect(again.state.seq).toBe(3);
    expect(parseFeed(await readFile(again.feedPath, 'utf8')).events.map((x) => x.seq)).toEqual([1, 2, 3]);
  });

  it('takes one lock per chain directory', async () => {
    const release = await acquireWatchLock(dir, 143, { pid: 111, isAlive: () => true });
    await expect(acquireWatchLock(dir, 143, { pid: 222, isAlive: (p) => p === 111 })).rejects.toThrow(/another watcher \(pid 111\) is running/);
    const otherChain = await acquireWatchLock(dir, 10143, { pid: 222, isAlive: () => true });
    await otherChain();
    const next = await acquireWatchLock(dir, 143, { pid: 222, isAlive: () => false });
    await next();
    await release();
  });

  it('seeds the known set from certs/checks: oldest report as firstSeen, newest as lastCheck, beacons, unreadable reports skipped', async () => {
    const write = async (r: StandardCheckReport) => {
      const file = path.join(dir, 'certs/checks/143', r.address.toLowerCase(), `${r.blockNumber}-${checkReportHash(r).slice(2, 18)}.json`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(r));
      return path.relative(dir, file);
    };
    await write(reportOf(addr(1), 100n, { startedAt: '2026-10-01T00:00:00.000Z' }));
    const newest = await write(reportOf(addr(1), 200n, { fail: ['deposit'], startedAt: '2026-10-02T00:00:00.000Z' }));
    await write(reportOf(addr(2), 150n, { beacon: EVK_FACTORY }));
    await mkdir(path.join(dir, 'certs/checks/143', addr(3).toLowerCase()), { recursive: true });
    await writeFile(path.join(dir, 'certs/checks/143', addr(3).toLowerCase(), '5-0000000000000000.json'), '{"not":"a report"}');
    const misplaced = reportOf(addr(4), 9n);
    await mkdir(path.join(dir, 'certs/checks/143', addr(5).toLowerCase()), { recursive: true });
    await writeFile(path.join(dir, 'certs/checks/143', addr(5).toLowerCase(), `9-${checkReportHash(misplaced).slice(2, 18)}.json`), JSON.stringify(misplaced));

    const store = await WatchStore.load(dir, 143);
    const out = await seedKnownVaults(dir, store);
    expect(out).toMatchObject({ added: 2, adopt: [] });
    expect(out.skipped).toHaveLength(2);
    expect(store.vaults.vaults[addr(1).toLowerCase()]).toEqual({
      firstSeen: { source: 'backfill', block: '100', at: '2026-10-01T00:00:00.000Z' },
      deployBlock: null,
      lastCheck: { block: '200', at: '2026-10-02T00:00:00.000Z', reportPath: newest, summary: { pass: 29, fail: 1, inconclusive: 0, notApplicable: 0 }, failed: ['deposit'], implementationKey: MORPHO.identity.implementationKey },
      lastAttestationId: null,
      firstDepositBlock: null,
    });
    expect(store.state.beacons).toEqual({ [addr(2).toLowerCase()]: EVK_FACTORY.toLowerCase() });
    expect(store.state.checkedBlocks).toEqual({ [addr(1).toLowerCase()]: '200', [addr(2).toLowerCase()]: '150' });
    expect(await seedKnownVaults(dir, store)).toMatchObject({ added: 0, adopt: [] });
    // A newer report of a known vault (a desk check) is not taken silently: it is handed back for the watcher's
    // change decision, and the last check stays until then.
    const desk = await write(reportOf(addr(1), 300n));
    expect(await seedKnownVaults(dir, store)).toMatchObject({ added: 0, adopt: [{ subject: addr(1).toLowerCase(), reportPath: desk }] });
    expect(store.vaults.vaults[addr(1).toLowerCase()]!.lastCheck!.block).toBe('200');
    expect(store.vaults.vaults[addr(1).toLowerCase()]!.firstSeen.block).toBe('100');
  });
});

describe('Watcher with stub effects', { timeout: 60_000 }, () => {
  const V = addr(0xaaa1);
  const W = addr(0xaaa2);
  const X = addr(0xaaa3);
  const later = (h: Harness, ms: number) => {
    h.clock.now = new Date(h.clock.now.getTime() + ms);
  };
  const statusOf = async (h: Harness) => watchStatusSchema.parse(JSON.parse(await readFile(path.join(h.dir, '.specfirst/watch/143/status.json'), 'utf8')));
  const vaultsOf = async (h: Harness) => watchVaultsSchema.parse(JSON.parse(await readFile(path.join(h.dir, '.specfirst/watch/143/vaults.json'), 'utf8')));

  it('a vault a factory announces: detected, probed, queued, checked at head - lag, attested, changed (new); the files follow', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1500n));
    h.store.state.cursor = '1400';
    const r = await h.watcher().pass();
    expect(r).toMatchObject({ head: 2000n, cursor: 1991n, checked: 1, caughtUp: true, idle: true, done: false });
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'attested:factory', 'changed:factory']);
    expect(feed[0]).toMatchObject({ seq: 1, chainId: 143, subject: V, block: '1500', txHash: hash(1500), factory: { address: V2_FACTORY, name: 'Morpho VaultV2Factory' } });
    expect(feed[2]).toMatchObject({
      reason: 'attesting [factory]: first check of a vault a factory announced; no attestation of the subject yet',
      check: { block: '1990', summary: { pass: 30, fail: 0 }, failed: [] },
    });
    expect(feed[3]).toMatchObject({ reason: '[factory]', attestation: { id: '0', txHash: hash(0x7000), supersedes: null } });
    expect(feed[4]).toMatchObject({ change: { kind: 'new', from: null }, attestation: { id: '0' } });
    expect(h.checks).toEqual([{ subject: V, block: 1990n }]);
    expect(h.registry.list[0]!.attestation.reportURI).toMatch(/^https:\/\/example\.org\/checks\/143\/0x0+aaa1\/1990-[0-9a-f]{16}\.json$/);

    const vaults = await vaultsOf(h);
    expect(vaults.vaults[V.toLowerCase()]).toMatchObject({
      firstSeen: { source: 'factory', block: '1500', at: T0.toISOString() },
      deployBlock: '1500',
      lastCheck: { block: '1990', summary: { pass: 30 }, failed: [] },
      lastAttestationId: '0',
      firstDepositBlock: null,
    });
    const status = await statusOf(h);
    expect(status).toMatchObject({
      chainId: 143,
      head: '2000',
      cursor: '1991',
      lagBlocks: 10,
      running: null,
      queue: [],
      counts: { known: 1, detected24h: 1, checked24h: 1, attested24h: 1, changed24h: 1 },
      attestBudget: {
        perDay: 15,
        usedToday: 1,
        unsolicitedPerDay: 10,
        unsolicitedUsedToday: 1,
        perSubjectPerDay: 2,
        minBalanceWei: '300000000000000000',
        balanceWei: '10000000000000000000',
        paused: null,
      },
      gasCostWei: '1',
    });
    expect(status.sources.find((s) => s.name === 'Morpho VaultV2Factory')).toEqual({ name: 'Morpho VaultV2Factory', address: V2_FACTORY, topic0: '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e', seen: 1 });
    expect(h.events.filter((e) => e.type === 'watch-feed')).toHaveLength(5);
  });

  it('an unchanged re-check (first deposit) records checked without a transaction; a confirmed change attests, supersedes and alerts', async () => {
    const h = await harness();
    const delivered: Array<{ kind: string; subs: string[] }> = [];
    const sink: AlertSink = {
      deliver: async (event, subs) => {
        delivered.push({ kind: event.kind, subs: subs.map((s) => s.id.toString()) });
        return subs.map((s) => ({ ...event, v: 1, seq: 0, kind: 'alerted', alert: { subscriptionId: s.id.toString(), subscriber: s.subscriber, channel: 'webhook', ok: true, status: 200 } }));
      },
    };
    const sub = (id: bigint, subject: Address): ActiveSubscription => ({ id, subscriber: addr(0x5b), subjectChainId: 143n, subject, standardId: ERC4626, startsAt: 0n, endsAt: 10n ** 12n });
    const subs = { active: async () => [sub(3n, V)] };
    h.chain.logs.push(factoryLog(V, 1500n));
    h.store.state.cursor = '1400';
    const w = h.watcher({ subscribedMinutes: 600 }, { subscriptions: subs, alerts: sink });
    await w.pass();
    // A subscribed candidate is queued at the subscribed priority; its first check reaches the sink as a change (new).
    expect(kinds(await h.feed())).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'attested:factory', 'changed:factory', 'alerted:factory']);
    expect((await h.feed())[2]!.reason).toBe('attesting [subscribed]: first check since a subscription started; no attestation of the subject yet');
    expect(delivered).toEqual([{ kind: 'changed', subs: ['3'] }]);

    let mark = (await h.feed()).length;
    h.chain.head = 2100n;
    h.chain.logs.push(depositLog(V, 2005n), depositLog(V, 2006n));
    await w.pass();
    const afterDeposit = (await h.feed()).slice(mark);
    expect(kinds(afterDeposit)).toEqual(['queued:first-deposit', 'checked:first-deposit']);
    expect(afterDeposit[1]).toMatchObject({ block: '2005', reason: 'not attested [unchanged]: unchanged since attestation 0', check: { block: '2090' } });
    expect(h.registry.list).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.firstDepositBlock).toBe('2005');

    // The upgrade really changed the implementation slot; the regression waits for a second check at a later block.
    mark = (await h.feed()).length;
    h.chain.head = 2200n;
    h.chain.failing.set(V.toLowerCase(), ['previewDeposit']);
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(V, 2150n));
    await w.pass();
    const pendingCheck = (await h.feed()).slice(mark);
    expect(kinds(pendingCheck)).toEqual(['queued:upgrade', 'checked:upgrade', 'queued:upgrade']);
    expect(pendingCheck[1]!.reason).toBe('pending confirmation [confirm]: regressed against the last check; nothing follows until a second check at a later block agrees');
    expect(h.registry.list).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck!.failed).toEqual([]);

    mark = (await h.feed()).length;
    later(h, 2 * 60_000);
    h.chain.head = 2300n;
    await w.pass();
    const afterUpgrade = (await h.feed()).slice(mark);
    expect(kinds(afterUpgrade)).toEqual(['checked:upgrade', 'attested:upgrade', 'changed:upgrade', 'alerted:upgrade']);
    expect(afterUpgrade[0]!.reason).toBe(
      'confirmed by a second check at block 2290 after block 2190; attesting [subscribed]: confirmed change of a subscribed subject; counts, failed differ from attestation 0',
    );
    expect(afterUpgrade[1]!.attestation).toEqual({ id: '1', txHash: hash(0x7001), supersedes: '0' });
    expect(afterUpgrade[2]).toMatchObject({ change: { kind: 'regressed', from: { failed: [] }, to: { failed: ['previewDeposit'], summary: { pass: 29, fail: 1 } } }, attestation: { id: '1' } });
    expect(afterUpgrade[3]).toMatchObject({ kind: 'alerted', subject: V, alert: { subscriptionId: '3', channel: 'webhook', ok: true } });
    expect(delivered).toEqual([
      { kind: 'changed', subs: ['3'] },
      { kind: 'changed', subs: ['3'] },
    ]);
    expect(h.registry.list[0]!.attestation.status).toBe(2);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastAttestationId).toBe('1');
  });

  it('a new subscription gets the first check after it starts once, then the subscribed cadence re-checks the subject', async () => {
    const h = await harness();
    const delivered: Array<{ kind: string; subs: string[] }> = [];
    const sink: AlertSink = {
      deliver: async (event, subs) => {
        delivered.push({ kind: event.kind, subs: subs.map((s) => s.id.toString()) });
        return [];
      },
    };
    const now = BigInt(T0.getTime() / 1000);
    const active: ActiveSubscription[] = [];
    h.store.vaults.vaults[V.toLowerCase()] = {
      firstSeen: { source: 'backfill', block: '1', at: T0.toISOString() },
      deployBlock: null,
      lastCheck: { block: '1980', at: T0.toISOString(), reportPath: 'certs/checks/x.json', summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [], implementationKey: MORPHO.identity.implementationKey as Hex },
      lastAttestationId: null,
      firstDepositBlock: null,
    };
    h.store.state.cursor = '1991';
    const w = h.watcher({ subscribedMinutes: 30 }, { subscriptions: { active: async () => active }, alerts: sink });
    await w.pass();
    expect(h.checks).toHaveLength(0);
    active.push({ id: 9n, subscriber: addr(0x5c), subjectChainId: 143n, subject: V, standardId: ERC4626, startsAt: now, endsAt: now + 86_400n });
    // Another chain's or standard's subscription is not ours.
    active.push({ ...active[0]!, id: 10n, subjectChainId: 1n }, { ...active[0]!, id: 11n, standardId: standardIdOf('erc20') });
    later(h, 31 * 60_000);
    await w.pass();
    expect(kinds((await h.feed()).filter((e) => e.kind !== 'attested' && e.kind !== 'changed'))).toEqual(['queued:subscribed', 'checked:subscribed']);
    expect(h.checks).toHaveLength(1);
    // Unchanged against the previous check: no change, so the first check goes to the new subscription only.
    expect(delivered).toEqual([{ kind: 'checked', subs: ['9'] }]);
    later(h, 10 * 60_000);
    await w.pass();
    expect(h.checks).toHaveLength(1);
    later(h, 25 * 60_000);
    await w.pass();
    expect(h.checks).toHaveLength(2);
    expect(delivered).toHaveLength(1);
  });

  it("the webhook sink of @specfirst/core/subs plugs in: one POST per registered subscriber for a change and for a new subscription's first check, alerted events numbered after the event", async () => {
    const h = await harness();
    // anvil account 1 registers a webhook; the other subscriber has none.
    const alice = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const bob = { address: addr(0xb0b) };
    const webhooksFile = path.join(h.dir, WATCH_DIR, WEBHOOKS_JSON);
    const url = 'https://hooks.example.org/specfirst';
    const issued = Math.floor(T0.getTime() / 1000);
    const signature = await alice.signMessage({ message: webhookMessage({ subscriber: alice.address, url, issued }) });
    expect(await registerWebhook(webhooksFile, { subscriber: alice.address, url, issued, signature }, { now: issued })).toMatchObject({ ok: true, stored: true });
    const posts: Array<{ url: string; body: unknown }> = [];
    const sink = createWebhookAlertSink({
      webhooksFile,
      fetch: async (to, init) => {
        posts.push({ url: to, body: JSON.parse(init.body) });
        return { status: 204 };
      },
      resolveHost: async () => ['93.184.216.34'],
      reportBaseUrl: 'https://raw.example.org/certs/checks',
      now: () => h.clock.now,
    });
    const sub = (id: bigint, subscriber: Address): ActiveSubscription => ({ id, subscriber, subjectChainId: 143n, subject: V, standardId: ERC4626, startsAt: 0n, endsAt: 10n ** 12n });
    const subs = [sub(3n, alice.address), sub(4n, bob.address), sub(7n, alice.address)];
    const w = h.watcher({ subscribedMinutes: 600 }, { subscriptions: { active: async () => subs }, alerts: sink });
    h.chain.logs.push(factoryLog(V, 1500n));
    h.store.state.cursor = '1400';
    await w.pass();

    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'attested:factory', 'changed:factory', 'alerted:']);
    expect(feed.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    const changed = feed[4]!;
    expect(feed[5]).toEqual({
      v: 1,
      seq: 6,
      at: T0.toISOString(),
      kind: 'alerted',
      chainId: 143,
      subject: V,
      alert: { subscriptionId: '3', subscriber: alice.address, channel: 'webhook', ok: true, status: 204 },
    });
    expect(posts).toEqual([
      {
        url,
        body: {
          v: 1,
          kind: 'change',
          subscriptionId: '3',
          subscriptionIds: ['3', '7'],
          subject: V,
          chainId: 143,
          change: changed.change,
          check: changed.check,
          attestation: changed.attestation,
          reportURL: `https://raw.example.org/certs/checks/${changed.check!.reportPath.slice('certs/checks/'.length)}`,
        },
      },
    ]);

    // A subscription that starts later gets the next check, unchanged, as its first check; only that subscription.
    subs.push(sub(9n, alice.address));
    h.chain.head = 2100n;
    h.chain.logs.push(depositLog(V, 2005n));
    await w.pass();
    const first = (await h.feed()).slice(6);
    expect(kinds(first)).toEqual(['queued:first-deposit', 'checked:first-deposit', 'alerted:']);
    expect(first[2]).toMatchObject({ seq: first[1]!.seq + 1, alert: { subscriptionId: '9', subscriber: alice.address, ok: true, status: 204 } });
    expect(posts[1]!.body).toMatchObject({ kind: 'first-check', subscriptionId: '9', subscriptionIds: ['9'], change: null, attestation: null, check: first[1]!.check });

    // Another unchanged re-check sends nothing: no change, and no subscription without its first check.
    h.chain.head = 2150n;
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(V, 2120n));
    await w.pass();
    expect(kinds((await h.feed()).slice(9))).toEqual(['queued:upgrade', 'checked:upgrade']);
    expect(posts).toHaveLength(2);

    // A failed delivery is an alerted event with a reason, never the URL, and a valid feed line.
    const failing = createWebhookAlertSink({ webhooksFile, fetch: async () => ({ status: 410 }), resolveHost: async () => ['93.184.216.34'], now: () => h.clock.now });
    const w2 = h.watcher({ subscribedMinutes: 600 }, { subscriptions: { active: async () => [sub(3n, alice.address)] }, alerts: failing });
    h.chain.head = 2200n;
    h.chain.failing.set(V.toLowerCase(), ['previewDeposit']);
    h.chain.fingerprints.set(V.toLowerCase(), hash(0xf3));
    h.chain.logs.push(upgradedLog(V, 2170n));
    await w2.pass();
    // The regression is confirmed by the next check at a later block, then alerted.
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 60_000);
    h.chain.head = 2300n;
    await w2.pass();
    const last = (await h.feed()).at(-1)!;
    expect(last).toMatchObject({ kind: 'alerted', alert: { subscriptionId: '3', ok: false, status: 410 }, reason: 'HTTP 410 after 1 attempt' });
    expect(JSON.stringify(last)).not.toContain('hooks.example.org');
  });

  it('a subscribed subject the watcher does not know is detected, probed and checked first', async () => {
    const h = await harness();
    const now = BigInt(T0.getTime() / 1000);
    h.store.state.cursor = '1991';
    h.chain.logs.push(factoryLog(W, 1995n));
    h.chain.head = 2010n;
    const subs = { active: async () => [{ id: 1n, subscriber: addr(0x5c), subjectChainId: 143n, subject: X, standardId: ERC4626, startsAt: now - 10n, endsAt: now + 100n }] };
    await h.watcher({}, { subscriptions: subs }).pass();
    const feed = await h.feed();
    expect(kinds(feed).slice(0, 4)).toEqual(['detected:factory', 'queued:factory', 'detected:subscribed', 'queued:subscribed']);
    // The subscribed subject runs first.
    expect(h.checks).toEqual([{ subject: X, block: 2000n }]);
    expect(h.store.vaults.vaults[X.toLowerCase()]!.firstSeen.source).toBe('subscribed');
  });

  it('probe rejections: recorded, Deposits ignored for a day, another kind of signal probes again; RPC errors retried until it answers', async () => {
    const h = await harness();
    h.chain.notVaults.add(X.toLowerCase());
    h.chain.logs.push(depositLog(X, 1995n), depositLog(X, 1996n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({}, undefined, UPGRADE_CANDIDATE_SOURCES);
    await w.pass();
    expect(kinds(await h.feed())).toEqual(['detected:deposit', 'probe-rejected:deposit']);
    expect((await h.feed())[1]!.reason).toBe('asset() failed at block 2000: reverted');
    expect(h.store.state.rejected[X.toLowerCase()]).toEqual({ at: T0.toISOString(), block: '2000', reason: 'asset() failed at block 2000: reverted', fingerprint: hash(0xf1) });
    h.chain.logs.push(depositLog(X, 2005n));
    h.chain.head = 2020n;
    await w.pass();
    expect(await h.feed()).toHaveLength(2);
    // Within the rejection window an Upgraded probes again only when the code or a slot changed.
    h.chain.notVaults.delete(X.toLowerCase());
    h.chain.logs.push(upgradedLog(X, 2012n));
    h.chain.head = 2025n;
    await w.pass();
    expect(await h.feed()).toHaveLength(2);
    h.chain.fingerprints.set(X.toLowerCase(), hash(0xf9));
    h.chain.logs.push(upgradedLog(X, 2017n));
    h.chain.head = 2030n;
    await w.pass();
    // An unsolicited candidate that passes is checked and recorded, not attested.
    expect(kinds((await h.feed()).slice(2))).toEqual(['detected:upgrade', 'queued:upgrade', 'checked:upgrade', 'changed:upgrade']);
    expect((await h.feed())[4]!.reason).toBe('not attested [policy]: an unsolicited candidate that passes is not attested');
    expect(h.registry.list).toHaveLength(0);
    expect(h.store.state.rejected).toEqual({});

    // An RPC or node error in a probe is never "not a vault": the candidate is probed again, the wait doubling.
    h.chain.probeErrors.set(W.toLowerCase(), 1);
    h.chain.probeErrors.set(V.toLowerCase(), 3);
    h.chain.logs.push(factoryLog(W, 2025n, 0), factoryLog(V, 2025n, 1));
    h.chain.head = 2040n;
    const mark = (await h.feed()).length;
    await w.pass();
    expect(Object.keys(h.store.state.probing).sort()).toEqual([V.toLowerCase(), W.toLowerCase()].sort());
    expect(h.store.state.probing[V.toLowerCase()]).toMatchObject({ failures: 1, notBefore: '2026-10-06T12:05:00.000Z' });
    await w.pass();
    for (const minutes of [5, 10, 20]) {
      later(h, minutes * 60_000);
      await w.pass();
    }
    const tail = (await h.feed()).slice(mark);
    expect(tail.filter((e) => e.kind === 'error').map((e) => `${e.subject === V ? 'V' : 'W'} ${e.reason!.split(': ')[0]}`)).toEqual([
      'W probe failed (attempt 1), not a verdict, probing again from 2026-10-06T12:05:00.000Z',
      'V probe failed (attempt 1), not a verdict, probing again from 2026-10-06T12:05:00.000Z',
      'V probe failed (attempt 2), not a verdict, probing again from 2026-10-06T12:15:00.000Z',
      'V probe failed (attempt 3), not a verdict, probing again from 2026-10-06T12:35:00.000Z',
    ]);
    expect(tail.filter((e) => e.kind === 'probe-rejected')).toEqual([]);
    expect(h.store.vaults.vaults[W.toLowerCase()]).toBeDefined();
    expect(h.store.vaults.vaults[V.toLowerCase()]).toBeDefined();
    expect(h.store.state.probing).toEqual({});
  });

  it('emitter-less sources with candidates off only re-check known vaults', async () => {
    const h = await harness();
    const { sources } = sourcesFromFile(JSON.parse(await readFile(DEMO_SOURCES, 'utf8')), 10143);
    h.chain.logs.push(depositLog(X, 1995n), upgradedLog(W, 1996n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    await h.watcher({}, undefined, sources).pass();
    expect(await h.feed()).toEqual([]);
    expect(h.store.state.sourcesSeen).toEqual({ 'ERC-4626 Deposit': 1, 'EIP-1967 Upgraded': 1 });
  });

  it('SetImplementation of the EVK factory re-checks the vaults that resolve through it, and only those', async () => {
    const h = await harness();
    h.chain.beacons.set(V.toLowerCase(), EVK_FACTORY);
    h.chain.logs.push(factoryLog(V, 1995n, 0), factoryLog(W, 1995n, 1));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    await w.pass({ drain: true });
    expect(h.store.state.beacons).toEqual({ [V.toLowerCase()]: EVK_FACTORY.toLowerCase() });
    h.chain.logs.push(setImplementationLog(2005n));
    h.chain.head = 2020n;
    await w.pass();
    const queued = (await h.feed()).filter((e) => e.kind === 'queued' && e.source === 'implementation');
    expect(queued).toEqual([expect.objectContaining({ subject: V, block: '2005', reason: `Euler EVK GenericFactory implementation ${EVK_FACTORY} set a new implementation` })]);
    expect(h.checks.map((c) => c.subject)).toEqual([V, W, V]);
  });

  it('the attest budget defers attestations to the next UTC day; --no-attest records the decision only', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n, 0), factoryLog(W, 1995n, 1));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ maxAttestPerDay: 1 });
    await w.pass({ drain: true });
    const checked = (await h.feed()).filter((e) => e.kind === 'checked');
    expect(checked.map((e) => e.reason)).toEqual([
      'attesting [factory]: first check of a vault a factory announced; no attestation of the subject yet',
      'attestation deferred [factory]: 1 of 1 attestations made today; no attestation of the subject yet',
    ]);
    expect(h.store.state.deferred[W.toLowerCase()]).toMatchObject({ cls: 'factory', notBefore: '2026-10-07T00:00:00.000Z' });
    expect(h.registry.list).toHaveLength(1);
    expect(Object.keys(h.store.state.deferred)).toEqual([W.toLowerCase()]);
    await w.pass();
    expect(h.registry.list).toHaveLength(1);
    h.clock.now = new Date('2026-10-07T00:00:01.000Z');
    await w.pass();
    expect(h.registry.list.map((a) => a.subject)).toEqual([V, W]);
    expect((await h.feed()).at(-1)).toMatchObject({ kind: 'attested', subject: W, attestation: { id: '1', supersedes: null } });
    expect(h.store.state.deferred).toEqual({});
    expect((await statusOf(h)).attestBudget).toMatchObject({ perDay: 1, usedToday: 1, unsolicitedUsedToday: 1 });

    const dry = await harness();
    dry.effects.attest = null;
    dry.chain.logs.push(factoryLog(V, 1995n));
    dry.store.state.cursor = '1991';
    dry.chain.head = 2010n;
    await dry.watcher().pass();
    expect(kinds(await dry.feed())).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'changed:factory']);
    expect((await dry.feed())[2]!.reason).toBe('not attested [no-attest]: would attest as factory (first check of a vault a factory announced); no attestation of the subject yet');
    expect((await statusOf(dry)).attestBudget.paused).toBe('attesting is off (--no-attest)');
    expect(dry.store.state.deferred).toEqual({});
  });

  it('a newer attestation of another issuer supersedes the check: no attestation, no change, checked again at a new block', async () => {
    const h = await harness();
    h.registry.attest({ ...attestParams(V, 2005n) });
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ checkRetryMs: 60_000 });
    await w.pass({ drain: true });
    expect(kinds(await h.feed())).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'queued:factory']);
    const feed = await h.feed();
    expect(feed[2]!.reason).toBe('not attested [newer]: attestation 0 is for a later block (2005) than this check (2000)');
    expect(feed[3]!.reason).toBe('superseded by attestation 0 of block 2005, a later block than this check; checking again at a new block');
    const vault = h.store.vaults.vaults[V.toLowerCase()]!;
    expect(vault).toMatchObject({ lastAttestationId: '0', lastCheck: null });
    expect(h.store.state.queue).toEqual([expect.objectContaining({ subject: V, attempts: 1, notBefore: '2026-10-06T12:01:00.000Z' })]);
    expect(h.registry.list).toHaveLength(1);
    // A minute later the head is past the newer block: the same outcome as attestation 0, so nothing is sent.
    later(h, 60_000);
    h.chain.head = 2100n;
    await w.pass();
    const after = (await h.feed()).slice(4);
    expect(kinds(after)).toEqual(['checked:factory', 'changed:factory']);
    expect(after[0]).toMatchObject({ reason: 'not attested [unchanged]: unchanged since attestation 0', check: { block: '2090' } });
    expect(h.registry.list).toHaveLength(1);
    expect(vault.lastCheck!.block).toBe('2090');
  });

  it('OlderThanLatest at send time (the desk attested meanwhile) is a superseded check, not a failure', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    // Between the watcher's registry read and its transaction, another issuer attests block 2004.
    h.registry.beforeAttest = (p) => {
      h.registry.beforeAttest = null;
      h.registry.attest({ ...attestParams(p.subject, 2004n), failCount: 1, passCount: 29, failedBitmap: 1n << 5n, passedBitmap: ((1n << 30n) - 1n) ^ (1n << 5n) });
    };
    const w = h.watcher({ checkRetryMs: 60_000 });
    await w.pass();
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'checked:factory', 'queued:factory']);
    expect(feed[2]!.reason).toBe('attesting [factory]: first check of a vault a factory announced; no attestation of the subject yet');
    expect(feed[3]!.reason).toMatch(/^superseded by attestation 0 of block 2004/);
    expect(feed.some((e) => e.kind === 'error')).toBe(false);
    expect(h.store.state.deferred).toEqual({});
    expect(h.store.vaults.vaults[V.toLowerCase()]).toMatchObject({ lastAttestationId: '0', lastCheck: null });
    // The re-check differs from the desk's attestation (it saw previewDeposit fail): attested over it.
    later(h, 60_000);
    h.chain.head = 2100n;
    await w.pass();
    const after = (await h.feed()).slice(4);
    expect(kinds(after)).toEqual(['checked:factory', 'attested:factory', 'changed:factory']);
    expect(after[1]!.attestation).toMatchObject({ id: '1', supersedes: '0' });
  });

  it('a revert is recorded, an RPC failure is decided again later; the status sums the gas', async () => {
    const h = await harness();
    h.chain.logs.push(factoryLog(W, 1995n, 1), factoryLog(X, 1995n, 2));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher();
    h.registry.failNext = Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
    await w.pass({ drain: true });
    const feed = await h.feed();
    const byW = feed.filter((e) => e.subject === W && e.kind === 'error');
    expect(byW[0]!.reason).toBe('attest failed, tried again from 2026-10-06T12:01:00.000Z: transport failure: fetch failed');
    expect(h.store.state.deferred[W.toLowerCase()]).toMatchObject({ cls: 'factory', failures: 1, notBefore: '2026-10-06T12:01:00.000Z' });
    expect(feed.filter((e) => e.subject === X).map((e) => e.kind)).toContain('attested');
    // Not before its retry time: the next pass at once sends nothing.
    await w.pass();
    expect(h.registry.list).toHaveLength(1);
    later(h, 60_000);
    await w.pass();
    expect((await h.feed()).at(-1)).toMatchObject({ kind: 'attested', subject: W });
    expect((await statusOf(h)).gasCostWei).toBe('2');

    // X starts failing a property after a real upgrade: confirmed by a second check, then the send reverts.
    h.registry.failNext = Object.assign(new Error('InvalidCounts reverted'), { errorName: 'InvalidCounts' });
    h.chain.failing.set(X.toLowerCase(), ['deposit']);
    h.chain.fingerprints.set(X.toLowerCase(), hash(0xf2));
    h.chain.logs.push(upgradedLog(X, 2005n));
    h.chain.head = 2020n;
    await w.pass();
    later(h, 2 * 60_000);
    h.chain.head = 2040n;
    await w.pass();
    expect((await h.feed()).filter((e) => e.kind === 'error').at(-1)!.reason).toBe('attest failed: InvalidCounts reverted');
    expect(h.store.state.deferred).toEqual({});
  });

  it('a report with a property left inconclusive by a fork RPC error is not attested and the vault is checked again', async () => {
    const h = await harness();
    h.chain.forkErrors.set(V.toLowerCase(), 1);
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ checkRetryMs: 60_000 });
    await w.pass();
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'error:factory']);
    expect(feed[2]!.reason).toBe(
      `check failed (attempt 1 of 3), retrying from 2026-10-06T12:01:00.000Z: 1 of 30 properties inconclusive on a fork RPC error (deposit: ${FORK_ERROR_NOTE}: EVM error; database error: failed to get account: HTTP error 429)`,
    );
    expect(h.registry.list).toHaveLength(0);
    expect(h.savedReports()).toEqual([]);
    expect(h.store.vaults.vaults[V.toLowerCase()]!.lastCheck).toBeNull();
    later(h, 60_000);
    await w.pass();
    expect(kinds((await h.feed()).slice(3))).toEqual(['checked:factory', 'attested:factory', 'changed:factory']);
  });

  it('a check that runs out of its time budget is recorded, not attested and not retried', async () => {
    const h = await harness();
    h.chain.timeouts.add(V.toLowerCase());
    h.chain.logs.push(factoryLog(V, 1995n));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ checkRetryMs: 60_000 });
    await w.pass({ drain: true });
    const feed = await h.feed();
    expect(kinds(feed)).toEqual(['detected:factory', 'queued:factory', 'error:factory']);
    expect(feed[2]!.reason).toBe('check stopped, not attested and not retried; no check of it before 2026-10-06T13:00:00.000Z (timeout 1): forge timed out after 600s');
    expect(h.store.state.cooldowns[V.toLowerCase()]).toEqual({ until: '2026-10-06T13:00:00.000Z', timeouts: 1 });
    expect(h.store.state.queue).toEqual([]);
    later(h, 3_600_000);
    await w.pass({ drain: true });
    expect(await h.feed()).toHaveLength(3);
    expect(h.registry.list).toHaveLength(0);
  });

  it('a failing check is retried after a delay and dropped after maxCheckAttempts', async () => {
    const h = await harness();
    h.chain.checkErrors.set(V.toLowerCase(), 2);
    h.chain.checkErrors.set(W.toLowerCase(), 9);
    h.chain.logs.push(factoryLog(V, 1995n, 0), factoryLog(W, 1995n, 1));
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const w = h.watcher({ checkRetryMs: 60_000 });
    await w.pass({ drain: true });
    expect(h.store.state.queue.map((q) => [q.subject, q.attempts, q.notBefore])).toEqual([
      [V, 1, '2026-10-06T12:01:00.000Z'],
      [W, 1, '2026-10-06T12:01:00.000Z'],
    ]);
    const r = await w.pass({ drain: true });
    expect(r.checked).toBe(0);
    for (let i = 0; i < 3; i++) {
      later(h, 5 * 60_000);
      await w.pass({ drain: true });
    }
    const errors = (await h.feed()).filter((e) => e.kind === 'error').map((e) => `${e.subject === V ? 'V' : 'W'} ${e.reason!.split(':')[0]}`);
    expect(errors).toEqual([
      'V check failed (attempt 1 of 3), retrying from 2026-10-06T12',
      'W check failed (attempt 1 of 3), retrying from 2026-10-06T12',
      'V check failed (attempt 2 of 3), retrying from 2026-10-06T12',
      'W check failed (attempt 2 of 3), retrying from 2026-10-06T12',
      'W check failed 3 times, dropped until the next signal or sweep',
    ]);
    expect(h.checks.map((c) => c.subject)).toEqual([V]);
    expect(h.store.state.queue).toEqual([]);
  });

  it('the sweep re-checks the vault checked longest ago, at most sweepPerHour an hour, never twice within sweepHours', async () => {
    const h = await harness();
    const known = (lower: string, at: string) => {
      h.store.vaults.vaults[lower] = {
        firstSeen: { source: 'backfill', block: '1', at },
        deployBlock: null,
        lastCheck: { block: '10', at, reportPath: 'certs/checks/x.json', summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [], implementationKey: MORPHO.identity.implementationKey as Hex },
        lastAttestationId: null,
        firstDepositBlock: null,
      };
    };
    known(V.toLowerCase(), '2026-10-04T00:00:00.000Z');
    known(W.toLowerCase(), '2026-10-03T00:00:00.000Z');
    known(X.toLowerCase(), '2026-10-06T06:00:00.000Z');
    h.store.state.cursor = '1991';
    const off = h.watcher({ sweepPerHour: 0 });
    await off.pass();
    expect(h.checks).toEqual([]);
    const w = h.watcher({ sweepPerHour: 1, sweepHours: 24 });
    await w.pass();
    await w.pass();
    expect(h.checks.map((c) => c.subject)).toEqual([W]);
    later(h, 61 * 60_000);
    await w.pass();
    later(h, 61 * 60_000);
    await w.pass();
    // X was checked six hours ago: not due.
    expect(h.checks.map((c) => c.subject)).toEqual([W, V]);
    expect((await h.feed()).filter((e) => e.kind === 'queued').map((e) => e.source)).toEqual(['sweep', 'sweep']);
  });

  it('a failed head or getLogs is reported, keeps the cursor and asks the caller to wait', async () => {
    const h = await harness();
    h.store.state.cursor = '1991';
    h.chain.head = 2010n;
    const getLogs = h.effects.getLogs;
    h.effects.getLogs = async () => {
      throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
    };
    const w = h.watcher();
    expect(await w.pass()).toMatchObject({ cursor: 1991n, caughtUp: false, idle: true, failed: ['logs'] });
    expect(h.events.filter((e) => e.type === 'watch-error')).toEqual([{ type: 'watch-error', step: 'logs', error: 'fetch failed' }]);
    h.effects.getLogs = getLogs;
    const latest = h.effects.latestBlock;
    h.effects.latestBlock = async () => {
      throw new Error('fetch failed');
    };
    expect(await w.pass()).toMatchObject({ head: 2010n, cursor: 1991n, idle: true, failed: ['head'] });
    h.effects.latestBlock = latest;
    expect(await w.pass()).toMatchObject({ cursor: 2001n, caughtUp: true, idle: true, failed: [] });
  });

  it('backfill: shrinks the getLogs window on range errors, keeps its cursor across a restart and stops at --to-block', async () => {
    const h = await harness();
    h.chain.rangeLimit = 100n;
    h.chain.logs.push(factoryLog(V, 700n, 0), factoryLog(W, 1200n, 1), factoryLog(X, 1700n, 2));
    h.store.state.cursor = '500';
    const w = h.watcher({ toBlock: 1300n, maxWindowsPerPass: 3 });
    const r1 = await w.pass();
    expect(r1).toMatchObject({ cursor: 800n, caughtUp: false, done: false, checked: 1 });
    expect(h.events.filter((e) => e.type === 'watch-window-shrunk')).toEqual([{ type: 'watch-window-shrunk', fromBlock: '500', toBlock: '1300', size: '100', error: 'HTTP request failed.' }]);
    expect(h.chain.getLogsCalls.slice(1).every(([f, t]) => t - f === 99n)).toBe(true);
    // A new process: the store from disk, the same cursor.
    const store = await h.reload();
    expect(store.state.cursor).toBe('800');
    const w2 = h.watcher({ toBlock: 1300n });
    const r2 = await w2.pass({ drain: true });
    expect(r2).toMatchObject({ cursor: 1301n, caughtUp: true, done: true });
    expect(h.checks.map((c) => c.subject)).toEqual([V, W]);
  });
});

describe('bundled demo artifact', () => {
  const contracts = path.resolve(here, '../../contracts');
  // Skipped only when forge is not installed; with forge the build runs here, so a stale artifact fails.
  const hasForge = spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasForge)('matches a fresh forge build (regenerate with scripts/gen-demo-artifact.mjs); the sources file names its CREATE2 address', async () => {
    const build = spawnSync('forge', ['build'], { cwd: contracts, encoding: 'utf8', timeout: 240_000 });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const read = (file: string, name: string) => JSON.parse(readFileSync(path.join(contracts, 'out', file, `${name}.json`), 'utf8')) as { abi: unknown; bytecode: { object: string } };
    const factory = read('DemoVaultFactory.sol', 'DemoVaultFactory');
    expect(demoVaultFactoryAbi).toEqual(factory.abi);
    expect(demoVaultFactoryBytecode).toBe(factory.bytecode.object);
    expect(demoVaultAbi).toEqual(read('DemoVaultFactory.sol', 'DemoVault').abi);
    const token = read('DemoToken.sol', 'DemoToken');
    expect(demoTokenAbi).toEqual(token.abi);
    expect(demoTokenBytecode).toBe(token.bytecode.object);
    const file = JSON.parse(await readFile(DEMO_SOURCES, 'utf8')) as { sources: Array<{ address: string | null }> };
    expect(file.sources[0]!.address).toBe(DEMO_FACTORY_ADDRESS);
  }, 300_000);
});
