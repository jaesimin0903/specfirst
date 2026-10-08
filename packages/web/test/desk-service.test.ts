import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import type { ContractReader } from '../lib/desk/read';

/*
 * The server side end to end, with the chain mocked: board data built into a temp dir, a report written after
 * the build under a temp certs/checks, a worker status.json, and a reader that answers the desk and the registry.
 */

const reader = vi.hoisted(() => ({ current: null as unknown as ContractReader }));
vi.mock('../lib/desk/clients', () => ({ testnetClient: () => reader.current, mainnetClient: () => reader.current }));

import { buildBoard, readVaultMeta } from '../lib/board/pipeline';
import { clearMemo } from '../lib/desk/cache';
import { deskView, requestView } from '../lib/desk/service';
import { resolveVault } from '../lib/desk/vault';
import { reportHashOf } from '../lib/desk/reportFiles';
import { failureLevelOf } from '../lib/board/levels';
import { vaultLabel, verdictSentence } from '../lib/board/reasons';
import { vaultApiResponseSchema } from '../lib/desk/vaultApi';
import { GET as vaultApi } from '../app/api/v1/vaults/[chainId]/[address]/route';
import { GET as badgeRoute } from '../app/badge/check/[chainId]/[address]/route';
import { GET as reportRoute } from '../app/api/v1/reports/[chainId]/[address]/[file]/route';
import { GET as requestRoute } from '../app/api/desk/requests/[id]/route';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, 'fixtures/board');
const UPSHIFT = '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e';
const UPSHIFT_CS = '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E';
const STEAKHOUSE = '0x802c91d807a8daca257c4708ab264b6520964e44';
const DESK = '0x00000000000000000000000000000000000D35c0';
const REQUESTER = '0x1111111111111111111111111111111111111111';
const FEE = 10n ** 17n;
const T0 = Math.floor(Date.now() / 1000) - 300;
const ATTEST_TX = `0x${'a1'.repeat(32)}`;
const FULFIL_TX = `0x${'f1'.repeat(32)}`;
const NEW_FILE = '109400000-0011223344556677.json';

let root: string;
let newerHash: string;
const env = { ...process.env };

function req(status: number, subject: string, over: Record<string, unknown> = {}) {
  return { requester: REQUESTER, subjectChainId: 143n, subject, standardId: keccak256(toHex('erc4626')), fee: FEE, requestedAt: BigInt(T0), status, attestationId: 0n, rejectReason: `0x${'0'.repeat(64)}`, ...over };
}

function attestation(reportHash: string, counts: [number, number, number, number]) {
  return {
    subjectChainId: 143n,
    subject: UPSHIFT_CS,
    standardId: keccak256(toHex('erc4626')),
    blockNumber: 109400000n,
    implementationKey: `0x${'ef'.repeat(32)}`,
    subjectCodeHash: `0x${'12'.repeat(32)}`,
    suiteHash: `0x${'cd'.repeat(32)}`,
    reportHash,
    passCount: counts[0],
    failCount: counts[1],
    inconclusiveCount: counts[2],
    notApplicableCount: counts[3],
    issuedAt: BigInt(T0 + 200),
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    status: 1,
    reportURI: 'https://example.test/r.json',
  };
}

