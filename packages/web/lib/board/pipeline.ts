import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkReportHash, standardCheckReportSchema, suiteHash, suiteOf, type StandardCheckReport } from '@specfirst/core';
import type { AttestationRecord, BoardData, RegistryRead, ReportView, VaultDetail, VaultRow } from './types';
import {
  blocksOf,
  boardTotals,
  buildRow,
  countUnchecked,
  emptyBoard,
  groupRows,
  metaFor,
  pickLatest,
  propertiesOf,
  propertyTotalsOf,
  reasonCountsOf,
  sortRowsDefault,
  summarizeProtocols,
  tallyReasons,
  vaultId,
  withGroupSizes,
  type CheckCandidate,
  type VaultMeta,
} from './aggregate.ts';
import { attestationViewOf, readAttestations, type RegistryReader } from './attestations.ts';

/*
 * Build-time pipeline behind `pnpm --filter @specfirst/web board:build` (scripts/build-board.mjs). Node only:
 * it imports @specfirst/core's root for the report schema and hashes, which client code must never do.
 */

const CHAIN_DIR = /^\d+$/;
const ADDRESS_DIR = /^0x[0-9a-fA-F]{40}$/;
/** Siblings listed on a vault page; the group total is shown separately. */
const MAX_SIBLINGS = 60;

export interface CollectResult {
  candidates: CheckCandidate[];
  skipped: { file: string; error: string }[];
  /** False when the source directory does not exist (an empty board, not an error). */
  sourceExists: boolean;
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function zodMessage(err: { issues: { path: (string | number)[]; message: string }[] }): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/**
 * Reads `<chainId>/<address>/*.json` under `sourceDir`. forge's own output (`*.forge.json`, kept next to each
 * report by `specfirst check`) is ignored. Any other file that is not a valid StandardCheckReport, or that lies
 * under another chain or address than it names, is listed in `skipped` and left out.
 */
export async function collectReports(sourceDir: string): Promise<CollectResult> {
  if (!(await isDir(sourceDir))) return { candidates: [], skipped: [], sourceExists: false };
  const candidates: CheckCandidate[] = [];
  const skipped: { file: string; error: string }[] = [];
  const chains = (await readdir(sourceDir)).filter((d) => CHAIN_DIR.test(d)).sort();
  for (const chain of chains) {
    const chainPath = path.join(sourceDir, chain);
    if (!(await isDir(chainPath))) continue;
    const addresses = (await readdir(chainPath)).filter((d) => ADDRESS_DIR.test(d)).sort();
    for (const addr of addresses) {
      const addrPath = path.join(chainPath, addr);
      if (!(await isDir(addrPath))) continue;
      const files = (await readdir(addrPath)).filter((f) => f.endsWith('.json') && !f.endsWith('.forge.json')).sort();
      for (const f of files) {
        const rel = [chain, addr, f].join('/');
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(path.join(addrPath, f), 'utf8'));
        } catch {
          skipped.push({ file: rel, error: 'not JSON' });
          continue;
        }
        const parsed = standardCheckReportSchema.safeParse(raw);
        if (!parsed.success) {
          skipped.push({ file: rel, error: `not a StandardCheckReport: ${zodMessage(parsed.error)}` });
          continue;
        }
        const report: StandardCheckReport = parsed.data;
        if (String(report.chainId) !== chain || report.address.toLowerCase() !== addr.toLowerCase()) {
          skipped.push({ file: rel, error: `report is for ${report.chainId}/${report.address} but lies under ${chain}/${addr}` });
          continue;
        }
        candidates.push({
          report: report as ReportView,
          file: rel,
          reportHash: checkReportHash(report),
          suiteHash: suiteHash(suiteOf(report)),
        });
      }
    }
  }
  return { candidates, skipped, sourceExists: true };
}

export function reportPublicPath(file: string): string {
  const [chain, addr, name] = file.split('/');
  return `/reports/${chain}/${addr!.toLowerCase()}/${name}`;
}

export interface AssembleInput {
  candidates: readonly CheckCandidate[];
  meta: VaultMeta | null;
  registry: RegistryRead;
  attestations: Map<string, AttestationRecord>;
  generatedAt: string;
  source: string;
  skipped: { file: string; error: string }[];
}

export interface Assembled {
  board: BoardData;
  details: VaultDetail[];
  /** Latest report file of each vault, relative to the source directory. */
  latestFiles: string[];
}

