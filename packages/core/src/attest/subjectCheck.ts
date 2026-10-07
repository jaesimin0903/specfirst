// The steps around one subject check that the desk worker (docs/adr/0005) and the watcher (docs/adr/0006)
// share: the check block, the ERC-4626 pre-check, the suite run with its local record, the report copy under
// certs/checks and the error helpers.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Address, PublicClient } from 'viem';
import { isContractAnswer, isContractFailureMessage, isNodeError, isRateLimited, isRpcServerError, isTransportFailure } from '../chain/transport.js';
import {
  runStandardCheck,
  StandardCheckError,
  standardCheckPath,
  StandardCheckTimeoutError,
  type RunStandardCheckInput,
  type StandardCheckClient,
  type StandardCheckEvent,
} from '../standards/check.js';
import type { StandardCheckReport } from '../standards/report.js';
import { attestationReportPath, checkReportHash, parseCheckReport } from './params.js';

/** Lives with the other error classifiers in chain/transport.ts (identity.ts needs it too). */
export { isContractAnswer };

/** The repository's own public copy of certs/checks, used as the default reportURI base. */
export const DEFAULT_REPORT_BASE_URL = 'https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks';
export const REPORT_BASE_URL_ENV = 'SPECFIRST_REPORT_BASE_URL';
/** The check runs this many blocks below the subject chain's latest block, so every RPC already serves its state. */
export const DEFAULT_BLOCK_LAG = 10n;

export type Erc4626Precheck = { ok: true; asset: Address } | { ok: false; reason: string };

/** The block the check forks at: `lag` below the latest subject block, never below 0. */
export function checkBlockOf(latest: bigint, lag: bigint): bigint {
  return latest > lag ? latest - lag : 0n;
}

/**
 * Whether a failed transaction step counts toward maxTxFailures: a revert (a decoded contract error, or a
 * transaction that reverted) does; an RPC outage, a rate limit or a receipt that did not arrive in time
 * does not, so a short outage never turns into a refund.
 */
