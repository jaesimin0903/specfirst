// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { checkAttestationRegistryAbi, standardIdOf } from '@specfirst/core';
import {
  ERC4626_STANDARD_ID,
  attestationViewOf,
  describeReadError,
  readAttestations,
  toRecord,
  txUrl,
  type RawAttestation,
} from '../lib/board/attestations';
import type { RegistryRead } from '../lib/board/types';

const REGISTRY = { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7', rpc: 'https://testnet-rpc.monad.xyz' };
const A = '0x802c91d807A8DaCA257c4708ab264B6520964e44';
const B = '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E';
const H = (b: string) => `0x${b.repeat(32)}`;

function att(subject: string, over: Partial<RawAttestation> = {}): RawAttestation {
  return {
    subjectChainId: 143n,
    subject,
    standardId: ERC4626_STANDARD_ID,
    blockNumber: 109195820n,
    implementationKey: H('11'),
    subjectCodeHash: H('22'),
    suiteHash: H('33'),
    reportHash: H('44'),
    passCount: 30,
    failCount: 0,
    inconclusiveCount: 0,
    notApplicableCount: 0,
    issuedAt: 1790755171n,
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    status: 1,
    reportURI: 'https://example.test/r.json',
    ...over,
  };
}

function registryWith(list: RawAttestation[], opts: { failCompliant?: boolean } = {}) {
  return {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'attestationCount') return BigInt(list.length);
      if (functionName === 'attestationOf') return list[Number(args![0] as bigint)];
      if (functionName === 'latest') {
        const subject = String(args![1]).toLowerCase();
        let id = -1;
        list.forEach((a, i) => {
          if (a.subject.toLowerCase() === subject && a.standardId === args![2]) id = i;
        });
        return [BigInt(id), list[id]] as const;
      }
      if (functionName === 'isCompliant') {
        if (opts.failCompliant) throw new Error('execution reverted');
        return true;
      }
      throw new Error(functionName);
    }),
  };
}

const base = { abi: checkAttestationRegistryAbi, registry: REGISTRY, standardId: ERC4626_STANDARD_ID, now: () => new Date('2026-10-01T00:00:00Z') };

describe('readAttestations', () => {
  it('uses the standardId of "erc4626"', () => {
    expect(standardIdOf('erc4626')).toBe(ERC4626_STANDARD_ID);
  });

  it('reads the latest attestation of each board vault, and only of board vaults', async () => {
    const list = [
      att(A, { status: 2, reportHash: H('aa') }),
      att(A, { reportHash: H('bb') }),
      att('0x0000000000000000000000000000000000000abc'),
      att(B, { standardId: H('99') }),
    ];
    const client = registryWith(list);
    const r = await readAttestations({ ...base, client, subjects: [{ chainId: 143, address: A }, { chainId: 143, address: B }], txHashes: { '1': '0xfeed' } });
    expect(r.registry).toMatchObject({ status: 'ok', attestationCount: 4, error: null, readAt: '2026-10-01T00:00:00.000Z' });
    expect([...r.bySubject.keys()]).toEqual([`143/${A.toLowerCase()}`]);
    expect(r.bySubject.get(`143/${A.toLowerCase()}`)).toMatchObject({ id: '1', status: 'Valid', reportHash: H('bb'), compliant: true, txHash: '0xfeed' });
    const names = client.readContract.mock.calls.map((c) => (c[0] as { functionName: string }).functionName);
    // 1 count + 4 attestationOf + (latest + isCompliant) for the one board vault that has one.
    expect(names.filter((n) => n === 'attestationOf')).toHaveLength(4);
    expect(names.filter((n) => n === 'latest')).toHaveLength(1);
    expect(names.filter((n) => n === 'isCompliant')).toHaveLength(1);
  });

  it('reads only the most recent attestations past the cap', async () => {
    const list = [att(B), att(A)];
    const client = registryWith(list);
    const r = await readAttestations({ ...base, client, maxAttestations: 1, subjects: [{ chainId: 143, address: A }, { chainId: 143, address: B }] });
    expect([...r.bySubject.keys()]).toEqual([`143/${A.toLowerCase()}`]);
  });

  it('keeps the attestation when only isCompliant fails', async () => {
    const r = await readAttestations({ ...base, client: registryWith([att(A)], { failCompliant: true }), subjects: [{ chainId: 143, address: A }] });
    expect(r.registry.status).toBe('ok');
    expect(r.bySubject.get(`143/${A.toLowerCase()}`)!.compliant).toBeNull();
  });

  it('turns any other failure into status "error" and never throws', async () => {
    const client = { readContract: vi.fn(async () => Promise.reject(new Error('fetch failed https://secret.example/rpc/key123\nmore'))) };
    const r = await readAttestations({ ...base, client, subjects: [{ chainId: 143, address: A }] });
    expect(r.registry).toMatchObject({ status: 'error', error: 'fetch failed <rpc>', attestationCount: null });
    expect(r.bySubject.size).toBe(0);
  });

  it('does not call the registry without a client', async () => {
    const r = await readAttestations({ ...base, client: null, skippedBecause: 'offline', subjects: [{ chainId: 143, address: A }] });
    expect(r.registry).toMatchObject({ status: 'skipped', error: 'offline', readAt: null });
  });
});

describe('attestationViewOf and helpers', () => {
  const ok: RegistryRead = { ...REGISTRY, status: 'ok', error: null, attestationCount: 1, readAt: 'x' };
  const record = toRecord(0n, att(A), true);

  it('unread, none and attested', () => {
    expect(attestationViewOf({ ...ok, status: 'error', error: 'HTTP request failed.' }, record, { reportHash: H('44'), suiteHash: H('33') })).toEqual({
      kind: 'unread',
      reason: 'HTTP request failed.',
    });
    expect(attestationViewOf(ok, undefined, { reportHash: H('44'), suiteHash: H('33') })).toEqual({ kind: 'none' });
    expect(attestationViewOf(ok, record, { reportHash: H('44'), suiteHash: H('33') })).toMatchObject({ kind: 'attested', matchesReport: true, suiteMatches: true });
    expect(attestationViewOf(ok, record, { reportHash: H('45'), suiteHash: H('34') })).toMatchObject({ kind: 'attested', matchesReport: false, suiteMatches: false });
  });

  it('toRecord maps status and time', () => {
    expect(record).toMatchObject({ id: '0', status: 'Valid', blockNumber: '109195820', issuedAt: '2026-09-30T07:59:31.000Z', counts: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 } });
    expect(toRecord(3n, att(A, { status: 3n }), false).status).toBe('Revoked');
  });

  it('describeReadError and txUrl', () => {
    expect(describeReadError({ shortMessage: 'HTTP request failed.', message: 'long' })).toBe('HTTP request failed.');
    expect(describeReadError('x'.repeat(300))).toHaveLength(200);
    expect(txUrl('0xabc')).toBe('https://testnet.monadscan.com/tx/0xabc');
  });
});
