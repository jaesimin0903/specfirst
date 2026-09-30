import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeAbiParameters, keccak256, toHex } from 'viem';
import { z } from 'zod';
import { canonicalJson } from '@specfirst/core/hash';
import { compareCandidates, type CheckCandidate } from '../board/aggregate';
import type { ReportView } from '../board/types';
import { checksDir, isInside } from './paths';

/*
 * Check reports read at request time from certs/checks/<chainId>/<address>/*.json, the directory `cert attest`
 * (and so the worker) writes to. The board reads the same directory at build time with core's full schema; here
 * a shape check covers the fields the pages use, and the two hashes are recomputed the way core does
 * (test/desk-reports.test.ts compares both with core on the board fixtures).
 */

const hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const status = z.enum(['pass', 'fail', 'inconclusive', 'not_applicable']);
const counts = z.object({ pass: z.number(), fail: z.number(), inconclusive: z.number(), notApplicable: z.number() });

export const reportShapeSchema = z
  .object({
    schemaVersion: z.number(),
    chainId: z.number().int().positive(),
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    blockNumber: z.string().regex(/^\d+$/),
    standard: z.string(),
    upstream: z.object({ repo: z.string(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).passthrough(),
    harnessSha256: hex,
    sfPropertiesSha256: hex,
    runs: z.number(),
    delta: z.string(),
    seed: z.string().nullable(),
    sender: z.string().nullable(),
    toolchain: z
      .object({
        forgeVersion: z.string().nullable(),
        forgeStd: z.object({ repo: z.string(), commit: z.string().regex(/^[0-9a-f]{40}$/) }).passthrough(),
        foundryTomlSha256: hex,
        maxTestRejects: z.number(),
      })
      .passthrough(),
    identity: z
      .object({
        codeHash: z.string(),
        codeSize: z.number(),
        implementationKey: z.string(),
        implementationKeyKind: z.object({ of: z.enum(['implementation', 'self']), hash: z.string() }).passthrough(),
      })
      .passthrough(),
    results: z.array(z.object({ id: z.string(), test: z.string(), description: z.string(), status }).passthrough()).min(1),
    summary: counts,
    startedAt: z.string(),
    durationMs: z.number(),
  })
  .passthrough();

const suiteTuple = [
  {
    type: 'tuple',
    components: [
      { name: 'standard', type: 'string' },
      { name: 'upstreamRepo', type: 'string' },
      { name: 'upstreamCommit', type: 'bytes20' },
      { name: 'forgeStdCommit', type: 'bytes20' },
      { name: 'forgeVersion', type: 'string' },
      { name: 'harnessSha256', type: 'bytes32' },
      { name: 'sfPropertiesSha256', type: 'bytes32' },
      { name: 'propertiesHash', type: 'bytes32' },
      { name: 'foundryTomlSha256', type: 'bytes32' },
      { name: 'runs', type: 'uint256' },
      { name: 'maxTestRejects', type: 'uint256' },
      { name: 'delta', type: 'uint256' },
    ],
  },
] as const;

/** keccak256 of the report's canonical JSON: core's checkReportHash. */
export function reportHashOf(report: unknown): `0x${string}` {
  return keccak256(toHex(canonicalJson(report)));
}

/** keccak256(abi.encode(Suite)): core's suiteHash(suiteOf(report)). */
export function suiteHashOf(r: ReportView): `0x${string}` {
  const propertiesHash = keccak256(toHex(canonicalJson(r.results.map(({ id, test, description }) => ({ id, test, description })))));
  return keccak256(
    encodeAbiParameters(suiteTuple, [
      {
        standard: r.standard,
        upstreamRepo: r.upstream.repo,
        upstreamCommit: `0x${r.upstream.commit}`,
        forgeStdCommit: `0x${r.toolchain.forgeStd.commit}`,
        forgeVersion: r.toolchain.forgeVersion ?? '',
        harnessSha256: r.harnessSha256 as `0x${string}`,
        sfPropertiesSha256: r.sfPropertiesSha256 as `0x${string}`,
        propertiesHash,
        foundryTomlSha256: r.toolchain.foundryTomlSha256 as `0x${string}`,
        runs: BigInt(r.runs),
        maxTestRejects: BigInt(r.toolchain.maxTestRejects),
        delta: BigInt(r.delta),
      },
    ]),
  );
}

/** Parses one report file's text; null when it is not JSON or not report-shaped. */
export function candidateFromText(text: string, file: string): CheckCandidate | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = reportShapeSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Hash the file's own values, not zod's output: a passthrough parse keeps them, but the raw object is what core hashed.
  const report = raw as ReportView;
  return { report, file, reportHash: reportHashOf(raw), suiteHash: suiteHashOf(report) };
}

const CHAIN_RE = /^\d{1,12}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Every report for one vault under `dir`, newest first. The address directory may be in any letter case. */
export async function vaultReports(chainId: string | number, address: string, dir: string = checksDir()): Promise<CheckCandidate[]> {
  const chain = String(chainId);
  if (!CHAIN_RE.test(chain) || !ADDRESS_RE.test(address)) return [];
  let dirs: string[];
  try {
    dirs = await readdir(path.join(dir, chain));
  } catch {
    return [];
  }
  const match = dirs.filter((d) => d.toLowerCase() === address.toLowerCase());
  const out: CheckCandidate[] = [];
  for (const d of match) {
    const vaultDir = path.join(dir, chain, d);
    let files: string[];
    try {
      files = (await readdir(vaultDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.forge.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const c = candidateFromText(await readFile(path.join(vaultDir, f), 'utf8'), `${chain}/${d}/${f}`);
        if (c && String(c.report.chainId) === chain && c.report.address.toLowerCase() === address.toLowerCase()) out.push(c);
      } catch {
        // A file the worker is still writing: skip it this time.
      }
    }
  }
  return out.sort(compareCandidates);
}

export async function latestVaultReport(chainId: string | number, address: string, dir: string = checksDir()): Promise<CheckCandidate | null> {
  return (await vaultReports(chainId, address, dir))[0] ?? null;
}

/**
 * A report file named by the worker (status.json reportPath), relative to the repository or absolute. Only files
 * inside the checks directory or the repository's .specfirst directory are read.
 */
export async function reportAtPath(p: string, root: string, dir: string = checksDir()): Promise<CheckCandidate | null> {
  const abs = path.resolve(root, p);
  if (!abs.endsWith('.json') || !(isInside(dir, abs) || isInside(path.join(root, '.specfirst'), abs))) return null;
  try {
    const rel = isInside(dir, abs) ? path.relative(dir, abs).split(path.sep).join('/') : path.basename(abs);
    return candidateFromText(await readFile(abs, 'utf8'), rel);
  } catch {
    return null;
  }
}