export function countsAsFailure(err: unknown): boolean {
  if (isTransportFailure(err) || isRateLimited(err)) return false;
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { errorName?: unknown; name?: unknown; message?: unknown };
    if (typeof e.errorName === 'string' && e.errorName) return true;
    if (e.name === 'ContractFunctionRevertedError') return true;
    if (typeof e.message === 'string' && /\breverted\b/.test(e.message)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** forge's own words when it cannot fork the subject chain: its RPC failed while forge started. */
const FORGE_FORK_FAILURE = /could not instantiate forked environment|failed to get (?:latest )?block|error sending request|max retries exceeded|HTTP error \d{3}/i;

/**
 * True when a step of a subject check failed because the subject chain's RPC did not serve it: a transport
 * failure, a rate limit, a node error, a JSON-RPC server error, or forge failing to fork (a 429 in its
 * output included). Such a failure says nothing about the subject. A forge timeout is not one of them.
 */
export function isSubjectRpcFailure(err: unknown): boolean {
  if (isCheckTimeout(err)) return false;
  if (isTransportFailure(err) || isRateLimited(err) || isNodeError(err) || isRpcServerError(err)) return true;
  return err instanceof StandardCheckError && FORGE_FORK_FAILURE.test(err.message);
}

/** forge ran past its wall-clock budget (StandardCheckTimeoutError, also when it crossed a module boundary). */
export function isCheckTimeout(err: unknown): boolean {
  return err instanceof StandardCheckTimeoutError || (err as { name?: unknown })?.name === 'StandardCheckTimeoutError';
}

/** The custom error name a registry or desk revert carries (errorName, or a decoded data.errorName), anywhere in the cause chain. */
export function errorNameOf(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { errorName?: unknown; data?: { errorName?: unknown } };
    if (typeof e.errorName === 'string' && e.errorName) return e.errorName;
    if (e.data && typeof e.data === 'object' && typeof e.data.errorName === 'string') return e.data.errorName;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** One line of an error, for status.json and events. */
export function errorText(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  const text = e?.shortMessage ?? e?.message ?? String(err);
  return oneLine(text);
}

function oneLine(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.length > 300 ? `${line.slice(0, 297)}...` : line;
}

/**
 * errorText led by what failed, for public text: `revert` or `contract answer` (no data, data that does not
 * decode) only when isContractAnswer says the contract answered; otherwise `rate limit`, `transport failure`
 * or `RPC node error` with the node's own words. viem files a JSON-RPC -32603 under "The contract function
 * ... reverted" whatever the node said, so errorText alone would blame the contract for a node failure. The
 * contract function viem names follows the class; anything else is errorText.
 */
export function classifiedErrorText(err: unknown): string {
  const links: Array<{ name?: unknown; functionName?: unknown; details?: unknown }> = [];
  const seen = new Set<unknown>();
  for (let cur: unknown = err; cur && typeof cur === 'object' && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    links.push(cur as (typeof links)[number]);
  }
  const fn = links.map((e) => e.functionName).find((f): f is string => typeof f === 'string' && f !== '');
  const on = fn ? ` on ${fn}()` : '';
  const words = oneLine(links.map((e) => e.details).find((d): d is string => typeof d === 'string' && d !== '') ?? errorText(err));
  if (isContractAnswer(err)) {
    const oog = isContractFailureMessage(err) && /out ?of ?gas/i.test(errorText(err) + links.map((e) => ` ${String(e.details ?? '')}`).join(''));
    return `${oog ? 'out of gas' : links.some((e) => /Revert/.test(String(e.name))) ? 'revert' : 'contract answer'}${on}: ${errorText(err)}`;
  }
  if (isRateLimited(err)) return `rate limit${on}: ${words}`;
  if (isTransportFailure(err)) return `transport failure${on}: ${words}`;
  if (isNodeError(err) || isRpcServerError(err)) return `RPC node error${on}: ${words}`;
  return errorText(err);
}

/**
 * True when the node failed (a node error or a JSON-RPC server error) and the contract did not answer, so a
 * step that failed this way is tried again rather than counted as the contract's refusal.
 */
export function isNodeFailure(err: unknown): boolean {
  return !isContractAnswer(err) && (isNodeError(err) || isRpcServerError(err));
}

const erc4626ProbeAbi = [
  { type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'totalAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * Pre-check before paying for a suite run: the subject has code at `blockNumber`, and asset() answers a
 * non-zero address and totalAssets() answers, both at that block. A call that reverts, returns nothing or
 * returns data that does not decode means not a vault ({ ok: false }); any other error (transport, rate
 * limit, a node error) is thrown so the caller retries.
 */
export async function precheckErc4626(client: Pick<PublicClient, 'getCode' | 'readContract'>, address: Address, blockNumber: bigint): Promise<Erc4626Precheck> {
  const code = await client.getCode({ address, blockNumber });
  if (!code || code === '0x') return { ok: false, reason: `no contract code at ${address} at block ${blockNumber}` };
  const call = async <T>(functionName: 'asset' | 'totalAssets'): Promise<{ value: T } | { error: string }> => {
    try {
      return { value: (await client.readContract({ address, abi: erc4626ProbeAbi, functionName, blockNumber })) as T };
    } catch (err) {
      // Only an answer from the contract (a revert, no data, data that does not decode) means "not a vault".
      // Anything else, a node error such as "missing trie node" included, is thrown so the caller retries.
      if (isContractAnswer(err)) return { error: errorText(err) };
      throw err;
    }
  };
  const asset = await call<Address>('asset');
  if ('error' in asset) return { ok: false, reason: `asset() failed at block ${blockNumber}: ${asset.error}` };
  if (/^0x0{40}$/i.test(asset.value)) return { ok: false, reason: `asset() is the zero address at block ${blockNumber}` };
  const total = await call<bigint>('totalAssets');
  if ('error' in total) return { ok: false, reason: `totalAssets() failed at block ${blockNumber}: ${total.error}` };
  return { ok: true, asset: asset.value };
}

export interface SubjectCheckInput {
  subjectClient: StandardCheckClient;
  subjectChainId: number;
  /** RPC forge forks from; the same node subjectClient reads. */
  subjectRpcUrl: string;
  projectDir: string;
  runs: number;
  cacheDir?: string;
  /** Wall-clock budget of forge, seconds (runStandardCheck's default when unset: one hour). */
  timeoutSec?: number;
  /** runStandardCheck by default; tests pass a stand-in. */
  runCheck?: (input: RunStandardCheckInput) => Promise<StandardCheckReport>;
  onCheckEvent?: (e: StandardCheckEvent) => void;
}

/**
 * Runs the ERC-4626 suite on `subject` at `block` (runStandardCheck, delta 0), recording the report under
 * .specfirst/checks and forge's JSON next to it, as `specfirst check` does. `run` sets the fuzz seed and a
 * failure-persist directory for this run (the watcher's are per subject); without it both are fresh per run.
 */
export function runSubjectCheck(
  i: SubjectCheckInput,
  subject: Address,
  block: bigint,
  run: { seed?: bigint; failurePersistDir?: string } = {},
): Promise<StandardCheckReport> {
  const recordPath = standardCheckPath(i.projectDir, i.subjectChainId, subject, block);
  return (i.runCheck ?? runStandardCheck)({
    standard: 'erc4626',
    address: subject,
    rpcUrl: i.subjectRpcUrl,
    blockNumber: block,
    runs: i.runs,
    delta: 0n,
    client: i.subjectClient,
    expectedChainId: i.subjectChainId,
    ...(i.cacheDir ? { cacheDir: i.cacheDir } : {}),
    ...(i.timeoutSec !== undefined ? { timeoutSec: i.timeoutSec } : {}),
    ...(run.seed !== undefined ? { seed: run.seed } : {}),
    ...(run.failurePersistDir ? { failurePersistDir: run.failurePersistDir } : {}),
    recordPath,
    rawPath: recordPath.replace(/\.json$/, '.forge.json'),
    ...(i.onCheckEvent ? { onEvent: i.onCheckEvent } : {}),
  });
}

/**
 * Copies a report to certs/checks/<chainId>/<address>/<block>-<hash8>.json under `projectDir` (the cert
 * attest rule) and returns its repository relative path and its public URI under `reportBaseUrl`.
 */
export async function saveReportCopy(projectDir: string, reportBaseUrl: string, report: StandardCheckReport): Promise<{ reportPath: string; reportURI: string }> {
  const file = attestationReportPath(report, checkReportHash(report));
  const reportPath = `certs/checks/${file}`;
  const abs = path.join(projectDir, reportPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, `${JSON.stringify(report, null, 2)}\n`);
  return { reportPath, reportURI: `${reportBaseUrl}/${file}` };
}

/** Reads and validates a report copy by its repository relative path. */
export async function loadReportCopy(projectDir: string, reportPath: string): Promise<StandardCheckReport> {
  return parseCheckReport(await readFile(path.join(projectDir, reportPath), 'utf8'));
}
