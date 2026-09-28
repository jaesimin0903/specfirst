import { isReport, type Report } from './report';

/** Fetches and loosely validates report.json. Returns null on any network or shape failure so
 * callers can render a degraded certificate page instead of erroring the whole route. */
export async function fetchReport(url: string, init?: RequestInit): Promise<Report | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isReport(data) ? data : null;
  } catch {
    return null;
  }
}