function chain(): ContractReader {
  const requests: Record<string, unknown> = {
    '0': req(2, UPSHIFT_CS, { attestationId: 18n }),
    '1': req(1, STEAKHOUSE),
    '2': req(3, STEAKHOUSE, { rejectReason: `0x${Buffer.from('check-failed').toString('hex').padEnd(64, '0')}` }),
  };
  return {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case 'fee':
          return FEE;
        case 'timeout':
          return 3600n;
        case 'requestCount':
          return 3n;
        case 'earned':
          return FEE;
        case 'withdrawn':
          return 0n;
        case 'escrowed':
          return FEE;
        case 'owner':
        case 'worker':
          return REQUESTER;
        case 'registry':
          return '0x3754918bBB8481D046D80718a9efe434e353daF7';
        case 'requestOf': {
          const r = requests[String(args![0])];
          if (!r) throw Object.assign(new Error('reverted'), { cause: { data: { errorName: 'UnknownRequest' } } });
          return r;
        }
        case 'attestationOf':
          return attestation(newerHash, [16, 2, 12, 0]);
        case 'latest':
          if (String(args![1]).toLowerCase() !== UPSHIFT) throw Object.assign(new Error('reverted'), { cause: { data: { errorName: 'NoAttestation' } } });
          return [18n, attestation(newerHash, [16, 2, 12, 0])];
        case 'isCompliant':
          return false;
        default:
          throw new Error(`unexpected ${functionName}`);
      }
    }),
  };
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'sf-desk-'));
  const meta = await readVaultMeta(path.join(FIXTURES, 'vault-meta.json'));
  await writeFile(path.join(root, 'placeholder'), '');
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data', 'vault-meta.json'), JSON.stringify(meta));
  await buildBoard({
    sourceDir: path.join(FIXTURES, 'checks'),
    dataDir: path.join(root, 'data'),
    publicDir: path.join(root, 'public'),
    meta,
    registry: { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7', rpc: 'x' },
    client: null,
    abi: [],
    standardId: keccak256(toHex('erc4626')),
    now: () => new Date('2026-09-30T00:00:00Z'),
  });
  // A check someone paid for after the build: same vault, later block.
  const newer = JSON.parse(await readFile(path.join(FIXTURES, 'checks', '143', UPSHIFT, '109195820.json'), 'utf8'));
  newer.blockNumber = '109400000';
  newerHash = reportHashOf(newer);
  const dir = path.join(root, 'checks', '143', UPSHIFT);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, NEW_FILE), JSON.stringify(newer, null, 2));
  await mkdir(path.join(root, '.specfirst', 'worker'), { recursive: true });
  await writeFile(
    path.join(root, '.specfirst', 'worker', 'status.json'),
    JSON.stringify({
      '0': { stage: 'fulfilled', updatedAt: new Date((T0 + 240) * 1000).toISOString(), attestationId: '18', reportPath: `checks/143/${UPSHIFT}/${NEW_FILE}`, txs: { attest: ATTEST_TX, fulfill: FULFIL_TX }, gasCostWei: '3000000000000000' },
      '1': { stage: 'running', updatedAt: new Date((T0 + 60) * 1000).toISOString(), txs: {} },
      '2': { stage: 'rejected', updatedAt: new Date((T0 + 60) * 1000).toISOString(), txs: {}, error: 'forge exited 1' },
      totals: { gasCostWei: '4000000000000000', fulfilled: 1, rejected: 1 },
    }),
  );
  Object.assign(process.env, {
    SPECFIRST_REPO_ROOT: root,
    SPECFIRST_BOARD_DATA: path.join(root, 'data'),
    SPECFIRST_CHECKS_DIR: path.join(root, 'checks'),
    NEXT_PUBLIC_SPECFIRST_DESK_10143: DESK,
  });
});

afterAll(() => {
  process.env = env;
});

beforeEach(() => {
  clearMemo();
  reader.current = chain();
});

