import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { createPublicClient, getAddress, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { rpcTransport } from '../chain/transport.js';
import { sha256Hex } from '../spec/hash.js';
import {
  ERC4626_CHECK_CONTRACTS,
  ERC4626_CHECK_PROPERTIES,
  ERC4626_CONTROL_PATH,
  ERC4626_PROPERTIES,
  ERC4626_UPSTREAM,
  erc4626SourceFile,
  FORGE_STD_PIN,
  type PinnedRepo,
  type StandardProperty,
} from './erc4626.js';
import { identifyImplementation, type IdentityClient, type ImplementationIdentity } from './identity.js';
import {
  extractForgeDoc,
  parseStandardForgeJson,
  skipReasonOf,
  STANDARD_CHECK_SCHEMA_VERSION,
  standardCheckReportSchema,
  summarize,
  type StandardCheckReport,
  type SkipReason,
  type StandardName,
  type VaultKind,
  type StandardPropertyResult,
} from './report.js';
import { ERC4626_FOUNDRY_TOML, EVENTS_DIR, FUZZ_MAX_TEST_REJECTS, prepareErc4626Workspace, type StandardWorkspace } from './workspace.js';

export const CHECKS_DIR = '.specfirst/checks';
export const DEFAULT_STANDARD_RUNS = 32;
/** A full ERC-4626 suite at 32 runs took about 10 minutes against a live Monad mainnet vault. */
export const DEFAULT_STANDARD_TIMEOUT_SEC = 3600;
export const MAX_UINT256 = 2n ** 256n - 1n;

/** ERC-7535 sentinel a native-asset vault returns from asset(). */
export const ERC7535_NATIVE_ASSET: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const NATIVE_ASSET_REASON =
  `asset() is the ERC-7535 native-asset sentinel ${ERC7535_NATIVE_ASSET}: the harness funds users with ERC-20 deal and approve, which a native-asset vault does not take`;

/** Why forge is skipped for an ERC-7575 vault whose shares live in another token. */
export function erc7575Reason(shareToken: Address): string {
  return `ERC-7575 vault: shares are a separate token (share() = ${shareToken}); both suites assume the vault is its own share token and call balanceOf, allowance and approve on it`;
}

const assetAbi = [{ type: 'function', name: 'asset', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;
const shareAbi = [{ type: 'function', name: 'share', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }] as const;

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
  | { type: 'check-skip'; vaultKind: VaultKind; reason: string }
  | { type: 'check-forge'; args: string[]; seed: Hex; sender: Address; forgeVersion: string | null };

export type StandardCheckClient = IdentityClient & Pick<PublicClient, 'getChainId' | 'getBlockNumber'>;

export interface RunStandardCheckInput {
  standard: StandardName;
  address: Address;
  /** RPC forge forks from; also read for identity unless `client` is given. */
  rpcUrl: string;
  /** Fork block. Default: the latest block when the check starts, recorded in the report. */
  blockNumber?: bigint;
  runs?: number;
  /** Tolerated absolute error in asset base units (SF_DELTA). Default 0. At most 2^256 - 1. */
  delta?: bigint;
  /** forge --fuzz-seed. Default: 32 random bytes per run. Recorded either way. */
  seed?: bigint;
  /** forge --sender. Default: a random EOA per run. Recorded either way. */
  sender?: Address;
  /** Read client for chain id, block and identity. Default: a rate-limited client on rpcUrl. */
  client?: StandardCheckClient;
  /** Refuse to run when the RPC reports another chain. */
  expectedChainId?: number;
  cacheDir?: string;
  forgeBin?: string;
  timeoutSec?: number;
  /** Where to write the validated report; nothing is written when omitted. */
  recordPath?: string;
  /**
   * Where to keep forge's --json document as evidence, written together with the report. Nothing is
   * written when omitted, and a stale file is removed when forge did not run.
   */
  rawPath?: string;
  onEvent?: (e: StandardCheckEvent) => void;
  /** Test hook: other pins or local repositories for the workspace. */
  pins?: { upstream?: PinnedRepo; forgeStd?: PinnedRepo };
}


/** Environment variables forge may inherit. Everything else, FOUNDRY_* and ETH_RPC_URL included, is dropped. */
const FORGE_ENV_KEEP = [
  'PATH',
  'HOME',
  'TMPDIR',
  'USER',
  'LANG',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
];

/** Minimal environment for forge: FOUNDRY_* from the caller's shell must not change a check. */
export function forgeEnv(extra: Record<string, string>, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of FORGE_ENV_KEEP) if (base[k] !== undefined) env[k] = base[k]!;
  return { ...env, ...extra };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the RPC URL and its parts (host, key-like path segments and query values, credentials) with
 * `<rpc>`, case-insensitively. forge prints the host alone in some errors, and URLs often carry an API key.
 */
export function maskRpcUrl(text: string, rpcUrl: string): string {
  const secrets = new Set<string>([rpcUrl, rpcUrl.replace(/\/+$/, '')]);
  try {
    const u = new URL(rpcUrl);
    secrets.add(u.href).add(u.href.replace(/\/+$/, '')).add(`${u.host}${u.pathname}`.replace(/\/+$/, '')).add(u.host).add(u.hostname);
    for (const seg of u.pathname.split('/')) if (seg.length >= 6) secrets.add(seg);
    for (const v of u.searchParams.values()) if (v.length >= 6) secrets.add(v);
    if (u.username) secrets.add(u.username);
    if (u.password) secrets.add(u.password);
  } catch {
    /* not a URL: mask the string as given */
  }
  const list = [...secrets].filter((x) => x.length >= 3).sort((a, b) => b.length - a.length);
  if (list.length === 0) return text;
  return text.replace(new RegExp(list.map(escapeRegExp).join('|'), 'gi'), '<rpc>');
}

/** True when a mixed-case address is not its EIP-55 checksum. All-lowercase and all-uppercase carry none. */
export function badChecksum(address: string): boolean {
  const hex = address.slice(2);
  return /[a-f]/.test(hex) && /[A-F]/.test(hex) && getAddress(address) !== address;
}

function randomSender(): Address {
  for (;;) {
    const a = getAddress(`0x${randomBytes(20).toString('hex')}`);
    if (BigInt(a) > 0xffffn) return a;
  }
}

async function forgeVersion(forgeBin: string): Promise<string | null> {
  const p = await execa(forgeBin, ['--version'], { env: forgeEnv({}), extendEnv: false, reject: false });
  return String(p.stdout ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? null;
}

/** Writes via a temp file in the same directory and a rename, so readers never see half a file. */
async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, content);
  await rename(tmp, file);
}

interface ForgeSuiteRun {
  results: StandardPropertyResult[];
  /** The forge --json document, RPC URL masked. */
  raw: string;
  seed: Hex;
  sender: Address;
  forgeVersion: string | null;
}

async function runForgeSuite(i: {
  ws: StandardWorkspace;
  /** forge flags choosing what runs, e.g. --match-contract or --match-path. */
  select: string[];
  properties: readonly StandardProperty[];
  rpcUrl: string;
  blockNumber: bigint;
  runs: number;
  seed?: bigint;
  sender?: Address;
  env: Record<string, string>;
  forgeBin?: string;
  timeoutSec?: number;
  onEvent?: (e: StandardCheckEvent) => void;
}): Promise<ForgeSuiteRun> {
  const forgeBin = i.forgeBin ?? 'forge';
  const seed: Hex = i.seed !== undefined ? toHex(i.seed, { size: 32 }) : `0x${randomBytes(32).toString('hex')}`;
  // A fresh sender per run: forge's default sender is a well-known address a vault could special-case.
  const sender = i.sender ?? randomSender();
  const version = await forgeVersion(forgeBin);
  const mask = (t: string) => maskRpcUrl(t, i.rpcUrl);
  // forge replays persisted fuzz failures first; a fresh directory keeps one vault's counterexample
  // from shaping the next vault's run in the shared workspace.
  const persist = await mkdtemp(path.join(tmpdir(), 'specfirst-standard-'));
  const runId = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  const eventsFile = path.join(i.ws.dir, EVENTS_DIR, `${runId}.deposit-below-max.log`);
  const args = [
    'test',
    ...i.select,
    '--fork-url',
    i.rpcUrl,
    '--fork-block-number',
    i.blockNumber.toString(),
    '--fuzz-runs',
    String(i.runs),
    '--fuzz-seed',
    seed,
    '--sender',
    sender,
    // Public RPCs rate-limit (Monad's answers HTTP 429 above 50 rps). At forge's default 330 compute units
    // per second two runs of the Morpho vault each lost one property to a 429; at 100 the same run was clean
    // and faster (246 s instead of 540 s). Retries cover what still slips through.
    '--compute-units-per-second',
    '100',
    '--fork-retries',
    '10',
    '--fork-retry-backoff',
    '2000',
    '--json',
    // -vv puts decoded logs (the upstream "a <=~ b" lines) into the JSON; traces stay out.
    '-vv',
  ];
  i.onEvent?.({ type: 'check-forge', args: args.map(mask), seed, sender, forgeVersion: version });
  const timeoutSec = i.timeoutSec ?? DEFAULT_STANDARD_TIMEOUT_SEC;
  try {
    await mkdir(path.dirname(eventsFile), { recursive: true });
    const proc = await execa(forgeBin, args, {
      cwd: i.ws.dir,
      env: forgeEnv({ ...i.env, SF_RUN_ID: runId, SF_POOL_SALT: BigInt(seed).toString(), FOUNDRY_FUZZ_FAILURE_PERSIST_DIR: path.join(persist, 'failures') }),
      extendEnv: false,
      reject: false,
      timeout: timeoutSec * 1000,
      maxBuffer: 512 * 1024 * 1024,
    });
    if (proc.timedOut) throw new StandardCheckError(`forge timed out after ${timeoutSec}s`);
    const stdout = mask(String(proc.stdout ?? ''));
    const doc = extractForgeDoc(stdout);
    const events = await readFile(eventsFile, 'utf8').catch(() => '');
    const results = doc ? parseStandardForgeJson(JSON.stringify(doc), i.properties, { depositRevertEvents: events }) : null;
    if (!doc || !results) {
      const out = mask([String(proc.stderr ?? '').trim(), stdout.trim()].filter(Boolean).join('\n'));
      throw new StandardCheckError(`forge produced no test results (exit ${proc.exitCode}): ${out.split('\n').slice(0, 12).join('\n') || 'no output'}`);
    }
    return { results, raw: `${JSON.stringify(doc)}\n`, seed, sender, forgeVersion: version };
  } finally {
    await rm(persist, { recursive: true, force: true });
    await rm(eventsFile, { force: true });
  }
}

function defaultClient(rpcUrl: string): StandardCheckClient {
  return createPublicClient({ transport: rpcTransport([rpcUrl], { rps: 10 }) }) as unknown as StandardCheckClient;
}

/**
 * Runs a third-party standard property suite against a contract already deployed, on a fork pinned at one
 * block (docs/adr/0003). Nothing is signed or sent: forge executes against a local fork of `rpcUrl`.
 * Steps: chain id and block, implementation identity, pre-checks (asset() is the ERC-7535 native sentinel,
 * or share() names a separate ERC-7575 share token: not applicable, forge skipped), cached workspace,
 * forge, parse, validate, write.
 */
export async function runStandardCheck(input: RunStandardCheckInput): Promise<StandardCheckReport> {
  if (input.standard !== 'erc4626') throw new StandardCheckError(`unknown standard "${input.standard}" (expected erc4626)`);
  const startedAt = new Date();
  const t0 = Date.now();
  const runs = input.runs ?? DEFAULT_STANDARD_RUNS;
  const delta = input.delta ?? 0n;
  if (!Number.isInteger(runs) || runs <= 0) throw new StandardCheckError(`runs must be a positive integer, got ${runs}`);
  if (delta < 0n || delta > MAX_UINT256) throw new StandardCheckError(`delta must be a uint256, got ${delta}`);
  if (input.seed !== undefined && (input.seed < 0n || input.seed > MAX_UINT256)) throw new StandardCheckError(`seed must be a uint256, got ${input.seed}`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.address) || badChecksum(input.address)) {
    throw new StandardCheckError(`not an address, or a mixed-case address with a wrong EIP-55 checksum: ${input.address}`);
  }
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
  let run: ForgeSuiteRun | null = null;
  let upstream = input.pins?.upstream ?? ERC4626_UPSTREAM;
  let forgeStd: PinnedRepo = input.pins?.forgeStd ?? { repo: FORGE_STD_PIN.repo, commit: FORGE_STD_PIN.commit };
  let harnessSha256: Hex;
  let sfPropertiesSha256: Hex;
  let foundryTomlSha256: Hex = sha256Hex(ERC4626_FOUNDRY_TOML);
  // Pre-checks. An asset() that reverts is left to forge, whose setUp failure becomes the recorded reason.
  // A share() that reverts, answers nothing or names the vault itself means a plain ERC-4626 vault.
  const asset = await client
    .readContract({ address, abi: assetAbi, functionName: 'asset', blockNumber })
    .catch(() => null);
  const shareToken =
    asset && asset.toLowerCase() === ERC7535_NATIVE_ASSET.toLowerCase()
      ? null
      : await client.readContract({ address, abi: shareAbi, functionName: 'share', blockNumber }).catch(() => null);
  let vaultKind: VaultKind = 'erc4626';
  let skipReason: string | null = null;
  let skipCode: SkipReason | null = null;
  if (asset && asset.toLowerCase() === ERC7535_NATIVE_ASSET.toLowerCase()) {
    vaultKind = 'erc7535';
    skipReason = NATIVE_ASSET_REASON;
    skipCode = 'native-asset';
  } else if (shareToken && !/^0x0{40}$/i.test(shareToken) && shareToken.toLowerCase() !== address.toLowerCase()) {
    vaultKind = 'erc7575';
    skipReason = erc7575Reason(getAddress(shareToken));
    skipCode = 'separate-share-token';
  }
  if (skipReason !== null) {
    input.onEvent?.({ type: 'check-skip', vaultKind, reason: skipReason });
    harnessSha256 = sha256Hex(await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8'));
    sfPropertiesSha256 = sha256Hex(await readFile(erc4626SourceFile('SpecfirstMaxHonored.t.sol'), 'utf8'));
    const reason = skipReason;
    results = ERC4626_CHECK_PROPERTIES.map((p) => ({ id: p.id, test: p.test, description: p.description, status: 'not_applicable', reason }));
  } else {
    const ws = await prepareErc4626Workspace({ cacheDir: input.cacheDir, ...input.pins });
    input.onEvent?.({ type: 'check-workspace', dir: ws.dir, fetched: ws.fetched, harnessSha256: ws.harnessSha256 });
    upstream = ws.upstream;
    forgeStd = ws.forgeStd;
    harnessSha256 = ws.harnessSha256;
    sfPropertiesSha256 = ws.sfPropertiesSha256;
    foundryTomlSha256 = ws.foundryTomlSha256;
    run = await runForgeSuite({
      ws,
      select: ['--match-contract', `^(${ERC4626_CHECK_CONTRACTS.join('|')})$`],
      properties: ERC4626_CHECK_PROPERTIES,
      rpcUrl: input.rpcUrl,
      blockNumber,
      runs,
      seed: input.seed,
      sender: input.sender,
      env: { SF_VAULT: address, SF_DELTA: delta.toString() },
      forgeBin: input.forgeBin,
      timeoutSec: input.timeoutSec,
      onEvent: input.onEvent,
    });
    results = run.results;
  }

  const report = standardCheckReportSchema.parse({
    schemaVersion: STANDARD_CHECK_SCHEMA_VERSION,
    chainId,
    address,
    blockNumber: blockNumber.toString(),
    standard: input.standard,
    vaultKind,
    skipReason: skipCode ?? skipReasonOf(results),
    upstream: { repo: upstream.repo, commit: upstream.commit },
    harnessSha256,
    sfPropertiesSha256,
    runs,
    delta: delta.toString(),
    seed: run?.seed ?? null,
    sender: run?.sender ?? null,
    toolchain: {
      forgeVersion: run?.forgeVersion ?? null,
      forgeStd: { repo: forgeStd.repo, commit: forgeStd.commit },
      foundryTomlSha256,
      maxTestRejects: FUZZ_MAX_TEST_REJECTS,
    },
    identity,
    results,
    summary: summarize(results),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
  } satisfies StandardCheckReport);
  // The raw forge document and the report are written together, only after the report validated. When
  // forge did not run, a raw file left from an earlier run at the same path would describe another run.
  if (input.rawPath) {
    if (run) await writeAtomic(input.rawPath, run.raw);
    else await rm(input.rawPath, { force: true });
  }
  if (input.recordPath) await writeAtomic(input.recordPath, `${JSON.stringify(report, null, 2)}\n`);
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
}

/**
 * Positive control: the same harness against BrokenVault (previewDeposit over-promises by 1%), created
 * inside the fork over `asset`. A sound harness reports previewDeposit as fail.
 */
export async function runErc4626Control(input: RunErc4626ControlInput): Promise<StandardPropertyResult[]> {
  const ws = await prepareErc4626Workspace({ cacheDir: input.cacheDir });
  const run = await runForgeSuite({
    ws,
    select: ['--match-path', ERC4626_CONTROL_PATH],
    properties: ERC4626_PROPERTIES,
    rpcUrl: input.rpcUrl,
    blockNumber: input.blockNumber,
    runs: input.runs ?? DEFAULT_STANDARD_RUNS,
    env: { SF_ASSET: getAddress(input.asset) },
    forgeBin: input.forgeBin,
    timeoutSec: input.timeoutSec,
  });
  return run.results;
}
