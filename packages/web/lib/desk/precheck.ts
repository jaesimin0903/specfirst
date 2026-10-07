import { getAddress, isAddress, parseAbi } from 'viem';
import type { CheckCandidate, VaultMetaEntry } from '../board/aggregate';
import { failedPropertiesOf, vaultStatusOf } from '../board/aggregate';
import { failureLevelOf, type FailureLevel } from '../board/levels';
import { formatBlock } from '../board/reasons';
import type { VaultDetail, VaultStatus, StatusCounts } from '../board/types';
import { describeReadError } from '../board/attestations';
import type { LiveAttestation } from './registry';
import type { ContractReader } from './read';
import { SUBJECT_CHAIN_ID, SUBJECT_CHAIN_NAME } from './config';

/*
 * What the desk can tell a requester before they pay: is this a contract on Monad mainnet, does it answer
 * asset() like an ERC-4626 vault, and what does Specfirst already know about it (board result, a newer requested
 * report, an attestation, a check in progress). Everything is read, nothing is sent. Dependencies are injected so
 * the tests run without a chain.
 */

export const erc4626ReadAbi = parseAbi([
  'function asset() view returns (address)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalAssets() view returns (uint256)',
]);

/** ERC-7535's sentinel for the native coin. */
export const NATIVE_ASSET_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export interface PrecheckDeps {
  mainnet: ContractReader & { getBytecode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined> };
  boardDetail(chainId: number, address: string): VaultDetail | null;
  latestReport(chainId: number, address: string): Promise<CheckCandidate | null>;
  attestation(chainId: number, address: string): Promise<LiveAttestation>;
  /** Pending desk requests for this subject; omitted when the desk is not deployed. */
  pending?(address: string): Promise<{ id: string; stage: string | null }[]>;
  meta(chainId: number, address: string): VaultMetaEntry | null;
}

export interface PrecheckContract {
  isContract: boolean;
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  asset: `0x${string}` | null;
  assetSymbol: string | null;
  assetDecimals: number | null;
  /** base units, decimal string */
  totalAssets: string | null;
  protocol: string | null;
}

export interface PrecheckReport {
  status: VaultStatus;
  summary: StatusCounts;
  blockNumber: string;
  startedAt: string;
  /** board: in the prerendered board data; requested: a newer report from a paid check. */
  source: 'board' | 'requested';
  /**
   * lib/board/levels FailureLevel, read from the failures' logs as the board reads them when the report is the
   * board's or the one the registry's latest attestation hashes; else from the failed ids alone. Null: none failed.
   */
  failureLevel: FailureLevel | null;
}

export type PrecheckAttestation =
  | { kind: 'attested'; id: string; status: string; isCompliant: boolean | null; blockNumber: string; matchesLatestReport: boolean | null }
  | { kind: 'none' }
  | { kind: 'unread'; reason: string };

export interface PrecheckResult {
  input: string;
  chainId: number;
  /** checksummed; null when the input is not an address */
  address: `0x${string}` | null;
  /** Nothing blocks a request. */
  ok: boolean;
  contract: PrecheckContract | null;
  onBoard: boolean;
  latestReport: PrecheckReport | null;
  attestation: PrecheckAttestation | null;
  pending: { id: string; stage: string | null }[];
  /** Why a request would be rejected (and the fee returned): shown instead of the pay button. */
  blockers: string[];
  /** What the requester should know first. */
  notes: string[];
}

function fail(input: string, chainId: number, blocker: string, address: `0x${string}` | null = null): PrecheckResult {
  return { input, chainId, address, ok: false, contract: null, onBoard: false, latestReport: null, attestation: null, pending: [], blockers: [blocker], notes: [] };
}

function settledValue<T>(s: PromiseSettledResult<unknown>): T | null {
  return s.status === 'fulfilled' ? (s.value as T) : null;
}

