#!/usr/bin/env node
// Writes the synthetic watcher fixtures (ADR 0006 file shapes) used by the tests and for rendering the watch pages
// locally. Every address, block, hash and result here is made up; the 30 property ids come from a real report.
//
//   node test/fixtures/watch/generate.mjs                 fixed times, into test/fixtures/watch (committed)
//   node test/fixtures/watch/generate.mjs --now --out D   times ending now, into D (for `next dev`)
//
// Then: SPECFIRST_WATCH_DIR=<out> SPECFIRST_CHECKS_DIR=<out>/checks
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256, toHex } from 'viem';
import { canonicalJson } from '@specfirst/core/hash';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : here;
const live = args.includes('--now');
const CHAIN = 143;
// Fixed end of the story for the committed files; --now ends it at the current minute.
const END = live ? Math.floor(Date.now() / 1000) : Date.parse('2026-10-06T09:30:00Z') / 1000;
const iso = (secAgo) => new Date((END - secAgo) * 1000).toISOString();

const boardChecks = join(here, '..', 'board', 'checks', '143');
const templates = {
  complete: JSON.parse(await readFile(join(boardChecks, '0x0f9ba9d0f2f9289efbc2b8505932b458c3cdcf64', '109195820.json'), 'utf8')),
  maxZero: JSON.parse(await readFile(join(boardChecks, '0x024c304307cd4aa63c28c082512c87c0452c9614', '109195820.json'), 'utf8')),
  mismatch: JSON.parse(await readFile(join(boardChecks, '0xd8ec5b4917fef9058545e7d1dc2ac17f1d26305d', '109195820.json'), 'utf8')),
};

const addr = (n) => getAddress(`0xfeed${'0'.repeat(32)}${n.toString(16).padStart(4, '0')}`);
const hx = (seed, bytes = 32) => `0x${Buffer.from(keccak256(toHex(`synthetic ${seed}`)).slice(2), 'hex').subarray(0, bytes).toString('hex')}`;
const V = {
  morpho: addr(1), // found from the Morpho V2 factory at its deploy block, re-checked after its first deposit
  curvance: addr(2), // found from a first Deposit event of an unknown emitter
  upgraded: addr(3), // already known, re-checked after a proxy upgrade, regressed
  notVault: addr(4), // emits Deposit but is not ERC-4626
  euler: addr(5), // found from the Euler EVK factory, waiting in the queue
  broken: addr(6), // the check errored
  metamorpho: addr(7), // being checked right now
};
const SUBSCRIBER = getAddress('0x5ee0000000000000000000000000000000000001');
const FACTORY = {
  morphoV2: { address: getAddress('0x8b2f922162fbb60a6a072cc784a2e4168fb0bb0c'), name: 'Morpho VaultV2Factory' },
  evk: { address: getAddress('0xba4Dd672062dE8FeeDb665DD4410658864483f1E'), name: 'Euler EVK GenericFactory' },
  metaMorpho: { address: getAddress('0x33f20973275b2f574488b18929cd7dcbf1abf275'), name: 'MetaMorpho V1.1 factory' },
};

function summaryOf(results) {
  const s = { pass: 0, fail: 0, inconclusive: 0, notApplicable: 0 };
  for (const r of results) s[r.status === 'not_applicable' ? 'notApplicable' : r.status]++;
  return s;
}

const reports = [];
function report(template, vault, block, secAgo, implementationKey) {
  const r = structuredClone(templates[template]);
  r.address = vault;
  r.blockNumber = String(block);
  r.startedAt = iso(secAgo + 240);
  r.durationMs = 231000;
  r.seed = hx(`seed ${vault} ${block}`);
  r.identity = { ...r.identity, codeHash: hx(`code ${implementationKey}`), implementationKey: hx(implementationKey), proxy: null, implementation: null, implementationKeyKind: { of: 'self', hash: 'metadataHash+maskedCodeHash' } };
  r.summary = summaryOf(r.results);
  const reportHash = keccak256(toHex(canonicalJson(r)));
  const file = `${block}-${reportHash.slice(2, 18)}.json`;
  reports.push({ dir: join('checks', String(CHAIN), vault.toLowerCase()), file, body: r });
  return {
    block: String(block),
    summary: r.summary,
    failed: r.results.filter((x) => x.status === 'fail').map((x) => x.id),
    implementationKey: r.identity.implementationKey,
    reportPath: `certs/checks/${CHAIN}/${vault.toLowerCase()}/${file}`,
    reportHash,
    durationMs: r.durationMs,
  };
}

const outcome = (c) => ({ summary: c.summary, failed: c.failed });
const events = [];
const ev = (secAgo, kind, subject, extra = {}) => events.push({ v: 1, seq: events.length, at: iso(secAgo), kind, chainId: CHAIN, subject, ...extra });