describe('requestView', () => {
  it('fulfilled: timeline done, the result from the attested report, tx hashes from the worker', async () => {
    const v = await requestView(0n);
    if ('error' in v) throw new Error(v.error);
    expect(v.request).toMatchObject({ id: '0', status: 'Fulfilled', subject: UPSHIFT_CS, feeWei: FEE.toString(), attestationId: '18' });
    expect(v.vault).toEqual({ name: 'earnAUSD', protocol: 'Upshift', assetSymbol: 'AUSD' });
    expect(v.progress).toMatchObject({ outcome: 'fulfilled', terminal: true });
    expect(v.worker).toMatchObject({ available: true, stage: 'fulfilled', txs: { attest: ATTEST_TX, fulfill: FULFIL_TX } });
    const r = v.result!;
    expect(r).toMatchObject({
      vaultPath: `/v/143/${UPSHIFT}`,
      badgePath: `/badge/check/143/${UPSHIFT}.svg`,
      apiPath: `/api/v1/vaults/143/${UPSHIFT}`,
      status: 'mismatch',
      total: 30,
      split: 26,
      blockNumber: '109400000',
      reportHash: newerHash,
      reportPath: `/api/v1/reports/143/${UPSHIFT}/${NEW_FILE}`,
      attestation: { id: '18', status: 'Valid', isCompliant: false, matchesReport: true, txHash: ATTEST_TX },
    });
    expect(r.cells).toHaveLength(30);
    expect(r.failed.map((f) => f.id)).toEqual(['sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    expect(r.failed.map((f) => f.topic)).toEqual(['must', 'must']);
    expect(r.reproduce).toBe(`specfirst check ${UPSHIFT_CS} --standard erc4626 --block 109400000 --runs 16 --seed ${JSON.parse(await readFile(path.join(root, 'checks', '143', UPSHIFT, NEW_FILE), 'utf8')).seed}`);
  });

  describe('MUST and SHOULD levels, as the board reads them', () => {
    // tyYIELD of test/fixtures/levels, three round trips off by 1 base unit, fulfilled as request 5.
    const TY = '0xb4641064f64e2f3aaffc1b4b4a66be75c1c81408';
    const TY_CS = '0xB4641064f64E2F3aAffc1b4b4A66BE75c1C81408';
    const TY_FILE = '109195820-aabbccddeeff0011.json';
    const statusFile = () => path.join(root, '.specfirst', 'worker', 'status.json');
    let tyHash: string;
    let workerStatus: string;

    beforeAll(async () => {
      const text = await readFile(path.join(here, 'fixtures/levels/143', TY, '109195820.json'), 'utf8');
      tyHash = reportHashOf(JSON.parse(text));
      await mkdir(path.join(root, 'checks', '143', TY), { recursive: true });
      await writeFile(path.join(root, 'checks', '143', TY, TY_FILE), text);
      workerStatus = await readFile(statusFile(), 'utf8');
    });

    afterEach(async () => {
      await writeFile(statusFile(), workerStatus);
    });

    /** The desk worker's record of request 5, naming `reportPath`. */
    async function workerNames(reportPath: string) {
      const s = JSON.parse(workerStatus);
      s['5'] = { stage: 'fulfilled', updatedAt: new Date((T0 + 240) * 1000).toISOString(), attestationId: '19', reportPath, txs: {} };
      await writeFile(statusFile(), JSON.stringify(s));
    }

    /** The usual chain, with request 5 for tyYIELD whose attestation hashes `attested` (none when null). */
    function withTy(attested: () => string | null): ContractReader {
      const base = chain();
      return {
        readContract: vi.fn(async (a: { functionName: string; args?: readonly unknown[] }) => {
          if (a.functionName === 'requestOf' && String(a.args![0]) === '5') return req(2, TY_CS, { attestationId: 19n });
          if (a.functionName === 'attestationOf' && String(a.args![0]) === '19') {
            const h = attested();
            if (!h) throw Object.assign(new Error('reverted'), { cause: { data: { errorName: 'UnknownAttestation' } } });
            return { ...attestation(h, [27, 3, 0, 0]), subject: TY_CS, blockNumber: 109195820n };
          }
          return base.readContract(a as never);
        }),
      } as ContractReader;
    }

    it('the attested report: each failure with its class, so the chip and the verdict read rounding', async () => {
      reader.current = withTy(() => tyHash);
      const v = await requestView(5n);
      if ('error' in v) throw new Error(v.error);
      const r = v.result!;
      expect(r).toMatchObject({ status: 'mismatch', reportHash: tyHash, attestation: { id: '19', matchesReport: true } });
      expect(r.failed.map((f) => [f.id, f.topic, f.delta])).toEqual([
        ['RT-redeem-deposit', 'rounding', '1'],
        ['RT-redeem-mint', 'rounding', '1'],
        ['RT-withdraw-deposit', 'rounding', '1'],
      ]);
      expect(r.failed[0]!.finding).toMatch(/the round trip ended 1 base unit in the caller's favor/);
      expect(r.failed[0]!.rule).toMatch(/That is a SHOULD, not a MUST/);
      expect(vaultLabel(r.status, failureLevelOf(r.failed))).toBe('Rounding favors caller');
      expect(verdictSentence(r.status, r.summary, r.blockNumber, r.failed)).toMatch(/^Rounding favors the caller: 3 round-trip properties fail .*, by at most 1 base unit, <0\.01% of the amount; no MUST sentence failed\.$/);
    });

    it('a report nobody named (the attestation hashes another, no worker record, not on the board): the ids alone, never rounding', async () => {
      reader.current = withTy(() => newerHash);
      const v = await requestView(5n);
      if ('error' in v) throw new Error(v.error);
      const r = v.result!;
      expect(r).toMatchObject({ reportHash: tyHash, attestation: { matchesReport: false } });
      expect(r.failed.map((f) => f.topic)).toEqual([undefined, undefined, undefined]);
      expect(r.failed[0]!.rule).toBeNull();
      expect(failureLevelOf(r.failed)).toBe('should');
      expect(vaultLabel(r.status, failureLevelOf(r.failed))).toBe('Spec mismatch');
    });

    it("the desk worker's report, when no attestation was read: named, so its levels are read", async () => {
      await workerNames(`checks/143/${TY}/${TY_FILE}`);
      reader.current = withTy(() => null);
      const v = await requestView(5n);
      if ('error' in v) throw new Error(v.error);
      expect(v.result).toMatchObject({ reportHash: tyHash });
      expect(failureLevelOf(v.result!.failed)).toBe('rounding');
    });

    it("the desk worker's report under an attestation that hashes another: shown, but its levels are not read", async () => {
      await workerNames(`checks/143/${TY}/${TY_FILE}`);
      reader.current = withTy(() => newerHash);
      const v = await requestView(5n);
      if ('error' in v) throw new Error(v.error);
      expect(v.result).toMatchObject({ reportHash: tyHash, attestation: { id: '19', matchesReport: false } });
      expect(v.result!.failed.map((f) => f.topic)).toEqual([undefined, undefined, undefined]);
      expect(vaultLabel(v.result!.status, failureLevelOf(v.result!.failed))).toBe('Spec mismatch');
    });

    it("a worker reportPath that names another vault's report is not this request's result", async () => {
      await workerNames(`checks/143/${UPSHIFT}/${NEW_FILE}`);
      reader.current = withTy(() => null);
      const v = await requestView(5n);
      if ('error' in v) throw new Error(v.error);
      // The latest report of tyYIELD instead, a fallback nobody named.
      expect(v.result).toMatchObject({ reportHash: tyHash, vaultPath: `/v/143/${TY}` });
      expect(v.result!.failed.map((f) => f.topic)).toEqual([undefined, undefined, undefined]);
    });
  });

  it('pending: where the worker is, and no result yet', async () => {
    const v = await requestView(1n);
    if ('error' in v) throw new Error(v.error);
    expect(v.progress).toMatchObject({ activeKey: 'running', terminal: false, refundable: false, source: 'chain+worker' });
    expect(v.result).toBeNull();
    expect(v.timeoutSec).toBe('3600');
  });

  it('rejected: the code in words; unknown id and a missing desk are distinct answers', async () => {
    const v = await requestView(2n);
    if ('error' in v) throw new Error(v.error);
    expect(v.progress).toMatchObject({ outcome: 'rejected', rejectCode: 'check-failed' });
    expect(await requestView(9n)).toEqual({ error: 'not-found' });
    const desk = process.env.NEXT_PUBLIC_SPECFIRST_DESK_10143;
    delete process.env.NEXT_PUBLIC_SPECFIRST_DESK_10143;
    expect(await requestView(0n)).toEqual({ error: 'not-deployed' });
    process.env.NEXT_PUBLIC_SPECFIRST_DESK_10143 = desk;
  });

  it('the route answers 400, 404 and 200', async () => {
    const call = (id: string) => requestRoute(new Request(`http://localhost/api/desk/requests/${id}`), { params: Promise.resolve({ id }) });
    expect((await call('abc')).status).toBe(400);
    expect((await call('9')).status).toBe(404);
    const ok = await call('1');
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('deskView', () => {
  it('counts, money and the one-line summary', async () => {
    const d = await deskView();
    expect(d.summary).toMatchObject({ deployed: true, address: DESK, feeWei: FEE.toString(), requestCount: '3', earnedWei: FEE.toString() });
    expect(d.economics.counts).toMatchObject({ total: 3, fulfilled: 1, pending: 1, rejected: 1, refunded: 0 });
    expect(d.economics.gasCostWei).toBe('4000000000000000');
    expect(d.economics.netWei).toBe((FEE - 4_000_000_000_000_000n).toString());
    expect(d.economics.summary).toBe(
      'Of 3 paid checks, 1 was fulfilled, earning 0.1 MON against 0.004 MON of worker gas: 0.096 MON net, a 96% margin. 0.1 MON waits in escrow for 1 check in progress. 1 request ended without a result and got the fee back.',
    );
    expect(d.recent.map((r) => [r.request.id, r.label])).toEqual([
      ['2', 'Rejected'],
      ['1', 'Running'],
      ['0', 'Fulfilled'],
    ]);
    expect(d.worker).toMatchObject({ available: true, fulfilled: 1, rejected: 1 });
  });
});

describe('vault at request time', () => {
  it('a newer paid report replaces the board build; an unchanged vault keeps it without reading the chain', async () => {
    const up = await resolveVault('143', UPSHIFT);
    expect(up.source).toBe('requested');
    expect(up.detail!.report.blockNumber).toBe('109400000');
    expect(up.detail!.row).toMatchObject({ name: 'earnAUSD', protocol: 'Upshift', status: 'mismatch', reportPath: `/api/v1/reports/143/${UPSHIFT}/${NEW_FILE}` });
    expect(up.detail!.row.attestation).toMatchObject({ kind: 'attested', id: '18', matchesReport: true });
    const calls = (reader.current.readContract as ReturnType<typeof vi.fn>).mock.calls.length;
    const steak = await resolveVault('143', STEAKHOUSE);
    expect(steak.source).toBe('board');
    expect((reader.current.readContract as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    expect((await resolveVault('143', '0x9999999999999999999999999999999999999999')).detail).toBeNull();
    expect((await resolveVault('143', '../../etc/passwd')).detail).toBeNull();
  });
});

describe('GET /api/v1/vaults/<chainId>/<address>', () => {
  const call = (chainId: string, address: string) =>
    vaultApi(new Request(`https://specfirst.test/api/v1/vaults/${chainId}/${address}`), { params: Promise.resolve({ chainId, address }) });

  it('a checked vault: report summary, the four flags, the live attestation, the replay command', async () => {
    const res = await call('143', UPSHIFT);
    expect(res.status).toBe(200);
    const body = vaultApiResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      schema: 'specfirst.vault.v1',
      chainId: 143,
      address: UPSHIFT,
      checked: true,
      vault: { name: 'earnAUSD', protocol: 'Upshift' },
      report: { source: 'requested', status: 'mismatch', blockNumber: '109400000', total: 30, reportHash: newerHash },
      maxHonored: { maxDeposit: true, maxMint: true, maxWithdraw: false, maxRedeem: false },
      maxHonoredStatus: { maxWithdraw: 'fail' },
      attestation: { state: 'attested', id: '18', isCompliant: false, matchesReport: true, txHash: ATTEST_TX, txUrl: `https://testnet.monadscan.com/tx/${ATTEST_TX}` },
      badge: { state: 'mismatch', url: `https://specfirst.test/badge/check/143/${UPSHIFT}.svg` },
      links: { page: `https://specfirst.test/v/143/${UPSHIFT}`, requestCheck: `https://specfirst.test/check?vault=${UPSHIFT}` },
    });
    expect(body.report!.failed.map((f) => f.id)).toEqual(['sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    expect(body.reproduce!.args[0]).toBe(`specfirst check ${UPSHIFT_CS}`);
  });

  it('a never-checked vault is a 404 with the same shape; a bad address is a 400', async () => {
    const res = await call('143', '0x9999999999999999999999999999999999999999');
    expect(res.status).toBe(404);
    const body = vaultApiResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ checked: false, report: null, maxHonored: { maxDeposit: null }, attestation: { state: 'none', isCompliant: false }, badge: { state: 'not-attested' } });
    expect((await call('143', '0x12')).status).toBe(400);
  });

  it('names SPECFIRST_PUBLIC_ORIGIN in its links behind a proxy, where next start reports http://localhost:3000', async () => {
    vi.stubEnv('SPECFIRST_PUBLIC_ORIGIN', 'https://specfirst.example.org');
    try {
      const res = await vaultApi(new Request(`http://localhost:3000/api/v1/vaults/143/${UPSHIFT}`), { params: Promise.resolve({ chainId: '143', address: UPSHIFT }) });
      const body = vaultApiResponseSchema.parse(await res.json());
      expect(body.links.page).toBe(`https://specfirst.example.org/v/143/${UPSHIFT}`);
      expect(body.badge.url).toBe(`https://specfirst.example.org/badge/check/143/${UPSHIFT}.svg`);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('badge and runtime report routes', () => {
  it('/badge/check/<chainId>/<address>.svg follows the registry', async () => {
    const res = await badgeRoute(new Request('http://localhost/x'), { params: Promise.resolve({ chainId: '143', address: `${UPSHIFT}.svg` }) });
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml; charset=utf-8');
    expect(await res.text()).toContain('mismatch, 2 of 30 fail');
    const none = await badgeRoute(new Request('http://localhost/x'), { params: Promise.resolve({ chainId: '143', address: `${STEAKHOUSE}.svg` }) });
    expect(await none.text()).toContain('not attested');
    expect((await badgeRoute(new Request('http://localhost/x'), { params: Promise.resolve({ chainId: '143', address: 'nope.svg' }) })).status).toBe(400);
  });

  it('serves a paid report byte for byte and nothing outside the checks directory', async () => {
    const ok = await reportRoute(new Request('http://localhost/x'), { params: Promise.resolve({ chainId: '143', address: UPSHIFT, file: NEW_FILE }) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(await readFile(path.join(root, 'checks', '143', UPSHIFT, NEW_FILE), 'utf8'));
    for (const file of ['..%2F..%2Fstatus.json', '../x.json', 'x.forge.json', 'missing.json']) {
      const r = await reportRoute(new Request('http://localhost/x'), { params: Promise.resolve({ chainId: '143', address: UPSHIFT, file }) });
      expect(r.status).toBe(404);
    }
  });
});
