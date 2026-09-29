import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createPublicClient, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { rpcTransport } from '../chain/transport.js';
import { writeJson } from '../deploy/deploy.js';
import { sha256Hex } from '../spec/hash.js';
import { ERC4626_CONTROL_PATH, ERC4626_HARNESS_PATH, ERC4626_PROPERTIES, ERC4626_UPSTREAM, erc4626SourceFile } from './erc4626.js';
import { identifyImplementation, type IdentityClient, type ImplementationIdentity } from './identity.js';
import {
  parseStandardForgeJson,
  STANDARD_CHECK_SCHEMA_VERSION,
  standardCheckReportSchema,
  summarize,
  type StandardCheckReport,
  type StandardName,
  type StandardPropertyResult,
} from './report.js';
import { prepareErc4626Workspace, type StandardWorkspace } from './workspace.js';

export const CHECKS_DIR = '.specfirst/checks';
export const DEFAULT_STANDARD_RUNS = 32;
/** A full ERC-4626 suite at 32 runs took about 10 minutes against a live Monad mainnet vault. */
export const DEFAULT_STANDARD_TIMEOUT_SEC = 3600;

/** ERC-7535 sentinel a native-asset vault returns from asset(). */
export const ERC7535_NATIVE_ASSET: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const NATIVE_ASSET_REASON =
  `asset() is the ERC-7535 native-asset sentinel ${ERC7535_NATIVE_ASSET}: the harness funds users with ERC-20 deal and approve, which a native-asset vault does not take`;

const assetAbi = [{ type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;

export class StandardCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StandardCheckError';
  }
}

/** `<projectDir>/.specfirst/checks/<chainId>/<address, lowercase>/<block>.json`. */
export function standardCheckPath(projectDir: string, chainId: number, address: string, blockNumber: bigint | string): string {
  return path.join(projectDir, CHECKS_DIR, String(chainId), address.toLowerCase(), `${blockNumber}.json`);
}

export type StandardCheckEvent =
  | { type: 'check-start'; standard: StandardName; chainId: number; address: Address; blockNumber: string; runs: number; delta: string }
  | { type: 'check-identity'; identity: ImplementationIdentity }
  | { type: 'check-workspace'; dir: string; fetched: string[]; harnessSha256: string }
  | { type: 'check-skip'; reason: string }
  | { type: 'check-forge'; args: string[] };

export type StandardCheckClient = IdentityClient & Pick<PublicClient, 'getChainId' | 'getBlockNumber'>;

export interface RunStandardCheckInput {
  standard: StandardName;
  address: Address;
  /** RPC forge forks from; also read for identity unless `client` is given. */
  rpcUrl: string;
  /** Fork block. Default: the latest block when the check starts, recorded in the report. */
  blockNumber?: bigint;
  runs?: number;
  /** Tolerated absolute error in asset base units (SF_DELTA). Default 0. */
  delta?: bigint;
  /** Read client for chain id, block and identity. Default: a rate-limited client on rpcUrl. */
  client?: StandardCheckClient;
  /** Refuse to run when the RPC reports another chain. */
  expectedChainId?: number;
  cacheDir?: string;
  forgeBin?: string;
  timeoutSec?: number;
  /** Where to write the validated report; nothing is written when omitted. */
  recordPath?: string;
  /** Where to keep forge's raw --json stdout as evidence; nothing is written when omitted. */
  rawPath?: string;
  onEvent?: (e: StandardCheckEvent) => void;
}