// A Morpho V2 vault, announced by its factory: checked at its deploy block (nothing to deposit into yet), then again after its first deposit.
const deploy = 110930586;
ev(5400, 'detected', V.morpho, { source: 'factory', block: String(deploy), txHash: hx('tx deploy morpho'), factory: FACTORY.morphoV2 });
ev(5395, 'queued', V.morpho, { source: 'factory' });
const m1 = report('maxZero', V.morpho, deploy + 30, 5100, 'impl morpho v2');
ev(5100, 'checked', V.morpho, { source: 'factory', check: m1 });
ev(5080, 'attested', V.morpho, { source: 'factory', check: m1, attestation: { id: '41', txHash: hx('tx attest 41'), supersedes: null } });
ev(5079, 'changed', V.morpho, { source: 'factory', change: { kind: 'new', from: null, to: outcome(m1) } });

// The upgraded vault was known from a backfill; a proxy upgrade re-checks it and it now fails two properties.
const up = 110941200;
ev(4300, 'detected', V.upgraded, { source: 'upgrade', block: String(up), txHash: hx('tx upgrade') });
ev(4299, 'queued', V.upgraded, { source: 'upgrade' });
const u1 = report('mismatch', V.upgraded, up + 25, 4000, 'impl upgraded v2');
ev(4000, 'checked', V.upgraded, { source: 'upgrade', check: u1 });
ev(3990, 'attested', V.upgraded, { source: 'upgrade', check: u1, attestation: { id: '42', txHash: hx('tx attest 42'), supersedes: '30' } });
ev(3989, 'changed', V.upgraded, {
  source: 'upgrade',
  change: { kind: 'regressed', from: { summary: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, failed: [] }, to: outcome(u1) },
});
ev(3985, 'alerted', V.upgraded, { source: 'upgrade', alert: { subscriptionId: '3', subscriber: SUBSCRIBER, channel: 'webhook', ok: false, status: 500 } });
ev(3984, 'alerted', V.upgraded, { source: 'upgrade', alert: { subscriptionId: '3', subscriber: SUBSCRIBER, channel: 'inbox', ok: true } });

// An address that emits Deposit but is not a vault.
ev(3600, 'detected', V.notVault, { source: 'deposit', block: '110947000', txHash: hx('tx deposit notvault') });
ev(3590, 'probe-rejected', V.notVault, { source: 'deposit', reason: 'asset() reverted: not an ERC-4626 vault' });

// A vault no factory announced, found at its first Deposit.
const dep = 110950100;
ev(3000, 'detected', V.curvance, { source: 'deposit', block: String(dep), txHash: hx('tx deposit curvance') });
ev(2999, 'queued', V.curvance, { source: 'deposit' });
const c1 = report('mismatch', V.curvance, dep + 20, 2700, 'impl curvance');
ev(2700, 'checked', V.curvance, { source: 'deposit', check: c1 });
ev(2690, 'attested', V.curvance, { source: 'deposit', check: c1, attestation: { id: '43', txHash: hx('tx attest 43'), supersedes: null } });
ev(2689, 'changed', V.curvance, { source: 'deposit', change: { kind: 'new', from: null, to: outcome(c1) } });

// A check that could not finish.
ev(2400, 'detected', V.broken, { source: 'deposit', block: '110953000', txHash: hx('tx deposit broken') });
ev(2399, 'queued', V.broken, { source: 'deposit' });
ev(2100, 'error', V.broken, { source: 'deposit', reason: 'check failed: forge exited with code 1 (fork RPC timed out)' });

// The Morpho vault took its first deposit: re-checked, every property passes now.
const firstDeposit = 110962000;
ev(1500, 'queued', V.morpho, { source: 'first-deposit', block: String(firstDeposit), txHash: hx('tx first deposit morpho') });
const m2 = report('complete', V.morpho, firstDeposit + 15, 1200, 'impl morpho v2');
ev(1200, 'checked', V.morpho, { source: 'first-deposit', check: m2 });
ev(1190, 'attested', V.morpho, { source: 'first-deposit', check: m2, attestation: { id: '44', txHash: hx('tx attest 44'), supersedes: '41' } });
ev(1189, 'changed', V.morpho, { source: 'first-deposit', change: { kind: 'changed', from: outcome(m1), to: outcome(m2) } });
ev(1185, 'alerted', V.morpho, { source: 'first-deposit', alert: { subscriptionId: '2', subscriber: SUBSCRIBER, channel: 'webhook', ok: true, status: 200 } });

// A scheduled re-check with the same outcome: recorded, no transaction.
const c2 = report('mismatch', V.curvance, 110970000, 600, 'impl curvance');
ev(600, 'checked', V.curvance, { source: 'sweep', check: c2 });
// A subscriber re-check of the Morpho vault, unchanged.
const m3 = report('complete', V.morpho, 110972500, 300, 'impl morpho v2');
ev(300, 'checked', V.morpho, { source: 'subscribed', check: m3 });

// Two new factory finds: one waits in the queue, one is being checked.
ev(120, 'detected', V.euler, { source: 'factory', block: '110976900', txHash: hx('tx deploy euler'), factory: FACTORY.evk });
ev(119, 'queued', V.euler, { source: 'factory' });
ev(90, 'detected', V.metamorpho, { source: 'factory', block: '110977000', txHash: hx('tx deploy metamorpho'), factory: FACTORY.metaMorpho });
ev(89, 'queued', V.metamorpho, { source: 'factory' });

