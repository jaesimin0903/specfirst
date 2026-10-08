import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';
import { standardCheckReportSchema } from '@specfirst/core';
import { vaultApiSchema, watchVaultSchema, type ReportJson, type VaultApi } from '../src/api.js';
import type { ChainAttestation, LatestRead } from '../src/chain.js';
import { buildVerdict, type ReportRead, type Verdict, type VerdictInput } from '../src/verdict.js';

/*
 * Fixtures: the web API's answers and the report files for three vaults as the live web served them on 2026-10-08,
 * and their latest attestations as CheckAttestationRegistry on Monad testnet returned them the same day.
 * upshift: Upshift earnAUSD, MUST (maxWithdraw and maxRedeem not honored), async-redeem, attestation #15 of an earlier block.
 * tyyield: tyYIELD, rounding only, attestation #24 of the same report.
 * morpho: Steakhouse High Yield USDC (MetaMorpho), 30 of 30, attestation #17 compliant of an earlier block.
 */

export const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const BASE = 'http://localhost:3417';
export const REGISTRY = '0x3754918bBB8481D046D80718a9efe434e353daF7';
export const RPC = 'https://testnet-rpc.monad.xyz';
/** About a day after the three reports were written: fresh under the 48 hour default. */
export const NOW = new Date('2026-10-08T02:00:00.000Z');

export type Name = 'upshift' | 'tyyield' | 'morpho';
export const NAMES: readonly Name[] = ['upshift', 'tyyield', 'morpho'];
export const ADDR: Readonly<Record<Name | 'unknown', Address>> = {
  upshift: getAddress('0xd793c04b87386a6bb84ee61d98e0065fde7fda5e'),
  tyyield: getAddress('0xb4641064f64e2f3aaffc1b4b4a66be75c1c81408'),
  morpho: getAddress('0x802c91d807a8daca257c4708ab264b6520964e44'),
  unknown: getAddress('0x1111111111111111111111111111111111111111'),
};
export const REPORT_FILE: Readonly<Record<Name, string>> = {
  upshift: 'reports/upshift-111224893.json',
  tyyield: 'reports/tyyield-111263642.json',
  morpho: 'reports/morpho-111209140.json',
};

export function fixture(path: string): unknown {
  return JSON.parse(readFileSync(join(FIX, path), 'utf8'));
}

export function fixtureText(path: string): string {
  return readFileSync(join(FIX, path), 'utf8');
}

export function vaultApi(name: Name | 'unknown'): VaultApi {
  return vaultApiSchema.parse(fixture(`api/vault-${name}.json`));
}

export function reportRead(name: Name): ReportRead {
  const json = fixture(REPORT_FILE[name]);
  return { ok: true, json, parsed: standardCheckReportSchema.parse(json) as ReportJson };
}

type RawRead = { attestation: Record<string, string | number>; isCompliant: boolean; issuerCurrent: boolean };
const ATTESTATIONS = fixture('chain/attestations.json') as Record<Name, RawRead>;

/** The registry's answer for a fixture vault, with optional changes. */
export function chainRead(name: Name, patch: Partial<ChainAttestation> & { isCompliant?: boolean; issuerCurrent?: boolean | null } = {}): LatestRead {
  const raw = ATTESTATIONS[name];
  const r = raw.attestation;
  const a: ChainAttestation = {
    id: BigInt(r.id!),
    subjectChainId: BigInt(r.subjectChainId!),
    subject: r.subject as Address,
    blockNumber: BigInt(r.blockNumber!),
    implementationKey: r.implementationKey as `0x${string}`,
    subjectCodeHash: r.subjectCodeHash as `0x${string}`,
    suiteHash: r.suiteHash as `0x${string}`,
    reportHash: r.reportHash as `0x${string}`,
    passCount: Number(r.passCount),
    failCount: Number(r.failCount),
    inconclusiveCount: Number(r.inconclusiveCount),
    notApplicableCount: Number(r.notApplicableCount),
    passedBitmap: BigInt(r.passedBitmap!),
    failedBitmap: BigInt(r.failedBitmap!),
    issuedAt: BigInt(r.issuedAt!),
    issuer: r.issuer as Address,
    status: r.status as ChainAttestation['status'],
    reportURI: String(r.reportURI),
  };
  const { isCompliant, issuerCurrent, ...rest } = patch;
  return { read: 'ok', attestation: { ...a, ...rest }, isCompliant: isCompliant ?? raw.isCompliant, issuerCurrent: issuerCurrent === undefined ? raw.issuerCurrent : issuerCurrent };
}

export const RPC_DOWN: LatestRead = { read: 'unread', reason: 'HTTP request failed. URL: https://testnet-rpc.monad.xyz' };
export const API_DOWN = { ok: false as const, reason: 'Specfirst API at http://localhost:3417 did not answer (fetch failed)' };

export interface VerdictOptions {
  chain?: LatestRead;
  api?: VerdictInput['api'];
  report?: ReportRead | null;
  now?: Date;
  staleHours?: number;
}

/** buildVerdict on a fixture vault, with any part replaced. */
export function verdictOf(name: Name | 'unknown', o: VerdictOptions = {}): Verdict {
  const api = o.api ?? { ok: true as const, vault: vaultApi(name) };
  const report = o.report !== undefined ? o.report : name === 'unknown' || !api.ok ? null : reportRead(name);
  const chain = o.chain ?? (name === 'unknown' ? ({ read: 'none' } as const) : chainRead(name));
  return buildVerdict({
    address: ADDR[name],
    chainId: 143,
    api,
    report,
    chain,
    watch: name === 'unknown' ? watchVaultSchema.parse(fixture('api/watch-vault-unknown.json')) : null,
    apiBase: BASE,
    registry: REGISTRY,
    rpcUrl: RPC,
    staleHours: o.staleHours ?? 48,
    now: o.now ?? NOW,
  });
}
