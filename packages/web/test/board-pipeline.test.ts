// @vitest-environment node
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { checkAttestationRegistryAbi } from '@specfirst/core';
import { assembleBoard, buildBoard, collectReports, readVaultMeta } from '../lib/board/pipeline';
import { compareCandidates, pickLatest, vaultStatusOf, type CheckCandidate } from '../lib/board/aggregate';
import { ERC4626_STANDARD_ID, type RawAttestation, type RegistryReader } from '../lib/board/attestations';
import type { BoardData, VaultDetail } from '../lib/board/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'fixtures/board/checks');
const META = path.join(here, 'fixtures/board/vault-meta.json');
const REGISTRY = { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7', rpc: 'https://testnet-rpc.monad.xyz' };
const STEAKHOUSE = '0x802c91d807a8daca257c4708ab264b6520964e44';
const UPSHIFT = '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e';
const EULER_KEY = '0xdd21af250ff5c7001b35031d24abc55fd472370cf156a4146fe35134139c1901';
const TX = '0x7a4c1d630a9a50cc6ef107db21e71a01d2c2789379b5f7db2f2bfb840c2e87d9';
const NOW = () => new Date('2026-10-01T00:00:00Z');

function rawAttestation(reportHash: string, suiteHash: string): RawAttestation {
  return {
    subjectChainId: 143n,
    subject: '0x802c91d807A8DaCA257c4708ab264B6520964e44',
    standardId: ERC4626_STANDARD_ID,
    blockNumber: 109195820n,
    implementationKey: '0x5932735a3ad348e91b85f573ef3a695add85fb2d526a61a469b12bbb0e92523f',
    subjectCodeHash: '0xd72b833e36a8225b59f47bf98e45255d1fee31f2a7cd48380271e23c2cfe5406',
    suiteHash,
    reportHash,
    passCount: 30,
    failCount: 0,
    inconclusiveCount: 0,
    notApplicableCount: 0,
    issuedAt: 1790755171n,
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    status: 1,
    reportURI: 'https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks/143/0x802c91d807a8daca257c4708ab264b6520964e44/109195820-c63e8b93ea94d54b.json',
  };
}

/** A registry with one attestation, of the Steakhouse report in the fixtures. */
async function oneAttestationClient(): Promise<RegistryReader & { readContract: ReturnType<typeof vi.fn> }> {
  const { candidates } = await collectReports(SOURCE);
  const c = candidates.find((x) => x.report.address.toLowerCase() === STEAKHOUSE)!;
  const att = rawAttestation(c.reportHash, c.suiteHash);
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'attestationCount') return 1n;
      if (functionName === 'attestationOf') return att;
      if (functionName === 'latest') return [0n, att] as const;
      if (functionName === 'isCompliant') return true;
      throw new Error(`unexpected ${functionName}`);
    }),
  };
}

async function build(client: RegistryReader | null, opts: { source?: string; skippedBecause?: string } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'sf-board-'));
  const dataDir = path.join(root, 'data');
  const publicDir = path.join(root, 'public');
  const result = await buildBoard({
    sourceDir: opts.source ?? SOURCE,
    sourceLabel: 'fixtures',
    dataDir,
    publicDir,
    meta: await readVaultMeta(META),
    registry: REGISTRY,
    client,
    skippedBecause: opts.skippedBecause,
    abi: checkAttestationRegistryAbi,
    standardId: ERC4626_STANDARD_ID,
    txHashes: { '0': TX },
    now: NOW,
  });
  const board = JSON.parse(await readFile(path.join(dataDir, 'board.json'), 'utf8')) as BoardData;
  return { root, dataDir, publicDir, result, board };
}

