import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchReport, isAllowedReportUrl } from '../lib/fetchReport';

const ORIGINAL_BASE = process.env.NEXT_PUBLIC_REPORT_BASE;
const ORIGINAL_ALLOWED = process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;

const REPORT = { specfirst: 1, name: 'StakingVault', invariants: [], unverified: [] };

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;
  process.env.NEXT_PUBLIC_REPORT_BASE = 'https://reports.example.test/runs/';
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_BASE === undefined) delete process.env.NEXT_PUBLIC_REPORT_BASE;
  else process.env.NEXT_PUBLIC_REPORT_BASE = ORIGINAL_BASE;
  if (ORIGINAL_ALLOWED === undefined) delete process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;
  else process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS = ORIGINAL_ALLOWED;
});

function mockFetchOnce(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}

describe('isAllowedReportUrl', () => {
  it('allows the configured NEXT_PUBLIC_REPORT_BASE host by default', () => {
    expect(isAllowedReportUrl('https://reports.example.test/runs/v1.json')).toBe(true);
  });

  it('allows raw.githubusercontent.com by default', () => {
    expect(isAllowedReportUrl('https://raw.githubusercontent.com/org/repo/main/report.json')).toBe(true);
  });

  it('rejects a host not on the allowlist (open redirect / SSRF target)', () => {
    expect(isAllowedReportUrl('https://evil.example/report.json')).toBe(false);
  });

  it('rejects a javascript: URL', () => {
    expect(isAllowedReportUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects a data: URL', () => {
    expect(isAllowedReportUrl('data:text/plain,hi')).toBe(false);
  });

  it('honors NEXT_PUBLIC_REPORT_ALLOWED_HOSTS when set, replacing the default list', () => {
    process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS = 'cdn.example.test, other.example.test';
    expect(isAllowedReportUrl('https://cdn.example.test/v1.json')).toBe(true);
    // Overriding the allowlist means the base host is no longer implicitly trusted.
    expect(isAllowedReportUrl('https://reports.example.test/runs/v1.json')).toBe(false);
  });
});

describe('fetchReport', () => {
  it('fetches and returns a report from an allowed host', async () => {
    mockFetchOnce(async () => new Response(JSON.stringify(REPORT), { status: 200, headers: { 'content-type': 'application/json' } }));
    const report = await fetchReport('https://reports.example.test/runs/v1.json');
    expect(report).toEqual(REPORT);
  });

  it('returns null without calling fetch when the host is not on the allowlist', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const report = await fetchReport('https://evil.example/report.json');
    expect(report).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for a javascript: URL without calling fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const report = await fetchReport('javascript:alert(1)');
    expect(report).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('passes redirect: "error" and returns null when the host redirects', async () => {
    mockFetchOnce(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      throw new TypeError('Failed to fetch: redirect mode is error');
    });
    const report = await fetchReport('https://reports.example.test/runs/v1.json');
    expect(report).toBeNull();
  });

  it('returns null when Content-Length declares a response over 2MB', async () => {
    mockFetchOnce(
      async () =>
        new Response(JSON.stringify(REPORT), {
          status: 200,
          headers: { 'content-length': String(3 * 1024 * 1024) },
        }),
    );
    const report = await fetchReport('https://reports.example.test/runs/v1.json');
    expect(report).toBeNull();
  });

  it('aborts and returns null when the actual body exceeds 2MB even without a Content-Length hint', async () => {
    const oversized = JSON.stringify({ ...REPORT, unverified: Array(600_000).fill('x') });
    expect(oversized.length).toBeGreaterThan(2 * 1024 * 1024);
    mockFetchOnce(async () => new Response(oversized, { status: 200 }));
    const report = await fetchReport('https://reports.example.test/runs/v1.json');
    expect(report).toBeNull();
  });

  it('returns null on a non-2xx response', async () => {
    mockFetchOnce(async () => new Response('not found', { status: 404 }));
    const report = await fetchReport('https://reports.example.test/runs/v1.json');
    expect(report).toBeNull();
  });

  it('returns null when the body is not valid report JSON', async () => {
    mockFetchOnce(async () => new Response(JSON.stringify({ hello: 'world' }), { status: 200 }));
    const report = await fetchReport('https://reports.example.test/runs/v1.json');
    expect(report).toBeNull();
  });
});
