import { describeFailure } from '../board/reasons';
import { failedPropertiesOf, metaFor } from '../board/aggregate';
import { loadVaultDetail } from '../board/load';
import { reproduceCommand } from '../board/reproduce';
import type { VaultDetail } from '../board/types';
import { memo } from './cache';
import { testnetClient } from './clients';
import { DESK_CHAIN_ID, deskAddress, registryAddress, STANDARD_ID, SUBJECT_CHAIN_ID } from './config';
import { countRequests, computeEconomics, type Economics } from './economics';
import { latestIds, readDeskSummary, readRequest, readRequests, type ContractReader, type DeskRequest, type DeskSummary } from './read';
import { readAttestationById } from './registry';
import { reportAtPath, vaultReports } from './reportFiles';
import { computeProgress, listLabel } from './stages';
import type { DeskSummaryJson, DeskViewJson, EconomicsJson, RecentRequestJson, RequestJson, RequestViewJson, ResultJson, VaultLabelJson } from './types';
import { attestationTxHashes, cachedBoard, detailFromRuntime, liveAttestation, registryReadOf, vaultMeta, viewOfLive } from './vault';
import { readWorkerStatus, type WorkerSnapshot } from './worker';
import { repoRoot } from './paths';

/*
 * Server-side assembly of what the desk pages and API routes return. Chain reads go through memo() so pollers and
 * page views share them: the summary every 10 s, one request every 3 s, the recent list every 8 s.
 */

const SCAN_LIMIT = 300;

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export function requestJson(r: DeskRequest): RequestJson {
  return {
    id: r.id.toString(),
    requester: r.requester,
    subjectChainId: r.subjectChainId,
    subject: r.subject,
    standardId: r.standardId,
    feeWei: r.feeWei.toString(),
    requestedAt: new Date(Number(r.requestedAt) * 1000).toISOString(),
    status: r.status,
    attestationId: r.attestationId.toString(),
    rejectReason: r.rejectReason,
  };
}

function s(v: bigint | null): string | null {
  return v === null ? null : v.toString();
}

export function summaryJson(desk: `0x${string}` | null, sm: DeskSummary | null, errors: string[] = []): DeskSummaryJson {
  return {
    deployed: desk !== null,
    address: desk,
    chainId: DESK_CHAIN_ID,
    feeWei: s(sm?.feeWei ?? null),
    timeoutSec: s(sm?.timeoutSec ?? null),
    requestCount: s(sm?.requestCount ?? null),
    earnedWei: s(sm?.earnedWei ?? null),
    withdrawnWei: s(sm?.withdrawnWei ?? null),
    escrowedWei: s(sm?.escrowedWei ?? null),
    owner: sm?.owner ?? null,
    worker: sm?.worker ?? null,
    registry: sm?.registry ?? null,
    errors: [...(sm?.errors ?? []), ...errors],
    readAt: new Date().toISOString(),
  };
}

export function economicsJson(e: Economics): EconomicsJson {
  return {
    feeWei: s(e.feeWei),
    earnedWei: s(e.earnedWei),
    withdrawnWei: s(e.withdrawnWei),
    escrowedWei: s(e.escrowedWei),
    withdrawableWei: s(e.withdrawableWei),
    gasCostWei: s(e.gasCostWei),
    netWei: s(e.netWei),
    marginPct: e.marginPct,
    gasPerCheckWei: s(e.gasPerCheckWei),
    unitProfitWei: s(e.unitProfitWei),
    counts: e.counts ? { ...e.counts, paidWei: e.counts.paidWei.toString(), returnedWei: e.counts.returnedWei.toString() } : null,
    summary: e.summary,
  };
}