const lastCheck = (c, secAgo) => ({ block: c.block, at: iso(secAgo), reportPath: c.reportPath, summary: c.summary, failed: c.failed, implementationKey: c.implementationKey });
const vaults = {
  v: 1,
  vaults: {
    [V.morpho.toLowerCase()]: { firstSeen: { source: 'factory', block: String(deploy), at: iso(5400) }, deployBlock: String(deploy), lastCheck: lastCheck(m3, 300), lastAttestationId: '44', firstDepositBlock: String(firstDeposit) },
    [V.curvance.toLowerCase()]: { firstSeen: { source: 'deposit', block: String(dep), at: iso(3000) }, deployBlock: null, lastCheck: lastCheck(c2, 600), lastAttestationId: '43', firstDepositBlock: String(dep) },
    [V.upgraded.toLowerCase()]: { firstSeen: { source: 'backfill', block: '110700000', at: iso(86000) }, deployBlock: null, lastCheck: lastCheck(u1, 4000), lastAttestationId: '42', firstDepositBlock: null },
    [V.broken.toLowerCase()]: { firstSeen: { source: 'deposit', block: '110953000', at: iso(2400) }, deployBlock: null, lastCheck: null, lastAttestationId: null, firstDepositBlock: '110953000' },
    [V.euler.toLowerCase()]: { firstSeen: { source: 'factory', block: '110976900', at: iso(120) }, deployBlock: '110976900', lastCheck: null, lastAttestationId: null, firstDepositBlock: null },
    [V.metamorpho.toLowerCase()]: { firstSeen: { source: 'factory', block: '110977000', at: iso(90) }, deployBlock: '110977000', lastCheck: null, lastAttestationId: null, firstDepositBlock: null },
  },
};

const status = {
  v: 1,
  chainId: CHAIN,
  head: '110977320',
  cursor: '110977290',
  lagBlocks: 10,
  startedAt: iso(90000),
  updatedAt: iso(4),
  running: { subject: V.metamorpho, source: 'factory', stage: 'checking', startedAt: iso(60) },
  queue: [
    { subject: V.euler, source: 'factory', enqueuedAt: iso(119) },
    { subject: V.upgraded, source: 'sweep', enqueuedAt: iso(30) },
  ],
  counts: { known: 291, detected24h: 7, checked24h: 6, attested24h: 4, changed24h: 4 },
  sources: [
    { name: 'Euler EVK GenericFactory', address: FACTORY.evk.address, topic0: '0x04e664079117e113faa9684bc14aecb41651cbf098b14eda271248c6d0cda57c', seen: 1 },
    { name: 'Morpho VaultV2Factory', address: FACTORY.morphoV2.address, topic0: '0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e', seen: 1 },
    { name: 'MetaMorpho V1.1 factory', address: FACTORY.metaMorpho.address, topic0: '0xed8c95d05909b0f217f3e68171ef917df4b278d5addfe4dda888e90279be7d1d', seen: 1 },
    { name: 'Euler Earn factory', address: getAddress('0xf463d4acb650cc6c4e1d6cd4d0d1b0cb224094cf'), topic0: '0x2ecfce4fdb2055c9639b56f59c2a14eeafce06a51d93d898155bc11b6141896f', seen: 0 },
    { name: 'Neverland static wrapper factory', address: getAddress('0x81148e8e1d9910080317e11c9f178559ba23bc80'), topic0: '0x7397831292236fdc8043acf7b9d21183e46fd54f9b06bd34210068f95dd378d6', seen: 0 },
    { name: 'ERC-4626 Deposit', address: null, topic0: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7', seen: 1834 },
    { name: 'EIP-1967 Upgraded', address: null, topic0: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', seen: 2 },
    { name: 'EIP-1967 BeaconUpgraded', address: null, topic0: '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e', seen: 0 },
  ],
  attestBudget: { perDay: 40, usedToday: 4 },
  gasCostWei: '208000000000000000',
};

const lines = events.map((e) => JSON.stringify(e));
// Two lines a lenient reader must skip and count: one that is not JSON, one that is JSON but not an event.
lines.splice(8, 0, 'not json at all');
lines.splice(15, 0, JSON.stringify({ v: 1, seq: 'x', kind: 'teleported' }));

if (out === here) await rm(join(out, 'checks'), { recursive: true, force: true });
await mkdir(join(out, String(CHAIN)), { recursive: true });
await writeFile(join(out, String(CHAIN), 'feed.ndjson'), `${lines.join('\n')}\n`);
await writeFile(join(out, String(CHAIN), 'status.json'), `${JSON.stringify(status, null, 2)}\n`);
await writeFile(join(out, String(CHAIN), 'vaults.json'), `${JSON.stringify(vaults, null, 2)}\n`);
for (const r of reports) {
  await mkdir(join(out, r.dir), { recursive: true });
  await writeFile(join(out, r.dir, r.file), `${JSON.stringify(r.body, null, 2)}\n`);
}
console.log(`watch fixtures: ${events.length} events (+2 bad lines), ${Object.keys(vaults.vaults).length} vaults, ${reports.length} reports -> ${out}`);
