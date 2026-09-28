import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReportUrl } from '../lib/report';

const ORIGINAL_BASE = process.env.NEXT_PUBLIC_REPORT_BASE;

beforeEach(() => {
  process.env.NEXT_PUBLIC_REPORT_BASE = 'https://reports.example.test/runs/';
});

afterEach(() => {
  if (ORIGINAL_BASE === undefined) delete process.env.NEXT_PUBLIC_REPORT_BASE;
  else process.env.NEXT_PUBLIC_REPORT_BASE = ORIGINAL_BASE;
});

describe('resolveReportUrl', () => {
  it('resolves a relative reportURI against the configured https base', () => {
    expect(resolveReportUrl('staking-vault-v1.json')).toBe('https://reports.example.test/runs/staking-vault-v1.json');
  });

  it('rejects a javascript: reportURI', () => {
    expect(resolveReportUrl('javascript:alert(document.cookie)')).toBe('');
  });

  it('rejects a data: reportURI', () => {
    expect(resolveReportUrl('data:text/html,<script>alert(1)</script>')).toBe('');
  });

  it('rejects a file: reportURI', () => {
    expect(resolveReportUrl('file:///etc/passwd')).toBe('');
  });

  it('returns "" when NEXT_PUBLIC_REPORT_BASE is unset', () => {
    delete process.env.NEXT_PUBLIC_REPORT_BASE;
    expect(resolveReportUrl('staking-vault-v1.json')).toBe('');
  });

  it('returns "" when NEXT_PUBLIC_REPORT_BASE is not https', () => {
    process.env.NEXT_PUBLIC_REPORT_BASE = 'http://reports.example.test/runs/';
    expect(resolveReportUrl('staking-vault-v1.json')).toBe('');
  });

  it('returns "" when NEXT_PUBLIC_REPORT_BASE is not an absolute URL', () => {
    process.env.NEXT_PUBLIC_REPORT_BASE = 'not-a-url';
    expect(resolveReportUrl('staking-vault-v1.json')).toBe('');
  });

  it('returns "" for an empty reportURI', () => {
    expect(resolveReportUrl('')).toBe('');
  });
});
