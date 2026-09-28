import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';

const REGISTRY = '0x0000000000000000000000000000000000000abc' as Address;
const TARGET = '0x4a1f00000000000000000000000000000000c9e2' as Address;
const HASH = (byte: string) => (`0x${byte.repeat(32)}`) as Hex;

function certTuple(overrides: Record<string, unknown> = {}) {
  return [
    3n,
    {
      projectId: HASH('a1'),
      specHash: HASH('b2'),
      invariantSetHash: HASH('c3'),
      propertyHash: HASH('d4'),
      codeHash: HASH('e5'),
      reportHash: HASH('f6'),
      issuedAt: BigInt(Math.floor(new Date('2026-10-07T00:00:00Z').getTime() / 1000)),
      passedCount: 7,
      totalCount: 7,
      passedBitmap: 127n,
      rehearsalTxCount: 30,
      status: 1,
      supersededBy: '0x0000000000000000000000000000000000000000' as Address,
      revokeReasonHash: '0x' + '0'.repeat(64),
      reportURI: 'reports/staking-vault-v1.json',
      ...overrides,
    },
    true,
  ] as const;
}

function noCertificateError() {
  const err = new Error('reverted') as Error & { data: { errorName: string } };
  err.data = { errorName: 'NoCertificate' };
  return err;
}

function mockClient(behavior: { latest: 'valid' | 'superseded' | 'none'; isLatest?: boolean }) {
  return {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'isCertified') return behavior.latest !== 'none';
      if (functionName === 'latest') {
        if (behavior.latest === 'none') throw noCertificateError();
        if (behavior.latest === 'superseded') return certTuple({ status: 2 });
        return certTuple({ status: 1 });
      }
      if (functionName === 'isLatest') return behavior.isLatest ?? behavior.latest === 'valid';
      throw new Error(`unexpected functionName ${functionName}`);
    }),
  };
}

vi.mock('../lib/chain', () => ({
  CHAIN_ID: 10143,
  getRegistryAddress: vi.fn(() => REGISTRY),
  publicClient: vi.fn(),
}));

import { getRegistryAddress, publicClient } from '../lib/chain';
import { GET } from '../app/api/cert/[address]/route';

function callRoute(address: string, search = '') {
  const request = new Request(`http://localhost/api/cert/${address}${search}`);
  return GET(request, { params: Promise.resolve({ address }) });
}

beforeEach(() => {
  vi.mocked(getRegistryAddress).mockReturnValue(REGISTRY);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/cert/[address]', () => {
  it('returns status "valid" with full certificate fields for a certified, latest target', async () => {
    vi.mocked(publicClient).mockReturnValue(mockClient({ latest: 'valid' }) as never);
    const res = await callRoute(TARGET);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      address: TARGET,
      chainId: 10143,
      certified: true,
      isLatest: true,
      status: 'valid',
      passed: 7,
      total: 7,
      supersededBy: null,
      certificateUrl: `http://localhost/c/${TARGET}`,
      reportUrl: `reports/staking-vault-v1.json`,
    });
    expect(body.invariantSetHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('returns status "none" and certified:false when no certificate exists', async () => {
    vi.mocked(publicClient).mockReturnValue(mockClient({ latest: 'none' }) as never);
    const res = await callRoute(TARGET);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      address: TARGET,
      certified: false,
      isLatest: null,
      status: 'none',
      projectId: null,
      passed: 0,
      total: 0,
      issuedAt: null,
      reportUrl: null,
    });
  });

  it('returns status "superseded" and isLatest:false, still certified, when a newer version exists', async () => {
    vi.mocked(publicClient).mockReturnValue(mockClient({ latest: 'superseded', isLatest: false }) as never);
    const res = await callRoute(TARGET);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('superseded');
    expect(body.certified).toBe(true);
    expect(body.isLatest).toBe(false);
  });

  it('responds 503 when the registry is not configured', async () => {
    vi.mocked(getRegistryAddress).mockReturnValue(null);
    const res = await callRoute(TARGET);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('registry not configured');
  });

  it('responds 400 for a malformed address', async () => {
    vi.mocked(publicClient).mockReturnValue(mockClient({ latest: 'valid' }) as never);
    const res = await callRoute('not-an-address');
    expect(res.status).toBe(400);
  });
});
