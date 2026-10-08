import { isReport, reportLinkOf, type Report } from './report';

const MAX_REPORT_BYTES = 2 * 1024 * 1024; // 2MB
const FETCH_TIMEOUT_MS = 10_000;
const ALWAYS_ALLOWED_HOSTS = ['raw.githubusercontent.com'];

/**
 * Hosts this server is willing to fetch report.json from. reportURI is an on-chain,
 * issuer-supplied value: only the issuer can write it today, but this server has no way to
 * verify that stays true, so it is treated as attacker-controlled input and gated by an
 * allowlist rather than trusted outright (SSRF defense in depth). Configurable via
 * NEXT_PUBLIC_REPORT_ALLOWED_HOSTS (comma-separated); defaults to NEXT_PUBLIC_REPORT_BASE's own
 * host plus raw.githubusercontent.com.
 */
function allowedReportHosts(): string[] {
  const configured = process.env.NEXT_PUBLIC_REPORT_ALLOWED_HOSTS;
  if (configured) {
    return configured
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean);
  }

  const hosts = new Set(ALWAYS_ALLOWED_HOSTS);
  const base = process.env.NEXT_PUBLIC_REPORT_BASE;
  if (base) {
    try {
      hosts.add(new URL(base).host.toLowerCase());
    } catch {
      // NEXT_PUBLIC_REPORT_BASE is malformed; resolveReportUrl already refuses to build URLs
      // from it, so there is nothing useful to add here.
    }
  }
  return [...hosts];
}

/** True when `url` is http(s) and its host is on the report host allowlist. */
export function isAllowedReportUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return allowedReportHosts().includes(parsed.host.toLowerCase());
}

/** Reads `res.body` up to `maxBytes`, aborting the stream (not just refusing the result) once
 * the cap is crossed so a report host can't force this server to buffer an unbounded response.
 * Ignores Content-Length as anything but an early-exit hint: a malicious or misconfigured host
 * can lie about it, understate it, or omit it entirely. */
async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) {
    const text = await res.text();
    return new TextEncoder().encode(text).byteLength > maxBytes ? null : text;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(combined);
}

/**
 * Fetches and loosely validates report.json for the certificate page's server-rendered content
 * (the browser-side reportHash re-check in ReportHashCheck.tsx does its own separate fetch, from
 * the viewer's machine, which is not this function's concern).
 *
 * Returns null on any failure: disallowed host or scheme, a redirect (redirect: 'error', so a
 * host on the allowlist can't 302 this server to one that isn't), a response over 2MB, a network
 * error or timeout, or JSON that doesn't look like a report. Callers that need to tell "host not
 * allowed" apart from the rest should call isAllowedReportUrl themselves before calling this.
 * A legacy jaesimin/specfirst URL is fetched at jaesimin0903/specfirst (reportLinkOf), still under the allowlist.
 */
export async function fetchReport(url: string, init?: RequestInit): Promise<Report | null> {
  if (!url) return null;
  const target = reportLinkOf(url);
  if (!isAllowedReportUrl(target)) return null;

  try {
    const res = await fetch(target, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const declaredLength = res.headers.get('content-length');
    if (declaredLength && Number(declaredLength) > MAX_REPORT_BYTES) return null;

    const body = await readBounded(res, MAX_REPORT_BYTES);
    if (body === null) return null;

    const data: unknown = JSON.parse(body);
    return isReport(data) ? data : null;
  } catch {
    return null;
  }
}
