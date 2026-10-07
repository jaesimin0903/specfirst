import { z } from 'zod';
import { describeFailure } from '../board/reasons';
import { propertyLevel } from '../board/levels';
import { txUrl } from '../board/attestations';
import { reproduceArgs } from '../board/reproduce';
import type { PropertyStatus } from '../board/types';
import { checkBadgeOf } from './checkBadge';
import { registryAddress, DESK_CHAIN_ID, STANDARD, STANDARD_ID } from './config';
import type { LiveAttestation } from './registry';
import type { ResolvedVault } from './vault';

/*
 * GET /api/v1/vaults/<chainId>/<address>: one vault for integrators. The report part comes from the latest report
 * the site has (board build or a paid check); the attestation part is read from the registry at request time, so
 * a router can gate on it. vaultApiResponseSchema documents the shape and the tests hold the builder to it.
 */

export const VAULT_API_SCHEMA = 'specfirst.vault.v1';

const propertyStatus = z.enum(['pass', 'fail', 'inconclusive', 'not_applicable']);
const counts = z.object({ pass: z.number(), fail: z.number(), inconclusive: z.number(), notApplicable: z.number() });
const flag = z.boolean().nullable();

export const vaultApiResponseSchema = z.object({
  schema: z.literal(VAULT_API_SCHEMA),
  chainId: z.number(),
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  standard: z.literal(STANDARD),
  standardId: z.string().regex(/^0x[0-9a-f]{64}$/),
  checked: z.boolean(),
  vault: z.object({ name: z.string().nullable(), protocol: z.string().nullable(), assetSymbol: z.string().nullable() }),
  report: z
    .object({
      source: z.enum(['board', 'requested']),
      status: z.enum(['mismatch', 'complete', 'partial', 'not_applicable']),
      blockNumber: z.string().regex(/^\d+$/),
      startedAt: z.string(),
      summary: counts,
      total: z.number(),
      failed: z.array(z.object({ id: z.string(), finding: z.string(), level: z.enum(['must', 'should']) })),
      reportHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      suiteHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      url: z.string(),
    })
    .nullable(),
  /** true: the call accepted every amount up to the max; false: it reverted below it; null: not exercised. */
  maxHonored: z.object({ maxDeposit: flag, maxMint: flag, maxWithdraw: flag, maxRedeem: flag }),
  maxHonoredStatus: z.object({
    maxDeposit: propertyStatus.nullable(),
    maxMint: propertyStatus.nullable(),
    maxWithdraw: propertyStatus.nullable(),
    maxRedeem: propertyStatus.nullable(),
  }),
  attestation: z.object({
    state: z.enum(['attested', 'none', 'unread']),
    id: z.string().nullable(),
    status: z.enum(['None', 'Valid', 'Superseded', 'Revoked']).nullable(),
    isCompliant: z.boolean().nullable(),
    blockNumber: z.string().nullable(),
    reportHash: z.string().nullable(),
    /** The attested reportHash equals the report above. */
    matchesReport: z.boolean().nullable(),
    txHash: z.string().nullable(),
    txUrl: z.string().nullable(),
    registry: z.object({ chainId: z.number(), address: z.string() }),
    reason: z.string().nullable(),
  }),
  badge: z.object({ state: z.enum(['compliant', 'mismatch', 'rounding', 'partial', 'not-attested', 'unavailable']), text: z.string(), url: z.string() }),
  reproduce: z.object({ command: z.string(), args: z.array(z.string()) }).nullable(),
  links: z.object({ page: z.string(), badge: z.string(), report: z.string().nullable(), requestCheck: z.string() }),
  readAt: z.string(),
});
export type VaultApiResponse = z.infer<typeof vaultApiResponseSchema>;

const MAX_IDS = { maxDeposit: 'sf-maxDeposit-honored', maxMint: 'sf-maxMint-honored', maxWithdraw: 'sf-maxWithdraw-honored', maxRedeem: 'sf-maxRedeem-honored' } as const;
type MaxKey = keyof typeof MAX_IDS;

function flagOf(s: PropertyStatus | null): boolean | null {
  return s === 'pass' ? true : s === 'fail' ? false : null;
}

export interface BuildVaultApiInput {
  resolved: ResolvedVault;
  live: LiveAttestation;
  /** "https://specfirst.example" (no trailing slash) */
  origin: string;
  now?: Date;
}

export function buildVaultApi({ resolved, live, origin, now = new Date() }: BuildVaultApiInput): VaultApiResponse {
  const { chainId, address, detail } = resolved;
  const status = (key: MaxKey): PropertyStatus | null => detail?.report.results.find((r) => r.id === MAX_IDS[key])?.status ?? null;
  const statuses = { maxDeposit: status('maxDeposit'), maxMint: status('maxMint'), maxWithdraw: status('maxWithdraw'), maxRedeem: status('maxRedeem') };
  const badge = checkBadgeOf(live);
  const page = `${origin}/v/${chainId}/${address}`;
  const badgeUrl = `${origin}/badge/check/${chainId}/${address}.svg`;
  const rec = live.kind === 'attested' ? live.record : null;
  const report = detail?.report ?? null;
  return {
    schema: VAULT_API_SCHEMA,
    chainId,
    address,
    standard: STANDARD,
    standardId: STANDARD_ID.toLowerCase(),
    checked: Boolean(detail),
    vault: { name: detail?.row.name ?? null, protocol: detail?.row.protocol ?? null, assetSymbol: detail?.row.assetSymbol ?? null },
    report:
      detail && report
        ? {
            source: resolved.source ?? 'board',
            status: detail.row.status,
            blockNumber: report.blockNumber,
            startedAt: report.startedAt,
            summary: report.summary,
            total: report.results.length,
            failed: report.results.filter((r) => r.status === 'fail').map((r) => ({ id: r.id, finding: describeFailure(r.reason, r.id).finding, level: propertyLevel(r.id) })),
            reportHash: detail.reportHash,
            suiteHash: detail.suiteHash,
            url: `${origin}${detail.row.reportPath}`,
          }
        : null,
    maxHonored: { maxDeposit: flagOf(statuses.maxDeposit), maxMint: flagOf(statuses.maxMint), maxWithdraw: flagOf(statuses.maxWithdraw), maxRedeem: flagOf(statuses.maxRedeem) },
    maxHonoredStatus: statuses,
    attestation: {
      state: live.kind,
      id: rec?.id ?? null,
      status: rec?.status ?? null,
      isCompliant: rec ? rec.compliant : live.kind === 'none' ? false : null,
      blockNumber: rec?.blockNumber ?? null,
      reportHash: rec?.reportHash ?? null,
      matchesReport: rec && detail ? rec.reportHash.toLowerCase() === detail.reportHash.toLowerCase() : null,
      txHash: rec?.txHash ?? null,
      txUrl: rec?.txHash ? txUrl(rec.txHash) : null,
      registry: { chainId: DESK_CHAIN_ID, address: registryAddress() },
      reason: live.kind === 'unread' ? live.reason : null,
    },
    badge: { state: badge.state, text: badge.text, url: badgeUrl },
    reproduce: report ? { command: reproduceArgs(report).join(' '), args: reproduceArgs(report) } : null,
    links: { page, badge: badgeUrl, report: detail ? `${origin}${detail.row.reportPath}` : null, requestCheck: `${origin}/check?vault=${address}` },
    readAt: now.toISOString(),
  };
}