export async function deskSummary(reader: ContractReader = testnetClient()): Promise<{ desk: `0x${string}` | null; summary: DeskSummary | null; error: string | null }> {
  const desk = deskAddress();
  if (!desk) return { desk, summary: null, error: null };
  try {
    return { desk, summary: await memo(`desk:${desk}:summary`, 10_000, () => readDeskSummary(reader, desk)), error: null };
  } catch (err) {
    return { desk, summary: null, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deskRequest(id: bigint, reader: ContractReader = testnetClient()): Promise<DeskRequest | null> {
  const desk = deskAddress();
  if (!desk) return null;
  return memo(`desk:${desk}:req:${id}`, 3_000, () => readRequest(reader, desk, id));
}

/** The newest requests, newest first; [] when the desk is not deployed or has none. */
export async function recentRequests(limit: number, reader: ContractReader = testnetClient()): Promise<DeskRequest[]> {
  const { desk, summary } = await deskSummary(reader);
  if (!desk || !summary?.requestCount) return [];
  const ids = latestIds(summary.requestCount, limit);
  return memo(`desk:${desk}:recent:${summary.requestCount}:${limit}`, 8_000, () => readRequests(reader, desk, ids));
}

export function vaultLabel(chainId: number, address: string): VaultLabelJson {
  const built = loadVaultDetail(String(chainId), address.toLowerCase());
  if (built) return { name: built.row.name, protocol: built.row.protocol, assetSymbol: built.row.assetSymbol };
  const m = metaFor(vaultMeta(), chainId, address);
  return { name: m?.name ?? null, protocol: m?.protocol ?? null, assetSymbol: m?.assetSymbol ?? null };
}

function isExpired(r: DeskRequest, timeoutSec: bigint | null, now: number): boolean {
  return r.status === 'Pending' && timeoutSec !== null && now >= Number(r.requestedAt + timeoutSec);
}

export function recentJson(requests: readonly DeskRequest[], worker: WorkerSnapshot, timeoutSec: bigint | null, now = nowSec()): RecentRequestJson[] {
  return requests.map((r) => {
    const stage = worker.requests.get(r.id.toString())?.stage ?? null;
    return { request: requestJson(r), vault: vaultLabel(r.subjectChainId, r.subject), stage, ...listLabel(r.status, stage, isExpired(r, timeoutSec, now)) };
  });
}

/** Pending requests for one subject among the latest 100: "already in progress" on /check. */
export async function pendingFor(address: string): Promise<{ id: string; stage: string | null }[]> {
  const [recent, worker] = await Promise.all([recentRequests(100), readWorkerStatus()]);
  return recent
    .filter((r) => r.status === 'Pending' && r.subject.toLowerCase() === address.toLowerCase())
    .map((r) => ({ id: r.id.toString(), stage: worker.requests.get(r.id.toString())?.stage ?? null }));
}

/** The vault page, badge and API paths for a subject. */
export function vaultPaths(chainId: number, address: string) {
  const a = address.toLowerCase();
  return { vaultPath: `/v/${chainId}/${a}`, badgePath: `/badge/check/${chainId}/${a}.svg`, apiPath: `/api/v1/vaults/${chainId}/${a}` };
}

/** The report a fulfilled request produced: the one its attestation hashes, else the worker's reportPath, else the latest. */
async function resultOf(r: DeskRequest, worker: WorkerSnapshot, reader: ContractReader): Promise<ResultJson | null> {
  const registry = registryAddress();
  const txs = await attestationTxHashes(registry);
  const attestation = await memo(`att-id:${registry}:${r.attestationId}`, 60_000, () => readAttestationById(reader, registry, r.attestationId, txs)).catch(() => null);
  const reports = await vaultReports(r.subjectChainId, r.subject);
  let candidate = attestation ? reports.find((c) => c.reportHash.toLowerCase() === attestation.reportHash.toLowerCase()) : undefined;
  const w = worker.requests.get(r.id.toString());
  if (!candidate && w?.reportPath) candidate = (await reportAtPath(w.reportPath, repoRoot())) ?? undefined;
  const built = loadVaultDetail(String(r.subjectChainId), r.subject.toLowerCase());
  if (!candidate && built && attestation && built.reportHash.toLowerCase() === attestation.reportHash.toLowerCase()) {
    candidate = { report: built.report, file: built.row.reportPath.replace(/^\/reports\//, ''), reportHash: built.reportHash, suiteHash: built.suiteHash };
  }
  // Named by the registry's attestation or the desk worker; the latest report is a fallback.
  const named = candidate !== undefined;
  candidate ??= reports[0];
  if (!candidate) return null;

  const live = await liveAttestation(r.subjectChainId, r.subject, reader).catch(() => ({ kind: 'unread' as const, reason: 'registry not read' }));
  const at = new Date().toISOString();
  const detail: VaultDetail =
    built && built.reportHash.toLowerCase() === candidate.reportHash.toLowerCase()
      ? built
      : detailFromRuntime(candidate, cachedBoard(), vaultMeta(), viewOfLive(live, candidate, at), registryReadOf(live, at));
  const results = detail.report.results;
  const split = results.filter((x) => !x.id.startsWith('sf-')).length;
  // Levels are read from the logs, as the board reads them, only on a report the registry, the desk worker or the
  // board names; on the fallback only the ids count, and they never read as rounding.
  const failures = results.filter((x) => x.status === 'fail');
  const classes = named || detail === built ? failedPropertiesOf(failures) : null;
  const paths = vaultPaths(r.subjectChainId, r.subject);
  const own = attestation ?? (live.kind === 'attested' ? live.record : null);
  return {
    ...paths,
    status: detail.row.status,
    summary: detail.report.summary,
    total: results.length,
    cells: detail.row.cells,
    split,
    failed: failures.map((x, i) => {
      const c = classes?.[i];
      const f = describeFailure(x.reason, c ? x : undefined);
      return { id: x.id, finding: f.finding, rule: f.rule, ...(c?.topic ? { topic: c.topic } : {}), ...(c?.delta ? { delta: c.delta, amount: c.amount } : {}) };
    }),
    blockNumber: detail.report.blockNumber,
    startedAt: detail.report.startedAt,
    reportHash: detail.reportHash,
    reportPath: detail.row.reportPath,
    attestation: own
      ? {
          id: own.id,
          status: own.status,
          isCompliant: live.kind === 'attested' && live.record.id === own.id ? live.record.compliant : null,
          matchesReport: own.reportHash.toLowerCase() === detail.reportHash.toLowerCase(),
          txHash: own.txHash ?? w?.txs.attest ?? null,
        }
      : null,
    reproduce: reproduceCommand(detail.report),
  };
}

export async function requestView(id: bigint, reader: ContractReader = testnetClient()): Promise<RequestViewJson | { error: 'not-deployed' } | { error: 'not-found' }> {
  const desk = deskAddress();
  if (!desk) return { error: 'not-deployed' };
  const [r, { summary }, worker] = await Promise.all([deskRequest(id, reader), deskSummary(reader), readWorkerStatus()]);
  if (!r) return { error: 'not-found' };
  const w = worker.requests.get(id.toString()) ?? null;
  const progress = computeProgress({ status: r.status, requestedAt: r.requestedAt, rejectReason: r.rejectReason, timeoutSec: summary?.timeoutSec ?? null, worker: w, nowSec: nowSec() });
  const result = r.status === 'Fulfilled' ? await resultOf(r, worker, reader).catch(() => null) : null;
  return {
    desk: { address: desk, chainId: DESK_CHAIN_ID, subjectChainId: SUBJECT_CHAIN_ID, standardId: STANDARD_ID },
    request: requestJson(r),
    vault: vaultLabel(r.subjectChainId, r.subject),
    worker: {
      available: worker.available,
      problem: worker.problem,
      stage: w?.stage ?? null,
      updatedAt: w ? (typeof w.updatedAt === 'number' ? new Date(w.updatedAt * 1000).toISOString() : w.updatedAt) : null,
      error: w?.error ?? null,
      txs: w?.txs ?? {},
      gasCostWei: w?.gasCostWei ?? null,
    },
    timeoutSec: s(summary?.timeoutSec ?? null),
    progress,
    result,
    readAt: new Date().toISOString(),
  };
}

export async function deskView(reader: ContractReader = testnetClient()): Promise<DeskViewJson> {
  const { desk, summary, error } = await deskSummary(reader);
  const worker = await readWorkerStatus();
  let scanned: DeskRequest[] = [];
  if (desk && summary?.requestCount) {
    const ids = latestIds(summary.requestCount, SCAN_LIMIT);
    scanned = await memo(`desk:${desk}:scan:${summary.requestCount}`, 15_000, () => readRequests(reader, desk, ids)).catch(() => []);
  }
  const now = nowSec();
  const timeout = summary?.timeoutSec ?? null;
  const counts =
    desk && summary?.requestCount !== null && summary?.requestCount !== undefined
      ? countRequests(scanned, { total: Number(summary.requestCount), nowSec: now, timeoutSec: timeout === null ? null : Number(timeout) })
      : null;
  const economics = computeEconomics({
    feeWei: summary?.feeWei ?? null,
    earnedWei: summary?.earnedWei ?? null,
    withdrawnWei: summary?.withdrawnWei ?? null,
    escrowedWei: summary?.escrowedWei ?? null,
    counts,
    gasCostWei: worker.totals?.gasCostWei ?? null,
    workerFulfilled: worker.totals?.fulfilled ?? null,
    workerRejected: worker.totals?.rejected ?? null,
  });
  return {
    summary: summaryJson(desk, summary, error ? [error] : []),
    economics: economicsJson(economics),
    recent: recentJson(scanned.slice(0, 12), worker, timeout, now),
    worker: { available: worker.available, problem: worker.problem, fulfilled: worker.totals?.fulfilled ?? null, rejected: worker.totals?.rejected ?? null },
  };
}
