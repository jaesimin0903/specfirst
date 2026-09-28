import { describe, expect, it, vi } from 'vitest';
import { fetchStatus, formatStatus, type CertificateStruct, type MinimalPublicClient } from '../src/commands/status.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as const;
const REGISTRY = '0x2222222222222222222222222222222222222222' as const;
const NEW_TARGET = '0x3333333333333333333333333333333333333333' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const INVARIANT_SET_HASH = `0x${'ab'.repeat(32)}` as const;

function certificate(overrides: Partial<CertificateStruct> = {}): CertificateStruct {
  return {
    projectId: `0x${'11'.repeat(32)}`,
    specHash: `0x${'22'.repeat(32)}`,
    invariantSetHash: INVARIANT_SET_HASH,
    propertyHash: `0x${'33'.repeat(32)}`,
    codeHash: `0x${'44'.repeat(32)}`,
    reportHash: `0x${'55'.repeat(32)}`,
    issuedAt: 1_700_000_000n,
    passedCount: 7,
    totalCount: 7,
    passedBitmap: 127n,
    rehearsalTxCount: 30,
    status: 1, // Valid
    supersededBy: ZERO_ADDRESS,
    revokeReasonHash: `0x${'00'.repeat(32)}`,
    reportURI: 'ipfs://report',
    ...overrides,
  };
}

function mockClient(handlers: Record<string, (args: readonly unknown[]) => unknown>): MinimalPublicClient {
  return {
    readContract: vi.fn(async ({ functionName, args }: { functionName: string; args: readonly unknown[] }) => {
      const handler = handlers[functionName];
      if (!handler) throw new Error(`unexpected call: ${functionName}`);
      return handler(args);
    }) as unknown as MinimalPublicClient['readContract'],
  };
}

describe('fetchStatus', () => {
  it('certified: current, Valid, isCertified true, isLatest true', async () => {
    const client = mockClient({
      isCertified: () => true,
      isCertifiedWith: () => true,
      latest: () => [5n, certificate({ status: 1 }), true],
      isLatest: () => true,
    });

    const result = await fetchStatus({ client, registry: REGISTRY, address: ADDRESS, invariantSetHash: INVARIANT_SET_HASH });

    expect(result.hasCertificate).toBe(true);
    expect(result.certified).toBe(true);
    expect(result.certifiedWith).toBe(true);
    expect(result.isLatest).toBe(true);
    expect(result.certId).toBe(5n);
    expect(result.certificate?.status).toBe(1);

    const lines = formatStatus(result);
    expect(lines.some((l) => l.includes('status:') && l.includes('Valid'))).toBe(true);
    expect(lines.some((l) => l.includes('isLatest:') && l.includes('true'))).toBe(true);
  });

  it('superseded: isCertified stays true (code was validated), isLatest false, supersededBy set', async () => {
    const client = mockClient({
      isCertified: () => true,
      isCertifiedWith: () => false,
      latest: () => [3n, certificate({ status: 2, supersededBy: NEW_TARGET }), true],
      isLatest: () => false,
    });

    const result = await fetchStatus({ client, registry: REGISTRY, address: ADDRESS, invariantSetHash: INVARIANT_SET_HASH });

    expect(result.hasCertificate).toBe(true);
    expect(result.certified).toBe(true);
    expect(result.certifiedWith).toBe(false);
    expect(result.isLatest).toBe(false);
    expect(result.certificate?.status).toBe(2);
    expect(result.certificate?.supersededBy).toBe(NEW_TARGET);

    const lines = formatStatus(result);
    expect(lines.some((l) => l.includes('status:') && l.includes('Superseded'))).toBe(true);
    expect(lines.some((l) => l.includes('supersededBy:') && l.includes(NEW_TARGET))).toBe(true);
  });

  it('none: latest() reverts with NoCertificate, hasCertificate false, no throw', async () => {
    const client = mockClient({
      isCertified: () => false,
      latest: () => {
        throw Object.assign(new Error('execution reverted: NoCertificate'), {
          data: { errorName: 'NoCertificate', args: [ADDRESS] },
        });
      },
    });

    const result = await fetchStatus({ client, registry: REGISTRY, address: ADDRESS });

    expect(result.hasCertificate).toBe(false);
    expect(result.certified).toBe(false);
    expect(result.certifiedWith).toBeNull();
    expect(result.isLatest).toBeNull();
    expect(result.certId).toBeNull();
    expect(result.certificate).toBeNull();

    const lines = formatStatus(result);
    expect(lines).toContain('no certificate');
  });

  it('re-throws reverts that are not NoCertificate', async () => {
    const client = mockClient({
      isCertified: () => false,
      latest: () => {
        throw Object.assign(new Error('execution reverted: SomeOtherError'), {
          data: { errorName: 'SomeOtherError' },
        });
      },
    });

    await expect(fetchStatus({ client, registry: REGISTRY, address: ADDRESS })).rejects.toThrow('SomeOtherError');
  });
});
