import { mkdtemp, mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkAttestationRegistryAbi, checkReportHash, standardCheckReportSchema, suiteHash, suiteOf } from '@specfirst/core';
import { toFunctionSignature, type AbiFunction } from 'viem';
import { candidateFromText, latestVaultReport, reportAtPath, reportHashOf, suiteHashOf, vaultReports } from '../lib/desk/reportFiles';
import { registryReadAbi, readLatestAttestation, readAttestationById } from '../lib/desk/registry';
import type { ReportView } from '../lib/board/types';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'fixtures/board/checks');
const UPSHIFT = '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e';
const UPSHIFT_DIR = path.join(SOURCE, '143', UPSHIFT);

describe('hashes recomputed at request time agree with core', () => {
  it('reportHash and suiteHash of every board fixture', async () => {
    for (const file of ['109195820.json', '109061472.json']) {
      const text = await readFile(path.join(UPSHIFT_DIR, file), 'utf8');
      const parsed = standardCheckReportSchema.parse(JSON.parse(text));
      expect(reportHashOf(JSON.parse(text))).toBe(checkReportHash(parsed));
      expect(suiteHashOf(JSON.parse(text) as ReportView)).toBe(suiteHash(suiteOf(parsed)));
    }
  });

  it('the shape check accepts what core accepts and refuses what is not a report', async () => {
    const text = await readFile(path.join(UPSHIFT_DIR, '109195820.json'), 'utf8');
    expect(candidateFromText(text, `143/${UPSHIFT}/109195820.json`)?.report.blockNumber).toBe('109195820');
    expect(candidateFromText('{"hello":1}', 'x.json')).toBeNull();
    expect(candidateFromText('not json', 'x.json')).toBeNull();
    const forge = await readFile(path.join(UPSHIFT_DIR, '109195820.forge.json'), 'utf8');
    expect(candidateFromText(forge, 'x.forge.json')).toBeNull();
  });
});

describe('reports under certs/checks', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'sf-checks-'));
    // Checksummed directory name, as `cert attest` may write it, plus a newer report and a torn file.
    const vdir = path.join(dir, '143', '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E');
    await mkdir(vdir, { recursive: true });
    await copyFile(path.join(UPSHIFT_DIR, '109061472.json'), path.join(vdir, '109061472.json'));
    await copyFile(path.join(UPSHIFT_DIR, '109195820.forge.json'), path.join(vdir, '109195820.forge.json'));
    const newer = JSON.parse(await readFile(path.join(UPSHIFT_DIR, '109195820.json'), 'utf8'));
    newer.blockNumber = '109400000';
    await writeFile(path.join(vdir, '109400000-0011223344556677.json'), JSON.stringify(newer));
    await writeFile(path.join(vdir, '109500000-torn.json'), '{"schemaVersion":3,');
  });

  it('newest first by block, skipping forge output and unreadable files, in any letter case', async () => {
    const list = await vaultReports(143, UPSHIFT, dir);
    expect(list.map((c) => c.report.blockNumber)).toEqual(['109400000', '109061472']);
    expect(list[0]!.file).toBe('143/0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E/109400000-0011223344556677.json');
    expect((await latestVaultReport('143', UPSHIFT.toUpperCase().replace('0X', '0x'), dir))?.report.blockNumber).toBe('109400000');
  });

  it('refuses bad params and paths outside the checks directory', async () => {
    expect(await vaultReports('143/..', UPSHIFT, dir)).toEqual([]);
    expect(await vaultReports(143, '../../etc', dir)).toEqual([]);
    expect(await reportAtPath('/etc/passwd', '/', dir)).toBeNull();
    expect(await reportAtPath(`../${path.basename(dir)}/x.json`, dir, dir)).toBeNull();
    const inside = await reportAtPath(path.join(dir, '143', '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E', '109061472.json'), '/', dir);
    expect(inside?.report.blockNumber).toBe('109061472');
  });
});

describe('registry fragment', () => {
  it('matches core checkAttestationRegistryAbi for every call the web makes', () => {
    type Param = { type: string; components?: readonly Param[] };
    const strip = (o: Param): unknown => ({ type: o.type, components: o.components?.map(strip) });
    const sig = (abi: readonly unknown[], name: string) => {
      const f = (abi as AbiFunction[]).find((x) => x.type === 'function' && x.name === name)!;
      return { sig: toFunctionSignature(f), outputs: JSON.stringify((f.outputs as readonly Param[]).map(strip)) };
    };
    for (const name of ['latest', 'isCompliant', 'attestationOf']) {
      const mine = sig(registryReadAbi, name);
      const core = sig(checkAttestationRegistryAbi, name);
      expect(mine.sig).toBe(core.sig);
      // Solidity enum Status is uint8 in the ABI either way.
      expect(mine.outputs).toBe(core.outputs);
    }
  });

  const REG = '0x3754918bBB8481D046D80718a9efe434e353daF7' as const;
  const att = {
    subjectChainId: 143n,
    subject: UPSHIFT,
    standardId: '0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab',
    blockNumber: 109400000n,
    implementationKey: `0x${'ef'.repeat(32)}`,
    subjectCodeHash: `0x${'12'.repeat(32)}`,
    suiteHash: `0x${'cd'.repeat(32)}`,
    reportHash: `0x${'ab'.repeat(32)}`,
    passCount: 16,
    failCount: 2,
    inconclusiveCount: 12,
    notApplicableCount: 0,
    issuedAt: 1790755171n,
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    status: 1,
    reportURI: 'https://example.test/r.json',
  };

  it('latest: attested, none (NoAttestation) and unread', async () => {
    const ok = { readContract: async ({ functionName }: { functionName: string }) => (functionName === 'latest' ? [18n, att] : false) };
    const live = await readLatestAttestation(ok, REG, 143, UPSHIFT, { '18': `0x${'9'.repeat(64)}` });
    expect(live).toMatchObject({ kind: 'attested', record: { id: '18', compliant: false, counts: { pass: 16, fail: 2 }, txHash: `0x${'9'.repeat(64)}` } });
    const none = { readContract: async () => Promise.reject({ shortMessage: 'reverted', cause: { data: { errorName: 'NoAttestation' } } }) };
    expect(await readLatestAttestation(none, REG, 143, UPSHIFT)).toEqual({ kind: 'none' });
    const down = { readContract: async () => Promise.reject(new Error('HTTP request failed.\nURL: https://testnet-rpc.monad.xyz')) };
    expect(await readLatestAttestation(down, REG, 143, UPSHIFT)).toEqual({ kind: 'unread', reason: 'HTTP request failed.' });
  });

  it('attestationOf: a record, or null for UnknownAttestation', async () => {
    expect((await readAttestationById({ readContract: async () => att }, REG, 18n))?.blockNumber).toBe('109400000');
    const unknown = { readContract: async () => Promise.reject({ errorName: 'UnknownAttestation' }) };
    expect(await readAttestationById(unknown, REG, 99n)).toBeNull();
  });
});

