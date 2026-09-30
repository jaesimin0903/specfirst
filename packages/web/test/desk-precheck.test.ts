import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { assembleBoard, collectReports, readVaultMeta } from '../lib/board/pipeline';
import { metaFor, type CheckCandidate, type VaultMeta } from '../lib/board/aggregate';
import type { RegistryRead, VaultDetail } from '../lib/board/types';
import { NATIVE_ASSET_SENTINEL, precheckVault, type PrecheckDeps } from '../lib/desk/precheck';
import type { LiveAttestation } from '../lib/desk/registry';

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, 'fixtures/board/checks');
const UPSHIFT = '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e';
const NEW_VAULT = '0x4444444444444444444444444444444444444444';
const ASSET = '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a';
const REG: RegistryRead = { chainId: 10143, address: '0x3754918bBB8481D046D80718a9efe434e353daF7', rpc: 'x', status: 'ok', error: null, attestationCount: 0, readAt: null };

let details: Map<string, VaultDetail>;
let candidates: CheckCandidate[];
let meta: VaultMeta | null;

beforeAll(async () => {
  const collected = await collectReports(SOURCE);
  candidates = collected.candidates;
  meta = await readVaultMeta(path.join(here, 'fixtures/board/vault-meta.json'));
  const built = assembleBoard({ candidates, meta, registry: REG, attestations: new Map(), generatedAt: 'x', source: 'fixtures', skipped: [] });
  details = new Map(built.details.map((d) => [d.row.id, d]));
});

type Vault = { code?: string; asset?: string | Error; name?: string; symbol?: string; decimals?: number; totalAssets?: bigint };

function deps(vaults: Record<string, Vault>, over: Partial<PrecheckDeps> = {}): PrecheckDeps {
  const tokens: Record<string, { symbol: string; decimals: number }> = { [ASSET.toLowerCase()]: { symbol: 'AUSD', decimals: 6 } };
  return {
    mainnet: {
      getBytecode: vi.fn(async ({ address }) => vaults[address.toLowerCase()]?.code ?? (tokens[address.toLowerCase()] ? '0x60' : undefined)) as never,
      readContract: vi.fn(async ({ address, functionName }: { address: string; functionName: string }) => {
        const t = tokens[address.toLowerCase()];
        if (t) {
          if (functionName === 'symbol') return t.symbol;
          if (functionName === 'decimals') return t.decimals;
          throw new Error('reverted');
        }
        const v = vaults[address.toLowerCase()];
        const value = v?.[functionName as keyof Vault];
        if (value === undefined || value instanceof Error) throw value ?? new Error('execution reverted');
        return value;
      }),
    },
    boardDetail: (c, a) => details.get(`${c}/${a}`) ?? null,
    latestReport: async () => null,
    attestation: async (): Promise<LiveAttestation> => ({ kind: 'none' }),
    pending: async () => [],
    meta: (c, a) => metaFor(meta, c, a),
    ...over,
  };
}

const erc4626: Vault = { code: '0x6080', asset: ASSET, name: 'Some Vault', symbol: 'sVLT', decimals: 18, totalAssets: 1_234_567_000_000n };