/** Everything the pages need, from reports already chosen and read. Pure. */
export function assembleBoard(i: AssembleInput): Assembled {
  const latest = pickLatest(i.candidates);
  if (latest.length === 0) {
    const board = { ...emptyBoard(i.registry, i.generatedAt, i.source), skipped: i.skipped };
    board.totals = boardTotals([], countUnchecked(i.meta, []));
    return { board, details: [], latestFiles: [] };
  }
  const byId = new Map<string, CheckCandidate>();
  let rows: VaultRow[] = latest.map((c) => {
    const id = vaultId(c.report.chainId, c.report.address);
    byId.set(id, c);
    return buildRow({
      candidate: c,
      meta: metaFor(i.meta, c.report.chainId, c.report.address),
      attestation: attestationViewOf(i.registry, i.attestations.get(id), c),
      reportPath: reportPublicPath(c.file),
    });
  });
  const groups = groupRows(rows);
  rows = sortRowsDefault(withGroupSizes(rows, groups));

  const board: BoardData = {
    version: 1,
    generatedAt: i.generatedAt,
    source: i.source,
    standard: 'erc4626',
    blocks: blocksOf(rows),
    runs: [...new Set(latest.map((c) => c.report.runs))].sort((a, b) => a - b),
    properties: propertiesOf(latest.map((c) => c.report)),
    totals: boardTotals(rows, countUnchecked(i.meta, rows)),
    propertyTotals: propertyTotalsOf(rows),
    reasons: tallyReasons(latest.map((c) => reasonCountsOf(c.report.results))),
    protocols: summarizeProtocols(rows),
    groups,
    vaults: rows,
    registry: i.registry,
    skipped: i.skipped,
  };

  const rowById = new Map(rows.map((r) => [r.id, r]));
  const details: VaultDetail[] = rows.map((row) => {
    const c = byId.get(row.id)!;
    const group = groups.find((g) => g.key === row.implementationKey);
    const siblings = (group?.vaultIds ?? [])
      .filter((id) => id !== row.id)
      .slice(0, MAX_SIBLINGS)
      .map((id) => {
        const s = rowById.get(id)!;
        return { id: s.id, address: s.address, name: s.name, protocol: s.protocol, status: s.status };
      });
    return { row, report: c.report, reportHash: c.reportHash, suiteHash: c.suiteHash, siblings, registry: i.registry };
  });

  return { board, details, latestFiles: latest.map((c) => c.file) };
}

export interface BuildBoardOptions {
  sourceDir: string;
  /** Shown on the board; defaults to sourceDir. */
  sourceLabel?: string;
  /** packages/web/data */
  dataDir: string;
  /** packages/web/public */
  publicDir: string;
  meta: VaultMeta | null;
  registry: { chainId: number; address: string; rpc: string };
  /** null: do not read the registry (offline); `skippedBecause` explains why on the page. */
  client: RegistryReader | null;
  skippedBecause?: string;
  abi: readonly unknown[];
  standardId: string;
  txHashes?: Readonly<Record<string, string>>;
  now?: () => Date;
}

export interface BuildBoardResult extends Assembled {
  sourceExists: boolean;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Collects reports, reads the registry for the vaults found, and writes:
 *   <dataDir>/board.json, <dataDir>/vaults/<chainId>/<address>.json, <publicDir>/reports/<chainId>/<address>/<file>
 * The two generated directories are emptied first, so a vault that left the source leaves the site too.
 */
export async function buildBoard(o: BuildBoardOptions): Promise<BuildBoardResult> {
  const now = o.now ?? (() => new Date());
  const { candidates, skipped, sourceExists } = await collectReports(o.sourceDir);
  const latest = pickLatest(candidates);
  const subjects = latest.map((c) => ({ chainId: c.report.chainId, address: c.report.address }));
  const read =
    subjects.length === 0
      ? await readAttestations({ ...o, client: null, skippedBecause: 'no reports to look up', subjects, now })
      : await readAttestations({ ...o, subjects, now });

  const assembled = assembleBoard({
    candidates,
    meta: o.meta,
    registry: read.registry,
    attestations: read.bySubject,
    generatedAt: now().toISOString(),
    source: o.sourceLabel ?? o.sourceDir,
    skipped,
  });

  const vaultsDir = path.join(o.dataDir, 'vaults');
  const reportsDir = path.join(o.publicDir, 'reports');
  await rm(vaultsDir, { recursive: true, force: true });
  await rm(reportsDir, { recursive: true, force: true });
  for (const d of assembled.details) {
    const [chain, addr] = d.row.id.split('/');
    await writeJson(path.join(vaultsDir, chain!, `${addr}.json`), d);
  }
  for (const file of assembled.latestFiles) {
    const [chain, addr, name] = file.split('/');
    const dest = path.join(reportsDir, chain!, addr!.toLowerCase(), name!);
    await mkdir(path.dirname(dest), { recursive: true });
    // The original bytes, so anyone can recompute reportHash from what the site serves.
    await copyFile(path.join(o.sourceDir, chain!, addr!, name!), dest);
  }
  await writeJson(path.join(o.dataDir, 'board.json'), assembled.board);
  return { ...assembled, sourceExists };
}

/** Reads data/vault-meta.json; null when the file does not exist. */
export async function readVaultMeta(file: string): Promise<VaultMeta | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as VaultMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** data/attestation-txs.json: registry chainId -> registry address (lowercase) -> attestation id -> tx hash. */
export type AttestationTxFile = Record<string, Record<string, Record<string, string>>>;

export async function readAttestationTxs(file: string, chainId: number, registry: string): Promise<Record<string, string>> {
  try {
    const all = JSON.parse(await readFile(file, 'utf8')) as AttestationTxFile;
    return all[String(chainId)]?.[registry.toLowerCase()] ?? {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
}
