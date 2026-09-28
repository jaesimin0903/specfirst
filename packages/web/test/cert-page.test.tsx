import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { Address, Hex } from 'viem';
import { CertificateView } from '../components/CertificateView';
import type { CertLookup, CertStatus, CertificateStruct } from '../lib/certStatus';
import { ZERO_ADDRESS } from '../lib/certStatus';
import type { Report } from '../lib/report';

const NOW = new Date('2026-10-10T00:00:00Z');
const ADDRESS = '0x4a1f00000000000000000000000000000000c9e2' as Address;
const HASH = (byte: string) => (`0x${byte.repeat(32)}`) as Hex;

function certificate(overrides: Partial<CertificateStruct> = {}): CertificateStruct {
  return {
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
    supersededBy: ZERO_ADDRESS as Address,
    revokeReasonHash: ZERO_ADDRESS.padEnd(66, '0') as Hex,
    reportURI: 'https://example.test/report.json',
    ...overrides,
  };
}

function lookup(status: CertStatus, cert: CertificateStruct, isLatest: boolean): CertLookup {
  return {
    address: ADDRESS,
    hasCertificate: true,
    certified: status !== 'revoked',
    certifiedWith: null,
    isLatest,
    certId: 3n,
    certificate: cert,
    codeMatches: status !== 'revoked',
    status,
  };
}

const REPORT: Report = {
  specfirst: 1,
  projectId: 'staking-vault',
  name: 'StakingVault',
  target: ADDRESS,
  chainId: 10143,
  invariants: [
    { id: 'INV-1', kind: 'invariant', text: 'total supply equals the sum of minted balances', status: 'pass' },
    { id: 'INV-4', kind: 'access', text: 'only the owner can withdraw', status: 'pass' },
  ],
  unverified: ['oracle manipulation', 'economic attacks'],
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('no network in tests'))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderAndSettle(props: Parameters<typeof CertificateView>[0]) {
  const view = render(<CertificateView {...props} />);
  await waitFor(() => expect(screen.getByText(/report hash not verified/)).toBeInTheDocument());
  return view;
}

describe('CertificateView, four states', () => {
  it('valid: certified with no caveats', async () => {
    const cert = certificate({ status: 1 });
    const { container } = await renderAndSettle({
      address: ADDRESS,
      lookup: lookup('valid', cert, true),
      report: REPORT,
      reportUrl: cert.reportURI,
      forwardLineage: [],
      backwardLineage: [],
      issuanceTx: null,
      now: NOW,
    });
    expect(screen.getByText('Certified')).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it('superseded: certified, newer version available', async () => {
    const newer = '0x111111111111111111111111111111111111aaaa' as Address;
    const cert = certificate({ status: 2, supersededBy: newer });
    const { container } = await renderAndSettle({
      address: ADDRESS,
      lookup: lookup('superseded', cert, false),
      report: REPORT,
      reportUrl: cert.reportURI,
      forwardLineage: [{ address: newer, certId: 4n, status: 'valid', issuedAt: cert.issuedAt }],
      backwardLineage: [],
      issuanceTx: null,
      now: NOW,
    });
    expect(screen.getByText(/newer version available/)).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(newer)).length).toBeGreaterThan(0);
    expect(container).toMatchSnapshot();
  });

  it('revoked: no longer counts as certified', async () => {
    const cert = certificate({ status: 3 });
    const { container } = await renderAndSettle({
      address: ADDRESS,
      lookup: lookup('revoked', cert, false),
      report: REPORT,
      reportUrl: cert.reportURI,
      forwardLineage: [],
      backwardLineage: [],
      issuanceTx: null,
      now: NOW,
    });
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText(/no longer counts as certified/)).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });

  it('partial: only some invariants passed', async () => {
    const cert = certificate({ status: 1, passedCount: 5, totalCount: 7 });
    const { container } = await renderAndSettle({
      address: ADDRESS,
      lookup: lookup('partial', cert, true),
      report: REPORT,
      reportUrl: cert.reportURI,
      forwardLineage: [],
      backwardLineage: [],
      issuanceTx: null,
      now: NOW,
    });
    expect(screen.getByText('Partial verification')).toBeInTheDocument();
    expect(screen.getByText(/only 5 of 7 invariants passed/)).toBeInTheDocument();
    expect(container).toMatchSnapshot();
  });
});
