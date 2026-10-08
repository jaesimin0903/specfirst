import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { keccak256, toHex } from 'viem';
import { canonicalJson } from '@specfirst/core/hash';
import { LEGACY_REPORT_PREFIX, REPORT_PREFIX, reportLinkOf, resolveReportUrl } from '../lib/report';
import { fetchReport } from '../lib/fetchReport';
import { ReportHashCheck } from '../components/ReportHashCheck';

// The reportURI of attestation #15 in CheckAttestationRegistry on Monad testnet, as the chain stores it.
const ON_CHAIN = 'https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks/143/0xd793c04b87386a6bb84ee61d98e0065fde7fda5e/109195820-2360d95c83b2c541.json';
const MAPPED = 'https://raw.githubusercontent.com/jaesimin0903/specfirst/main/certs/checks/143/0xd793c04b87386a6bb84ee61d98e0065fde7fda5e/109195820-2360d95c83b2c541.json';

const REPORT = { specfirst: 1, name: 'StakingVault', invariants: [], unverified: [] };
const ORIGINAL_BASE = process.env.NEXT_PUBLIC_REPORT_BASE;
const ORIGINAL_ALLOWED = process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;
  process.env.NEXT_PUBLIC_REPORT_BASE = 'https://reports.example.test/runs/';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (ORIGINAL_BASE === undefined) delete process.env.NEXT_PUBLIC_REPORT_BASE;
  else process.env.NEXT_PUBLIC_REPORT_BASE = ORIGINAL_BASE;
  if (ORIGINAL_ALLOWED === undefined) delete process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;
  else process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS = ORIGINAL_ALLOWED;
});

function stubFetch(body: unknown) {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('reportLinkOf', () => {
  it('maps the legacy jaesimin/specfirst prefix to jaesimin0903/specfirst and keeps the rest of the path', () => {
    expect(reportLinkOf(ON_CHAIN)).toBe(MAPPED);
    expect(reportLinkOf(LEGACY_REPORT_PREFIX)).toBe(REPORT_PREFIX);
  });

  it('is idempotent: a URL already at jaesimin0903/specfirst comes back unchanged', () => {
    expect(reportLinkOf(MAPPED)).toBe(MAPPED);
    expect(reportLinkOf(reportLinkOf(ON_CHAIN))).toBe(MAPPED);
  });

  it('leaves everything that is not the exact prefix unchanged', () => {
    const others = [
      'https://raw.githubusercontent.com/jaesimin/specfirst-example-vault/main/report.json',
      'https://raw.githubusercontent.com/jaesimin/specfirst',
      'https://raw.githubusercontent.com/Jaesimin/specfirst/main/certs/checks/143/x.json',
      'http://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks/143/x.json',
      'https://evil.example/https://raw.githubusercontent.com/jaesimin/specfirst/main/x.json',
      'https://raw.githubusercontent.com/someone/specfirst/main/x.json',
      'certs/checks/143/x.json',
      '',
    ];
    for (const uri of others) expect(reportLinkOf(uri)).toBe(uri);
  });
});

describe('legacy reportURI through resolve, fetch and hash check', () => {
  it('resolveReportUrl returns the mapped URL for a legacy absolute reportURI', () => {
    expect(resolveReportUrl(ON_CHAIN)).toBe(MAPPED);
  });

  it('resolveReportUrl maps a relative reportURI resolved under a legacy base', () => {
    process.env.NEXT_PUBLIC_REPORT_BASE = 'https://raw.githubusercontent.com/jaesimin/specfirst/main/';
    expect(resolveReportUrl('certs/31337/0xabc/0.json')).toBe('https://raw.githubusercontent.com/jaesimin0903/specfirst/main/certs/31337/0xabc/0.json');
  });

  it('fetchReport requests the mapped URL', async () => {
    const spy = stubFetch(REPORT);
    expect(await fetchReport(ON_CHAIN)).toEqual(REPORT);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toBe(MAPPED);
  });

  it('fetchReport keeps the host allowlist: with raw.githubusercontent.com not allowed, a legacy URL is not fetched', async () => {
    process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS = 'reports.example.test';
    const spy = stubFetch(REPORT);
    expect(await fetchReport(ON_CHAIN)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('ReportHashCheck fetches the mapped URL and compares against the on-chain reportHash', async () => {
    const spy = stubFetch(REPORT);
    render(<ReportHashCheck reportUrl={ON_CHAIN} onChainHash={keccak256(toHex(canonicalJson(REPORT)))} />);
    await waitFor(() => expect(screen.getByText(/matches on-chain reportHash/i)).toBeInTheDocument());
    expect(String(spy.mock.calls[0]![0])).toBe(MAPPED);
  });
});