async function runForgeSuite(i: {
  ws: StandardWorkspace;
  matchPath: string;
  rpcUrl: string;
  blockNumber: bigint;
  runs: number;
  env: Record<string, string>;
  forgeBin?: string;
  timeoutSec?: number;
  rawPath?: string;
  onEvent?: (e: StandardCheckEvent) => void;
}): Promise<StandardPropertyResult[]> {
  // forge replays persisted fuzz failures first; a fresh directory keeps one vault's counterexample
  // from shaping the next vault's run in the shared workspace.
  const persist = await mkdtemp(path.join(tmpdir(), 'specfirst-standard-'));
  const args = [
    'test',
    '--match-path',
    i.matchPath,
    '--fork-url',
    i.rpcUrl,
    '--fork-block-number',
    i.blockNumber.toString(),
    '--fuzz-runs',
    String(i.runs),
    // Public RPCs rate-limit (Monad's answers HTTP 429 above 50 rps); retry longer than forge's default.
    '--fork-retries',
    '10',
    '--fork-retry-backoff',
    '2000',
    '--json',
    // -vv puts decoded logs (the upstream "a <=~ b" lines) into the JSON; traces stay out.
    '-vv',
  ];
  i.onEvent?.({ type: 'check-forge', args: args.map((a) => (a === i.rpcUrl ? '<rpc>' : a)) });
  const timeoutSec = i.timeoutSec ?? DEFAULT_STANDARD_TIMEOUT_SEC;
  try {
    const proc = await execa(i.forgeBin ?? 'forge', args, {
      cwd: i.ws.dir,
      env: { ...i.env, FOUNDRY_FUZZ_FAILURE_PERSIST_DIR: path.join(persist, 'failures') },
      reject: false,
      timeout: timeoutSec * 1000,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (proc.timedOut) throw new StandardCheckError(`forge timed out after ${timeoutSec}s`);
    // The RPC URL may carry an API key; keep it out of the raw file, reasons and messages.
    const stdout = String(proc.stdout ?? '').split(i.rpcUrl).join('<rpc>');
    if (i.rawPath) {
      await mkdir(path.dirname(i.rawPath), { recursive: true });
      await writeFile(i.rawPath, stdout);
    }
    const results = parseStandardForgeJson(stdout, ERC4626_PROPERTIES);
    if (!results) {
      const out = [String(proc.stderr ?? '').trim(), stdout.trim()].filter(Boolean).join('\n').split(i.rpcUrl).join('<rpc>');
      throw new StandardCheckError(`forge produced no test results (exit ${proc.exitCode}): ${out.split('\n').slice(0, 12).join('\n') || 'no output'}`);
    }
    return results;
  } finally {
    await rm(persist, { recursive: true, force: true });
  }
}

function defaultClient(rpcUrl: string): StandardCheckClient {
  return createPublicClient({ transport: rpcTransport([rpcUrl], { rps: 10 }) }) as unknown as StandardCheckClient;
}

/**
 * Runs a third-party standard property suite against a contract already deployed, on a fork pinned at one
 * block (docs/adr/0003). Nothing is signed or sent: forge executes against a local fork of `rpcUrl`.
 * Steps: chain id and block, implementation identity, asset() (an ERC-7535 native-asset vault is not
 * applicable and skips forge), cached workspace, forge, parse, validate, write.
 */
export async function runStandardCheck(input: RunStandardCheckInput): Promise<StandardCheckReport> {
  if (input.standard !== 'erc4626') throw new StandardCheckError(`unknown standard "${input.standard}" (expected erc4626)`);
  const startedAt = new Date();
  const t0 = Date.now();
  const runs = input.runs ?? DEFAULT_STANDARD_RUNS;
  const delta = input.delta ?? 0n;
  if (!Number.isInteger(runs) || runs <= 0) throw new StandardCheckError(`runs must be a positive integer, got ${runs}`);
  if (delta < 0n) throw new StandardCheckError(`delta must not be negative, got ${delta}`);
  const address = getAddress(input.address);
  const client = input.client ?? defaultClient(input.rpcUrl);

  const chainId = await client.getChainId();
  if (input.expectedChainId !== undefined && chainId !== input.expectedChainId) {
    throw new StandardCheckError(`RPC reports chain ${chainId}, expected ${input.expectedChainId}`);
  }
  const blockNumber = input.blockNumber ?? (await client.getBlockNumber({ cacheTime: 0 }));
  input.onEvent?.({ type: 'check-start', standard: input.standard, chainId, address, blockNumber: blockNumber.toString(), runs, delta: delta.toString() });

  const identity = await identifyImplementation(client, address, blockNumber);
  input.onEvent?.({ type: 'check-identity', identity });
  if (identity.codeSize === 0) throw new StandardCheckError(`no contract code at ${address} on chain ${chainId} block ${blockNumber}`);

  let results: StandardPropertyResult[];
  let upstream = ERC4626_UPSTREAM;
  let harnessSha256: Hex;
  // An asset() that reverts is left to forge, whose setUp failure becomes the recorded reason.
  const asset = await client
    .readContract({ address, abi: assetAbi, functionName: 'asset', blockNumber })
    .catch(() => null);
  if (asset && asset.toLowerCase() === ERC7535_NATIVE_ASSET.toLowerCase()) {
    input.onEvent?.({ type: 'check-skip', reason: NATIVE_ASSET_REASON });
    harnessSha256 = sha256Hex(await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8'));
    results = ERC4626_PROPERTIES.map((p) => ({ id: p.id, test: p.test, description: p.description, status: 'not_applicable', reason: NATIVE_ASSET_REASON }));
  } else {
    const ws = await prepareErc4626Workspace({ cacheDir: input.cacheDir });
    input.onEvent?.({ type: 'check-workspace', dir: ws.dir, fetched: ws.fetched, harnessSha256: ws.harnessSha256 });
    upstream = ws.upstream;
    harnessSha256 = ws.harnessSha256;
    results = await runForgeSuite({
      ws,
      matchPath: ERC4626_HARNESS_PATH,
      rpcUrl: input.rpcUrl,
      blockNumber,
      runs,
      env: { SF_VAULT: address, SF_DELTA: delta.toString() },
      forgeBin: input.forgeBin,
      timeoutSec: input.timeoutSec,
      rawPath: input.rawPath,
      onEvent: input.onEvent,
    });
  }

  const report = standardCheckReportSchema.parse({
    schemaVersion: STANDARD_CHECK_SCHEMA_VERSION,
    chainId,
    address,
    blockNumber: blockNumber.toString(),
    standard: input.standard,
    upstream: { repo: upstream.repo, commit: upstream.commit },
    harnessSha256,
    runs,
    delta: delta.toString(),
    identity,
    results,
    summary: summarize(results),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
  } satisfies StandardCheckReport);
  if (input.recordPath) await writeJson(input.recordPath, report);
  return report;
}

export interface RunErc4626ControlInput {
  /** Live ERC-20 the control vault wraps (SF_ASSET). */
  asset: Address;
  rpcUrl: string;
  blockNumber: bigint;
  runs?: number;
  cacheDir?: string;
  forgeBin?: string;
  timeoutSec?: number;
  rawPath?: string;
}

/**
 * Positive control: the same harness against BrokenVault (previewDeposit over-promises by 1%), created
 * inside the fork over `asset`. A sound harness reports previewDeposit as fail.
 */
export async function runErc4626Control(input: RunErc4626ControlInput): Promise<StandardPropertyResult[]> {
  const ws = await prepareErc4626Workspace({ cacheDir: input.cacheDir });
  return runForgeSuite({
    ws,
    matchPath: ERC4626_CONTROL_PATH,
    rpcUrl: input.rpcUrl,
    blockNumber: input.blockNumber,
    runs: input.runs ?? DEFAULT_STANDARD_RUNS,
    env: { SF_ASSET: getAddress(input.asset) },
    forgeBin: input.forgeBin,
    timeoutSec: input.timeoutSec,
    rawPath: input.rawPath,
  });
}
