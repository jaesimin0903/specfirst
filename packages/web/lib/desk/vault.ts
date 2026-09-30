import { readFileSync } from 'node:fs';
import path from 'node:path';
import { buildRow, compareCandidates, metaFor, type CheckCandidate, type VaultMeta } from '../board/aggregate';
import { attestationViewOf, ATTESTATION_CHAIN_ID, DEFAULT_ATTESTATION_RPC } from '../board/attestations';
import { boardDataDir, loadBoard, loadVaultDetail } from '../board/load';
import type { AttestationView, BoardData, RegistryRead, VaultDetail } from '../board/types';
import { memo } from './cache';
import { testnetClient } from './clients';
import { registryAddress } from './config';
import { latestVaultReport } from './reportFiles';
import { readLatestAttestation, type LiveAttestation } from './registry';
import type { ContractReader } from './read';
import { readWorkerStatus } from './worker';

/*
 * One vault as the site shows it at request time. The board's build-time data is the default; a newer report
 * under certs/checks (a check someone just paid for) replaces it, and a vault the board never had is built from
 * that report alone. Server only.
 */

export type VaultSource = 'board' | 'requested';

export interface ResolvedVault {
  chainId: number;
  /** lowercase */
  address: string;
  detail: VaultDetail | null;
  source: VaultSource | null;
}

const CHAIN_RE = /^\d{1,12}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

let boardCache: { at: number; board: BoardData } | null = null;
/** board.json only changes with a rebuild; read it at most every 30 s. */
export function cachedBoard(now = Date.now()): BoardData {
  if (!boardCache || now - boardCache.at > 30_000) boardCache = { at: now, board: loadBoard() };
  return boardCache.board;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function vaultMeta(): VaultMeta | null {
  return readJson<VaultMeta>(path.join(boardDataDir(), 'vault-meta.json'));
}

/** Attestation id -> tx hash: data/attestation-txs.json for this registry, plus what the worker recorded. */
export async function attestationTxHashes(registry: string): Promise<Record<string, string>> {
  const file = readJson<Record<string, Record<string, Record<string, string>>>>(path.join(boardDataDir(), 'attestation-txs.json'));
  const out: Record<string, string> = { ...(file?.[String(ATTESTATION_CHAIN_ID)]?.[registry.toLowerCase()] ?? {}) };
  const worker = await readWorkerStatus();
  for (const e of worker.requests.values()) if (e.attestationId !== undefined && e.txs.attest) out[e.attestationId] ??= e.txs.attest;
  return out;
}

/** latest() + isCompliant() for one vault, cached 30 s per vault. */
export async function liveAttestation(chainId: number, address: string, reader: ContractReader = testnetClient()): Promise<LiveAttestation> {
  const registry = registryAddress();
  return memo(`att:${registry}:${chainId}:${address.toLowerCase()}`, 30_000, async () =>
    readLatestAttestation(reader, registry, chainId, address as `0x${string}`, await attestationTxHashes(registry)),
  );
}

export function registryReadOf(live: LiveAttestation, at: string): RegistryRead {
  return {
    chainId: ATTESTATION_CHAIN_ID,
    address: registryAddress(),
    rpc: DEFAULT_ATTESTATION_RPC,
    status: live.kind === 'unread' ? 'error' : 'ok',
    error: live.kind === 'unread' ? live.reason : null,
    attestationCount: null,
    readAt: at,
  };
}

export function viewOfLive(live: LiveAttestation, report: { reportHash: string; suiteHash: string }, at: string): AttestationView {
  return attestationViewOf(registryReadOf(live, at), live.kind === 'attested' ? live.record : undefined, report);
}

function boardCandidate(d: VaultDetail): CheckCandidate {
  return { report: d.report, file: d.row.reportPath.replace(/^\/reports\//, ''), reportHash: d.reportHash, suiteHash: d.suiteHash };
}

/** Public path of a report read at request time; app/api/v1/reports serves it. */
export function runtimeReportPath(file: string): string {
  const [chain, addr, name] = file.split('/');
  return `/api/v1/reports/${chain}/${addr!.toLowerCase()}/${name}`;
}

/** A VaultDetail for a report that is not in the board build. Pure apart from its inputs. */
export function detailFromRuntime(c: CheckCandidate, board: BoardData, meta: VaultMeta | null, attestation: AttestationView, registry: RegistryRead): VaultDetail {
  const row = buildRow({ candidate: c, meta: metaFor(meta, c.report.chainId, c.report.address), attestation, reportPath: runtimeReportPath(c.file) });
  const id = row.id;
  const group = board.groups.find((g) => g.key === row.implementationKey);
  const others = (group?.vaultIds ?? []).filter((v) => v !== id);
  const rows = new Map(board.vaults.map((r) => [r.id, r]));
  const siblings = others.slice(0, 60).flatMap((v) => {
    const s = rows.get(v);
    return s ? [{ id: s.id, address: s.address, name: s.name, protocol: s.protocol, status: s.status }] : [];
  });
  return { row: { ...row, groupSize: others.length + 1 }, report: c.report, reportHash: c.reportHash, suiteHash: c.suiteHash, siblings, registry };
}

export interface ResolveOptions {
  /** Read the registry for a report not in the build (default true). Tests pass false or a reader. */
  reader?: ContractReader | null;
  now?: () => Date;
}

export async function resolveVault(chainId: string, address: string, o: ResolveOptions = {}): Promise<ResolvedVault> {
  const addr = address.toLowerCase();
  const base = { chainId: Number(chainId), address: addr };
  if (!CHAIN_RE.test(chainId) || !ADDRESS_RE.test(addr)) return { ...base, detail: null, source: null };
  const built = loadVaultDetail(chainId, addr);
  const runtime = await latestVaultReport(chainId, addr);
  const newer = runtime && (!built || (runtime.reportHash.toLowerCase() !== built.reportHash.toLowerCase() && compareCandidates(runtime, boardCandidate(built)) < 0));
  if (!newer) return { ...base, detail: built, source: built ? 'board' : null };

  const at = (o.now ?? (() => new Date()))().toISOString();
  const live: LiveAttestation =
    o.reader === null ? { kind: 'unread', reason: 'registry not read' } : await liveAttestation(Number(chainId), addr, o.reader ?? testnetClient());
  const detail = detailFromRuntime(runtime, cachedBoard(), vaultMeta(), viewOfLive(live, runtime, at), registryReadOf(live, at));
  return { ...base, detail, source: 'requested' };
}