describe('collectReports', () => {
  it('reads valid reports, ignores forge output and lists what it skipped', async () => {
    const { candidates, skipped, sourceExists } = await collectReports(SOURCE);
    expect(sourceExists).toBe(true);
    expect(candidates).toHaveLength(8);
    expect(candidates.every((c) => /^0x[0-9a-f]{64}$/.test(c.reportHash) && /^0x[0-9a-f]{64}$/.test(c.suiteHash))).toBe(true);
    expect(candidates.some((c) => c.file.endsWith('.forge.json'))).toBe(false);
    expect(skipped.map((s) => s.file).sort()).toEqual([
      '143/0x1111111111111111111111111111111111111111/109195820.json',
      '143/0x2222222222222222222222222222222222222222/109195820.json',
      '143/0x3333333333333333333333333333333333333333/notes.json',
    ]);
    expect(skipped.find((s) => s.file.includes('0x1111'))!.error).toBe('not JSON');
    expect(skipped.find((s) => s.file.includes('0x2222'))!.error).toMatch(/lies under 143\/0x2222/);
    expect(skipped.find((s) => s.file.includes('0x3333'))!.error).toMatch(/not a StandardCheckReport/);
  });

  it('treats a missing source directory as empty, not as an error', async () => {
    const r = await collectReports(path.join(here, 'fixtures/board/does-not-exist'));
    expect(r).toEqual({ candidates: [], skipped: [], sourceExists: false });
  });
});

describe('latest report per vault', () => {
  it('keeps the higher block (schemaVersion 1 at 109061472 loses to 109195820)', async () => {
    const { candidates } = await collectReports(SOURCE);
    const upshift = candidates.filter((c) => c.report.address.toLowerCase() === UPSHIFT);
    expect(upshift.map((c) => c.report.blockNumber).sort()).toEqual(['109061472', '109195820']);
    const latest = pickLatest(candidates);
    expect(latest).toHaveLength(7);
    expect(latest.find((c) => c.report.address.toLowerCase() === UPSHIFT)!.file).toBe(`143/${UPSHIFT}/109195820.json`);
  });

  it('breaks a tie on the same block by startedAt, then by file name', async () => {
    const { candidates } = await collectReports(SOURCE);
    const base = candidates.find((c) => c.report.address.toLowerCase() === STEAKHOUSE)!;
    const later: CheckCandidate = { ...base, file: `143/${STEAKHOUSE}/a.json`, report: { ...base.report, startedAt: '2030-01-01T00:00:00.000Z' } };
    expect(pickLatest([base, later])[0]!.file).toBe(later.file);
    expect(pickLatest([later, base])[0]!.file).toBe(later.file);
    const sameTime: CheckCandidate = { ...base, file: `143/${STEAKHOUSE}/zzz.json` };
    expect(compareCandidates(sameTime, base)).toBeLessThan(0);
  });
});

