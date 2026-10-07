import { readFile } from 'node:fs/promises';
import { cellsOf, failedPropertiesOf, type CheckCandidate } from '../board/aggregate';
import { failureLevelOf } from '../board/levels';
import { candidateFromText } from '../desk/reportFiles';
import { runtimeReportPath } from '../desk/vault';
import { resolveReportPath } from './paths';
import { NO_REPORT, type ReportInfo } from './view';

/*
 * The report behind a feed check, read from the checks directory by the feed's reportPath. Report files are
 * written once, so a found report is cached for good (bounded); a missing one is retried after a while, since the
 * feed line can land before the file is visible.
 */

const MAX_ENTRIES = 5000;
const MISSING_TTL_MS = 30_000;

interface Entry {
  at: number;
  candidate: CheckCandidate | null;
  rel: string | null;
}

const cache = new Map<string, Entry>();

export async function reportCandidate(reportPath: string, now: number = Date.now()): Promise<{ candidate: CheckCandidate | null; rel: string | null }> {
  const hit = cache.get(reportPath);
  if (hit && (hit.candidate || now - hit.at < MISSING_TTL_MS)) return hit;
  const resolved = resolveReportPath(reportPath);
  let candidate: CheckCandidate | null = null;
  if (resolved) {
    try {
      candidate = candidateFromText(await readFile(resolved.abs, 'utf8'), resolved.rel);
    } catch {
      candidate = null;
    }
  }
  const entry: Entry = { at: now, candidate, rel: resolved?.rel ?? null };
  cache.set(reportPath, entry);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined && oldest !== reportPath) cache.delete(oldest);
  }
  return entry;
}

/**
 * Cells, link, hash check and failure level for one feed check. The report must be about the same subject, and its
 * failures are read as the board reads them only when it hashes to the feed's reportHash.
 */
export async function reportInfo(check: { reportPath: string; reportHash: string }, subject: { chainId: number; address: string }): Promise<ReportInfo> {
  const { candidate, rel } = await reportCandidate(check.reportPath);
  if (!candidate || !rel) return NO_REPORT;
  const same = candidate.report.chainId === subject.chainId && candidate.report.address.toLowerCase() === subject.address.toLowerCase();
  if (!same) return { ...NO_REPORT, reportMatches: false };
  const matches = candidate.reportHash.toLowerCase() === check.reportHash.toLowerCase();
  return {
    cells: cellsOf(candidate.report.results),
    reportUrl: runtimeReportPath(rel),
    reportMatches: matches,
    failureLevel: matches ? failureLevelOf(failedPropertiesOf(candidate.report.results)) : null,
  };
}

/** For tests. */
export function clearReportCache(): void {
  cache.clear();
}