export async function precheckVault(input: string, chainId: number, deps: PrecheckDeps): Promise<PrecheckResult> {
  const raw = input.trim();
  if (chainId !== SUBJECT_CHAIN_ID) return fail(raw, chainId, `The desk checks vaults on ${SUBJECT_CHAIN_NAME} (chain ${SUBJECT_CHAIN_ID}) only.`);
  if (!isAddress(raw, { strict: false })) return fail(raw, chainId, 'That is not an address: expected 0x followed by 40 hex characters.');
  const address = getAddress(raw);
  const lower = address.toLowerCase();

  let code: `0x${string}` | undefined;
  try {
    code = await deps.mainnet.getBytecode({ address });
  } catch (err) {
    return fail(raw, chainId, `Could not read ${SUBJECT_CHAIN_NAME}: ${describeReadError(err).replace(/\.$/, '')}. Try again in a moment.`, address);
  }
  const meta = deps.meta(chainId, lower);
  if (!code || code === '0x') {
    const r = fail(raw, chainId, `There is no contract at this address on ${SUBJECT_CHAIN_NAME}. The worker would reject the request and return the fee.`, address);
    return { ...r, contract: { isContract: false, name: null, symbol: null, decimals: null, asset: null, assetSymbol: null, assetDecimals: null, totalAssets: null, protocol: meta?.protocol ?? null } };
  }

  const call = (functionName: 'asset' | 'name' | 'symbol' | 'decimals' | 'totalAssets', target: `0x${string}` = address) =>
    deps.mainnet.readContract({ address: target, abi: erc4626ReadAbi, functionName });
  const [asset, name, symbol, decimals, totalAssets] = await Promise.allSettled([call('asset'), call('name'), call('symbol'), call('decimals'), call('totalAssets')]);
  const assetAddr = settledValue<`0x${string}`>(asset);
  const native = assetAddr?.toLowerCase() === NATIVE_ASSET_SENTINEL.toLowerCase();
  let assetSymbol: string | null = null;
  let assetDecimals: number | null = null;
  if (assetAddr && !native) {
    const [s, d] = await Promise.allSettled([call('symbol', assetAddr), call('decimals', assetAddr)]);
    assetSymbol = settledValue<string>(s);
    const dv = settledValue<number | bigint>(d);
    assetDecimals = dv === null ? null : Number(dv);
  }
  const dec = settledValue<number | bigint>(decimals);
  const contract: PrecheckContract = {
    isContract: true,
    name: settledValue<string>(name) ?? meta?.name ?? null,
    symbol: settledValue<string>(symbol),
    decimals: dec === null ? null : Number(dec),
    asset: assetAddr,
    assetSymbol: native ? 'MON (native)' : (assetSymbol ?? meta?.assetSymbol ?? null),
    assetDecimals,
    totalAssets: (() => {
      const v = settledValue<bigint>(totalAssets);
      return v === null ? null : v.toString();
    })(),
    protocol: meta?.protocol ?? null,
  };

  const blockers: string[] = [];
  const notes: string[] = [];
  if (!assetAddr) blockers.push("asset() did not answer, so this is not an ERC-4626 vault. The worker would reject the request and return the fee.");
  if (native) notes.push("asset() is the ERC-7535 native-coin sentinel. Both suites fund test users with ERC-20 transfers, so expect every property to come back not applicable.");

  const board = deps.boardDetail(chainId, lower);
  const [latest, att, pending] = await Promise.all([
    deps.latestReport(chainId, lower).catch(() => null),
    deps.attestation(chainId, lower).catch((err): LiveAttestation => ({ kind: 'unread', reason: describeReadError(err) })),
    deps.pending ? deps.pending(lower).catch(() => []) : Promise.resolve([]),
  ]);

  let latestReport: PrecheckReport | null = null;
  const boardNewest = board && (!latest || latest.reportHash.toLowerCase() === board.reportHash.toLowerCase() || BigInt(board.report.blockNumber) >= BigInt(latest.report.blockNumber));
  if (board && boardNewest) {
    const failureLevel = failureLevelOf(failedPropertiesOf(board.report.results));
    latestReport = { status: board.row.status, summary: board.report.summary, blockNumber: board.report.blockNumber, startedAt: board.report.startedAt, source: 'board', failureLevel };
  } else if (latest) {
    const failed = failedPropertiesOf(latest.report.results);
    const attested = att.kind === 'attested' && att.record.reportHash.toLowerCase() === latest.reportHash.toLowerCase();
    const failureLevel = failureLevelOf(attested ? failed : failed.map(({ id }) => ({ id })));
    latestReport = { status: vaultStatusOf(latest.report.summary), summary: latest.report.summary, blockNumber: latest.report.blockNumber, startedAt: latest.report.startedAt, source: 'requested', failureLevel };
  }
  const latestHash = board && boardNewest ? board.reportHash : (latest?.reportHash ?? null);

  let attestation: PrecheckAttestation;
  if (att.kind === 'attested') {
    const r = att.record;
    attestation = {
      kind: 'attested',
      id: r.id,
      status: r.status,
      isCompliant: r.compliant,
      blockNumber: r.blockNumber,
      matchesLatestReport: latestHash ? r.reportHash.toLowerCase() === latestHash.toLowerCase() : null,
    };
  } else attestation = att;

  if (latestReport) {
    notes.push(
      `Checked before at block ${formatBlock(latestReport.blockNumber)}${latestReport.source === 'board' ? ' for the board' : ''}. A new request checks the vault again at the latest block and attests the new report.`,
    );
  }
  if (pending.length > 0) notes.push(`A check for this vault is already in progress (request #${pending[0]!.id}). A second request would run the same check again.`);

  return { input: raw, chainId, address, ok: blockers.length === 0, contract, onBoard: Boolean(board), latestReport, attestation, pending, blockers, notes };
}