describe('buildBoard', () => {
  it('writes board.json with totals, groups, protocols and reasons', async () => {
    const { board, result } = await build(await oneAttestationClient());
    expect(result.sourceExists).toBe(true);
    expect(board.totals).toEqual({
      vaults: 7,
      implementations: 5,
      complete: 2,
      mismatch: 2,
      mismatchImplementations: 2,
      partial: 1,
      notApplicable: 2,
      attested: 1,
      unchecked: 1,
    });
    expect(board.blocks).toEqual([{ chainId: 143, blockNumber: '109195820', vaults: 7 }]);
    expect(board.runs).toEqual([16]);
    expect(board.properties).toHaveLength(30);
    expect(board.properties.filter((p) => p.origin === 'specfirst').map((p) => p.id)).toEqual([
      'sf-maxDeposit-honored',
      'sf-maxMint-honored',
      'sf-maxWithdraw-honored',
      'sf-maxRedeem-honored',
    ]);
    expect(board.propertyTotals.pass + board.propertyTotals.fail + board.propertyTotals.inconclusive + board.propertyTotals.notApplicable).toBe(7 * 30);
    expect(board.skipped).toHaveLength(3);
  });

  it('groups vaults by implementationKey, largest group first', async () => {
    const { board } = await build(null);
    expect(board.groups[0]!.key).toBe(EULER_KEY);
    expect(board.groups[0]!.vaultIds).toHaveLength(3);
    expect(board.groups[0]!.statusCounts).toEqual({ mismatch: 1, complete: 1, partial: 0, not_applicable: 1 });
    expect(board.groups[0]!.vaultIds[0]).toBe('143/0xd8ec5b4917fef9058545e7d1dc2ac17f1d26305d');
    expect(board.groups.reduce((n, g) => n + g.vaultIds.length, 0)).toBe(7);
    const euler = board.vaults.filter((r) => r.implementationKey === EULER_KEY);
    expect(euler.every((r) => r.groupSize === 3)).toBe(true);
    expect(board.vaults.find((r) => r.id === `143/${UPSHIFT}`)!.groupSize).toBe(1);
  });

  it('puts mismatches first and carries metadata, status and cells into each row', async () => {
    const { board } = await build(null);
    expect(board.vaults.slice(0, 2).map((r) => r.status)).toEqual(['mismatch', 'mismatch']);
    const upshift = board.vaults.find((r) => r.id === `143/${UPSHIFT}`)!;
    expect(upshift).toMatchObject({ name: 'earnAUSD', protocol: 'Upshift', assetSymbol: 'AUSD', status: 'mismatch', blockNumber: '109195820' });
    expect(upshift.cells).toHaveLength(30);
    expect(upshift.cells.slice(-2)).toBe('ff');
    expect(upshift.failed.map((f) => f.id)).toEqual(['sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    expect(upshift.reportPath).toBe(`/reports/143/${UPSHIFT}/109195820.json`);
    const unnamed = board.vaults.find((r) => r.id === '143/0x0f9ba9d0f2f9289efbc2b8505932b458c3cdcf64')!;
    expect(unnamed.name).toBeNull();
    expect(unnamed.status).toBe('complete');
    const noMeta = board.vaults.find((r) => r.id === '143/0xea4be2705517b0ee0bbabd5e73cea3dc509d3c36')!;
    expect(noMeta).toMatchObject({ protocol: null, status: 'not_applicable', skipReason: 'asset-transfer-restricted' });
    const sevenFive = board.vaults.find((r) => r.id === '143/0x082c62088669facc1fa9f056c5efc8cbccda39b2')!;
    expect(sevenFive).toMatchObject({ status: 'not_applicable', vaultKind: 'erc7575', skipReason: 'separate-share-token' });
  });

  it('tallies unexercised properties per reason', async () => {
    const { board } = await build(null);
    const by = Object.fromEntries(board.reasons.map((r) => [r.category, r]));
    expect(by['max-zero']).toEqual({ category: 'max-zero', vaults: 1, properties: 4 });
    expect(by['separate-share-token']).toEqual({ category: 'separate-share-token', vaults: 1, properties: 30 });
    expect(by['asset-transfer-restricted']).toEqual({ category: 'asset-transfer-restricted', vaults: 1, properties: 30 });
    expect(by['inputs-rejected']!.vaults).toBeGreaterThanOrEqual(1);
    const partial = board.vaults.find((r) => r.status === 'partial')!;
    expect(vaultStatusOf(partial.summary)).toBe('partial');
    expect(partial.reasonCategories).toEqual(['max-zero']);
  });

  it('merges the onchain attestation and compares it with the report on the board', async () => {
    const client = await oneAttestationClient();
    const { board, dataDir } = await build(client);
    expect(board.registry).toMatchObject({ status: 'ok', attestationCount: 1, error: null });
    const calls = client.readContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    expect(calls.sort()).toEqual(['attestationCount', 'attestationOf', 'isCompliant', 'latest']);
    const row = board.vaults.find((r) => r.id === `143/${STEAKHOUSE}`)!;
    expect(row.attestation).toMatchObject({ kind: 'attested', id: '0', status: 'Valid', compliant: true, matchesReport: true, suiteMatches: true, txHash: TX });
    expect(board.vaults.filter((r) => r.attestation.kind === 'none')).toHaveLength(6);
    const detail = JSON.parse(await readFile(path.join(dataDir, 'vaults/143', `${STEAKHOUSE}.json`), 'utf8')) as VaultDetail;
    expect(detail.row.attestation.kind).toBe('attested');
    expect(detail.reportHash).toBe((row.attestation as { reportHash: string }).reportHash);
  });

  it('does not fail when the registry cannot be read: every vault shows "could not read"', async () => {
    const client = { readContract: vi.fn(async () => Promise.reject(new Error('HTTP request failed.\nURL: https://testnet-rpc.monad.xyz\nStatus: 503'))) };
    const { board, dataDir } = await build(client);
    expect(board.registry.status).toBe('error');
    expect(board.registry.error).toBe('HTTP request failed.');
    expect(board.totals.vaults).toBe(7);
    expect(board.totals.attested).toBe(0);
    expect(board.vaults.every((r) => r.attestation.kind === 'unread')).toBe(true);
    const detail = JSON.parse(await readFile(path.join(dataDir, 'vaults/143', `${UPSHIFT}.json`), 'utf8')) as VaultDetail;
    expect(detail.row.attestation).toEqual({ kind: 'unread', reason: 'HTTP request failed.' });
    expect(detail.registry.status).toBe('error');
  });

  it('skips the registry when told to, and says why', async () => {
    const { board } = await build(null, { skippedBecause: 'registry reading switched off (--offline)' });
    expect(board.registry).toMatchObject({ status: 'skipped', error: 'registry reading switched off (--offline)', readAt: null });
    expect(board.vaults[0]!.attestation).toEqual({ kind: 'unread', reason: 'registry reading switched off (--offline)' });
  });

  it('writes one detail file per vault and serves the original report bytes', async () => {
    const { dataDir, publicDir, board } = await build(null);
    expect((await readdir(path.join(dataDir, 'vaults/143'))).sort()).toEqual(board.vaults.map((r) => `${r.id.split('/')[1]}.json`).sort());
    const served = await readFile(path.join(publicDir, 'reports/143', UPSHIFT, '109195820.json'), 'utf8');
    const original = await readFile(path.join(SOURCE, '143', UPSHIFT, '109195820.json'), 'utf8');
    expect(served).toBe(original);
    await expect(readdir(path.join(publicDir, 'reports/143', UPSHIFT))).resolves.toEqual(['109195820.json']);
    const detail = JSON.parse(await readFile(path.join(dataDir, 'vaults/143', '0xd8ec5b4917fef9058545e7d1dc2ac17f1d26305d.json'), 'utf8')) as VaultDetail;
    expect(detail.siblings.map((s) => s.id).sort()).toEqual(['143/0x0f9ba9d0f2f9289efbc2b8505932b458c3cdcf64', '143/0xea4be2705517b0ee0bbabd5e73cea3dc509d3c36']);
  });

  it('writes an empty board without touching the registry when there are no reports', async () => {
    const client = { readContract: vi.fn() };
    const { board, result } = await build(client, { source: path.join(here, 'fixtures/board/does-not-exist') });
    expect(result.sourceExists).toBe(false);
    expect(client.readContract).not.toHaveBeenCalled();
    expect(board.vaults).toEqual([]);
    expect(board.totals.vaults).toBe(0);
    expect(board.totals.unchecked).toBe(7);
    expect(board.registry.status).toBe('skipped');
  });
});

describe('assembleBoard', () => {
  it('is pure: the same inputs give the same board', async () => {
    const { candidates, skipped } = await collectReports(SOURCE);
    const input = {
      candidates,
      meta: await readVaultMeta(META),
      registry: { ...REGISTRY, status: 'skipped' as const, error: 'off', attestationCount: null, readAt: null },
      attestations: new Map(),
      generatedAt: '2026-10-01T00:00:00.000Z',
      source: 'fixtures',
      skipped,
    };
    // latestFiles follows input order on purpose (it is only a copy list); what the pages read must not.
    const a = assembleBoard(input);
    const b = assembleBoard({ ...input, candidates: [...candidates].reverse() });
    expect(b.board).toEqual(a.board);
    expect(b.details).toEqual(a.details);
    expect([...b.latestFiles].sort()).toEqual([...a.latestFiles].sort());
  });
});