describe('precheckVault', () => {
  it('refuses what is not an address, or another chain, before any read', async () => {
    const d = deps({});
    const r = await precheckVault('0x1234', 143, d);
    expect(r).toMatchObject({ ok: false, address: null, blockers: [expect.stringMatching(/not an address/)] });
    expect((await precheckVault(NEW_VAULT, 1, d)).blockers[0]).toMatch(/Monad mainnet \(chain 143\) only/);
    expect(d.mainnet.getBytecode).not.toHaveBeenCalled();
  });

  it('no code at the address blocks the request, since the worker would reject it', async () => {
    const r = await precheckVault(NEW_VAULT, 143, deps({}));
    expect(r.ok).toBe(false);
    expect(r.contract?.isContract).toBe(false);
    expect(r.blockers[0]).toMatch(/no contract at this address/);
  });

  it('a contract that does not answer asset() is not an ERC-4626 vault', async () => {
    const r = await precheckVault(NEW_VAULT, 143, deps({ [NEW_VAULT]: { ...erc4626, asset: new Error('execution reverted') } }));
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toMatch(/asset\(\) did not answer/);
  });

  it('a new vault: name, asset, held amount, nothing known yet, request allowed', async () => {
    const r = await precheckVault(`  ${NEW_VAULT.toUpperCase().replace('0X', '0x')}  `, 143, deps({ [NEW_VAULT]: erc4626 }));
    expect(r.ok).toBe(true);
    expect(r.address).toBe('0x4444444444444444444444444444444444444444');
    expect(r.contract).toMatchObject({ isContract: true, name: 'Some Vault', symbol: 'sVLT', asset: ASSET, assetSymbol: 'AUSD', assetDecimals: 6, totalAssets: '1234567000000' });
    expect(r).toMatchObject({ onBoard: false, latestReport: null, attestation: { kind: 'none' }, pending: [], blockers: [], notes: [] });
  });

  it('a board vault: says what the board found and that a request checks it again', async () => {
    const r = await precheckVault(UPSHIFT, 143, deps({ [UPSHIFT]: erc4626 }));
    expect(r.ok).toBe(true);
    expect(r.onBoard).toBe(true);
    expect(r.latestReport).toMatchObject({ status: 'mismatch', blockNumber: '109195820', source: 'board', summary: { fail: 2 } });
    expect(r.contract?.protocol).toBe('Upshift');
    expect(r.notes[0]).toMatch(/^Checked before at block 109,195,820 for the board\. A new request checks the vault again/);
  });

  it('a newer requested report wins over the board; the attestation is compared with it', async () => {
    const newer = candidates.find((c) => c.report.address.toLowerCase() === UPSHIFT && c.report.blockNumber === '109195820')!;
    const bumped: CheckCandidate = { ...newer, report: { ...newer.report, blockNumber: '109400000' }, reportHash: `0x${'77'.repeat(32)}` };
    const live: LiveAttestation = {
      kind: 'attested',
      record: { ...fakeRecord(), reportHash: `0x${'77'.repeat(32)}`, compliant: false },
    };
    const r = await precheckVault(UPSHIFT, 143, deps({ [UPSHIFT]: erc4626 }, { latestReport: async () => bumped, attestation: async () => live, pending: async () => [{ id: '4', stage: 'running' }] }));
    expect(r.latestReport).toMatchObject({ source: 'requested', blockNumber: '109400000', status: 'mismatch' });
    expect(r.attestation).toMatchObject({ kind: 'attested', id: '18', isCompliant: false, matchesLatestReport: true });
    expect(r.pending).toEqual([{ id: '4', stage: 'running' }]);
    expect(r.notes[1]).toMatch(/already in progress \(request #4\)/);
    expect(r.ok).toBe(true);
  });

  it('a native-asset vault is allowed with a warning; RPC trouble is a blocker that says so', async () => {
    const native = await precheckVault(NEW_VAULT, 143, deps({ [NEW_VAULT]: { ...erc4626, asset: NATIVE_ASSET_SENTINEL } }));
    expect(native.ok).toBe(true);
    expect(native.contract?.assetSymbol).toBe('MON (native)');
    expect(native.notes[0]).toMatch(/ERC-7535/);
    const down = deps({}, {});
    down.mainnet.getBytecode = vi.fn(async () => Promise.reject(new Error('HTTP request failed.\nURL: https://rpc.monad.xyz'))) as never;
    const r = await precheckVault(NEW_VAULT, 143, down);
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toBe('Could not read Monad mainnet: HTTP request failed. Try again in a moment.');
  });

  it('a registry that cannot be read does not block the request', async () => {
    const r = await precheckVault(NEW_VAULT, 143, deps({ [NEW_VAULT]: erc4626 }, { attestation: async () => Promise.reject(new Error('rate limited')) }));
    expect(r.ok).toBe(true);
    expect(r.attestation).toEqual({ kind: 'unread', reason: 'rate limited' });
  });
});

function fakeRecord() {
  return {
    id: '18',
    status: 'Valid' as const,
    compliant: true,
    blockNumber: '109400000',
    reportHash: `0x${'ab'.repeat(32)}`,
    suiteHash: `0x${'cd'.repeat(32)}`,
    implementationKey: `0x${'ef'.repeat(32)}`,
    subjectCodeHash: `0x${'12'.repeat(32)}`,
    counts: { pass: 16, fail: 2, inconclusive: 12, notApplicable: 0 },
    issuedAt: '2026-10-01T00:00:00.000Z',
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    reportURI: '',
    txHash: null,
  };
}
