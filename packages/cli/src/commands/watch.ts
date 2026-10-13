import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  acquireIssuerLock,
  acquireWatchLock,
  badChecksum,
  DEMO_FACTORY_ADDRESS,
  deployDemoFactory,
  deployDemoToken,
  deployDemoVault,
  depositIntoDemoVault,
  dropPercentText,
  LEGACY_DEMO_FACTORY_ADDRESS,
  setDemoVaultBroken,
  setDemoVaultLoss,
  ANVIL_CHAIN_ID,
  ANVIL_DEFAULT_RPC,
  AttestationRegistryClient,
  batchedLogsReader,
  builtinSources,
  decodeSignal,
  ENVIO_API_TOKEN_ENV,
  hypersyncFirstEmitters,
  hypersyncLogsReader,
  hypersyncUrlOf,
  logsWithFallback,
  outcomeOfReport,
  precheckErc4626,
  runSubjectCheck,
  saveReportCopy,
  watchFuzzSeedOf,
  type HypersyncOptions,
  checkAllowedLocalOrigins,
  createSubscriptionSource,
  createWebhookAlertSink,
  DEFAULT_BLOCK_LAG,
  DEFAULT_LOG_WINDOW,
  DEFAULT_REPORT_BASE_URL,
  DEFAULT_WATCH_CHECK_TIMEOUT_SEC,
  DEFAULT_WATCH_CONFIG,
  DEFAULT_WATCH_POLL_SEC,
  DEFAULT_WATCH_RUNS,
  defaultCacheDir,
  errorText,
  fixtureLogReader,
  LogWindow,
  liveWatchEffects,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  MONAD_TESTNET_DEFAULT_RPC,
  NETWORKS,
  REPORT_BASE_URL_ENV,
  isNodeError,
  rpcTransport,
  seedKnownVaults,
  sourcesFromFile,
  SourcesError,
  SubscriptionsClient,
  verifySourceFixture,
  WATCH_DIR,
  WATCH_FAILED_EXIT_CODE,
  Watcher,
  WatchError,
  WatchStore,
  WEBHOOKS_JSON,
  type FeedEvent,
  type FeedSource,
  type RunStandardCheckInput,
  type SourceFixture,
  type StandardCheckClient,
  type StandardCheckReport,
  type SubjectClient,
  type WatchConfig,
  type WatchEvent,
  type WatchHooks,
  type WatchSource,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createPublicClient, formatEther, getAddress, parseEther, type Address, type PublicClient } from 'viem';
import { contextFrom, emitEvent, printLine, type CliContext } from '../lib/context.js';
import {
  ANVIL_RPC_ENV,
  ConfigError,
  DEPLOYER_KEY_ENV,
  ISSUER_KEY_ENV,
  MONAD_MAINNET_RPC_ENV,
  MONAD_RPC_ENV,
  MONAD_RPC_FALLBACKS_ENV,
  optionalKey,
  resolveAttestRegistry,
  resolveKey,
  resolveNetwork,
  resolveSubs,
  subsEnvVar,
  WATCH_ISSUER_KEY_ENV,
  attestRegistryEnvVar,
  type ResolvedNetwork,
} from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';
import { registerWatchDemoGate } from './gate.js';

/** rpc1 takes 10,000-block getLogs windows (and archive reads); rpc.monad.xyz is the fallback with 100. */
export const MONAD_MAINNET_WATCH_RPCS = ['https://rpc1.monad.xyz', 'https://rpc.monad.xyz'] as const;

/** Injection points for tests: the property suite, the subscription hooks, the sleep between passes. */
export interface WatchCommandDeps {
  runCheck?: (input: RunStandardCheckInput) => Promise<StandardCheckReport>;
  hooks?: WatchHooks;
  config?: Partial<WatchConfig>;
  sleep?: (ms: number) => Promise<void>;
}

interface WatchOptions {
  subjectChain: string;
  subjectRpc: string[];
  sources?: string;
  fromBlock?: string;
  toBlock?: string;
  blockLag: string;
  logWindow: string;
  poll: string;
  once?: boolean;
  runs: string;
  checkTimeout: string;
  sweepHours: string;
  sweepPerHour: string;
  subscribedMinutes: string;
  priceMinutes: string;
  priceDropBps: string;
  priceAll?: boolean;
  priceReadsPerMinute: string;
  maxPriceDropsPerDay: string;
  maxAttestPerDay: string;
  maxUnsolicitedPerDay: string;
  maxAttestPerSubject: string;
  minBalance: string;
  issuerKeyEnv?: string;
  attest: boolean;
  shareIssuerKey?: boolean;
  network: string;
  rpc?: string;
  registryAttest?: string;
  reportBaseUrl?: string;
  allowUnknownProxy?: boolean;
  subs?: string;
  webhookLocalOrigin: string[];
  hypersync?: boolean;
  hypersyncUrl?: string;
}

/** Envio HyperSync for the subject chain: --hypersync-url or https://<chainId>.hypersync.xyz, the token from $ENVIO_API_TOKEN. */
function hypersyncFrom(chainId: number, url: string | undefined, env: NodeJS.ProcessEnv = process.env): HypersyncOptions {
  const token = env[ENVIO_API_TOKEN_ENV]?.trim();
  if (!token) throw new ConfigError(`HyperSync needs an Envio API token in $${ENVIO_API_TOKEN_ENV} (https://envio.dev/app/api-tokens)`);
  return { url: url ?? hypersyncUrlOf(chainId), token };
}

function nonNegative(raw: string, what: string, max = BigInt(Number.MAX_SAFE_INTEGER)): bigint {
  if (!/^(0|[1-9]\d*)$/.test(raw) || BigInt(raw) > max) throw new ConfigError(`${what} must be a non-negative integer up to ${max}, got "${raw}"`);
  return BigInt(raw);
}

function positive(raw: string, what: string, max = BigInt(Number.MAX_SAFE_INTEGER)): bigint {
  const n = nonNegative(raw, what, max);
  if (n === 0n) throw new ConfigError(`${what} must be at least 1, got "${raw}"`);
  return n;
}

function reportBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`the report base URL must be an http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`the report base URL must be an http(s) URL, got "${raw}"`);
  return raw.replace(/\/+$/, '');
}

const collect = (value: string, previous: string[]) => [...previous, value];

/**
 * Read-only RPCs of the subject chain, primary first: --subject-rpc (repeatable), else for Monad mainnet
 * $MONAD_MAINNET_RPC or rpc1 then rpc.monad.xyz, for Monad testnet $MONAD_TESTNET_RPC and its fallbacks,
 * for anvil $ANVIL_RPC. forge forks from the first.
 */
export function watchSubjectRpcs(chainId: number, explicit: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  if (explicit.length) return [...new Set(explicit)];
  if (chainId === MONAD_MAINNET_CHAIN_ID) return env[MONAD_MAINNET_RPC_ENV] ? [env[MONAD_MAINNET_RPC_ENV]!] : [...MONAD_MAINNET_WATCH_RPCS];
  if (chainId === MONAD_TESTNET_CHAIN_ID) {
    const fallbacks = (env[MONAD_RPC_FALLBACKS_ENV] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return [...new Set([env[MONAD_RPC_ENV] ?? MONAD_TESTNET_DEFAULT_RPC, ...fallbacks])];
  }
  if (chainId === ANVIL_CHAIN_ID) return [env[ANVIL_RPC_ENV] ?? ANVIL_DEFAULT_RPC];
  throw new ConfigError(`no default RPC for subject chain ${chainId}; pass --subject-rpc <url>`);
}

interface AlertHooks {
  hooks: WatchHooks;
  subs: Address;
  webhooksFile: string;
}

/**
 * The subscription hooks (ADR 0006, Alerts) from the configuration: with a CheckSubscriptions address (--subs, else
 * $SPECFIRST_SUBS_<chainId> of --network, the attest network), the active subscriptions are read there (read only)
 * and changes are POSTed to the webhooks the web stores in <watch dir>/webhooks.json. Without one, null: no
 * subscriptions and no alerts. --webhook-local-origin lists the exact origins a local webhook may use.
 */
async function alertHooksFrom(net: ResolvedNetwork, opts: WatchOptions, projectDir: string, reportBaseUrl: string): Promise<AlertHooks | null> {
  const envName = subsEnvVar(net.clients.chain.id);
  if (!opts.subs && !process.env[envName]) {
    if (opts.webhookLocalOrigin.length) throw new ConfigError(`--webhook-local-origin needs a CheckSubscriptions contract: set ${envName} or pass --subs <address>`);
    return null;
  }
  try {
    checkAllowedLocalOrigins(opts.webhookLocalOrigin);
  } catch (err) {
    throw new ConfigError(`--webhook-local-origin: ${(err as Error).message}`);
  }
  const subs = getAddress(resolveSubs(net, opts));
  const code = await net.clients.publicClient.getCode({ address: subs });
  if (!code || code === '0x') throw new ConfigError(`no contract at the subscriptions address ${subs} on ${net.name}`);
  const webhooksFile = path.join(projectDir, WATCH_DIR, WEBHOOKS_JSON);
  return {
    subs,
    webhooksFile,
    hooks: {
      subscriptions: createSubscriptionSource(new SubscriptionsClient(subs, net.clients.publicClient)),
      alerts: createWebhookAlertSink({ webhooksFile, reportBaseUrl, allowedLocalOrigins: opts.webhookLocalOrigin }),
    },
  };
}

async function loadSources(file: string | undefined, chainId: number, projectDir: string): Promise<{ sources: WatchSource[]; fixtures: SourceFixture[]; from: string }> {
  if (!file) return { ...builtinSources(chainId), from: chainId === MONAD_MAINNET_CHAIN_ID ? 'built-in Monad mainnet list' : 'built-in generic list' };
  const abs = path.resolve(projectDir, file);
  let json: unknown;
  try {
    json = JSON.parse(await readFile(abs, 'utf8'));
  } catch (err) {
    throw new ConfigError(`--sources ${file} is not readable JSON: ${(err as Error).message}`);
  }
  try {
    return { ...sourcesFromFile(json, chainId), from: file };
  } catch (err) {
    if (err instanceof SourcesError) throw new ConfigError(`--sources ${file}: ${err.message}`);
    throw err;
  }
}

/**
 * The fixtures of a --sources file that carry no log are read from the subject chain before the watcher starts:
 * a factory source that does not decode its own fixture would watch for nothing, so the start is refused.
 */
async function verifyFixturesOnChain(
  file: string | undefined,
  chainId: number,
  projectDir: string,
  client: Pick<PublicClient, 'request'>,
  sleep?: (ms: number) => Promise<void>,
): Promise<void> {
  if (!file) return;
  const { sources, fixtures } = await loadSources(file, chainId, projectDir);
  const read = fixtureLogReader(client);
  const wait = sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const f of fixtures.filter((x) => !x.log)) {
    let out: { ok: boolean; decoded: string[] } = { ok: false, decoded: [] };
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        out = await verifySourceFixture(f, sources, read);
        break;
      } catch (err) {
        out = { ok: false, decoded: [`error: ${errorText(err)}`] };
        if (attempt < 3) await wait(2_000);
      }
    }
    if (!out.ok) throw new ConfigError(`--sources ${file}: "${f.source}" does not decode its fixture at block ${f.block} (${f.vault}); decoded [${out.decoded.join(' ')}]`);
  }
}

/** A read-only client over `urls` that also fails over on node errors, and refuses an RPC of another chain. */
async function subjectClientFor(urls: string[], chainId: number): Promise<StandardCheckClient & SubjectClient & Pick<PublicClient, 'request' | 'multicall'>> {
  const chain = Object.values(NETWORKS).find((c) => c.id === chainId);
  const client = createPublicClient({ ...(chain ? { chain } : {}), transport: rpcTransport(urls, { failoverIf: isNodeError }) });
  let reported: number;
  try {
    reported = await client.getChainId();
  } catch (err) {
    throw new ConfigError(`the subject RPC ${urls.join(', ')} did not answer eth_chainId: ${errorText(err)}`);
  }
  if (reported !== chainId) throw new ConfigError(`the subject RPC ${urls[0]} serves chain ${reported}, not --subject-chain ${chainId}`);
  return client as unknown as StandardCheckClient & SubjectClient & Pick<PublicClient, 'request' | 'multicall'>;
}

/** The host of an RPC URL, for logs: the path and query of a provider URL often carry an API key. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(not a URL)';
  }
}

function short(a: string): string {
  return `${a.slice(0, 8)}..${a.slice(-4)}`;
}

function feedLine(e: FeedEvent): string {
  const who = `${short(e.subject)}`;
  const src = e.source ? pc.dim(e.source) : '';
  switch (e.kind) {
    case 'detected':
      return cont(`${pc.cyan('detected')}  ${who}  ${src}${e.factory ? ` ${e.factory.name}` : ''}  ${pc.dim(`block ${e.block}`)}`);
    case 'probe-rejected':
      return cont(`${pc.dim('not a vault')}  ${who}  ${pc.dim(e.reason ?? '')}`);
    case 'queued':
      return cont(`${pc.dim('queued')}  ${who}  ${src}${e.reason ? pc.dim(`  ${e.reason}`) : ''}`);
    case 'checked': {
      const c = e.check!;
      const s = c.summary;
      const result = s.fail ? pc.red(`${s.fail} fail`) : pc.green(`${s.pass} pass`);
      const rest = [s.fail ? `${s.pass} pass` : '', s.inconclusive ? `${s.inconclusive} inconclusive` : '', s.notApplicable ? `${s.notApplicable} n/a` : ''].filter(Boolean).join(', ');
      return cont(`${pc.bold('checked')}  ${who}  ${src}  block ${c.block}  ${result}${rest ? `, ${rest}` : ''}${c.failed.length ? pc.red(`  [${c.failed.join(' ')}]`) : ''}  ${pc.dim(e.reason ?? '')}`);
    }
    case 'attested':
      return cont(`${pc.green('attested')}  ${who}  attestation ${e.attestation!.id}${e.attestation!.supersedes ? ` supersedes ${e.attestation!.supersedes}` : ''}  ${pc.dim(`tx ${e.attestation!.txHash}`)}`);
    case 'changed': {
      const c = e.change!;
      if (c.kind === 'price-drop') {
        return cont(`${pc.yellow('changed')}  ${who}  price-drop  ${pc.red(`share value fell ${dropPercentText(c.dropBps)}`)}  ${pc.dim(`block ${c.fromBlock} to ${c.toBlock}, ${c.fromAssetsPerShare} to ${c.toAssetsPerShare} per share`)}`);
      }
      return cont(`${pc.yellow('changed')}  ${who}  ${c.kind}  ${pc.dim(c.from ? `failed [${c.from.failed.join(' ')}] to [${c.to.failed.join(' ')}]` : `failed [${c.to.failed.join(' ')}]`)}`);
    }
    case 'alerted':
      return cont(`${pc.magenta('alerted')}  ${who}  subscription ${e.alert?.subscriptionId ?? '?'}  ${e.alert?.channel ?? ''} ${e.alert?.ok ? 'ok' : pc.red('failed')}`);
    case 'error':
      return cont(pc.red(`error  ${who}  ${e.reason ?? ''}`));
  }
}

function logWatchEvent(ctx: CliContext, e: WatchEvent): void {
  switch (e.type) {
    case 'watch-window':
      if (e.signals > 0) printLine(ctx, stage('logs', `blocks ${e.fromBlock}..${e.toBlock}  ${e.logs} log${e.logs === 1 ? '' : 's'}  ${e.signals} signal${e.signals === 1 ? '' : 's'}`));
      return;
    case 'watch-window-shrunk':
      printLine(ctx, cont(pc.yellow(`getLogs window shrunk to ${e.size} blocks at ${e.fromBlock}: ${e.error}`)));
      return;
    case 'watch-feed':
      printLine(ctx, feedLine(e.event));
      return;
    case 'watch-error':
      printLine(ctx, cont(pc.red(`${e.step} failed: ${e.error}`)));
      return;
    case 'watch-attest-replaced':
      printLine(ctx, cont(pc.yellow(`attest tx ${e.replaces} still pending, sent again with a higher fee (${e.bump}): ${e.hash}`)));
      return;
    case 'watch-price':
      if (e.step === 'pending') printLine(ctx, cont(`${pc.yellow('share value')}  ${short(e.subject)}  fell ${dropPercentText(e.dropBps ?? 0)} at block ${e.block}  ${pc.dim('waiting for a read at a later block')}`));
      else if (e.step === 'cleared') printLine(ctx, cont(pc.dim(`share value  ${short(e.subject)}  ${e.reason ?? 'the fall was not there at a later block'}`)));
      return;
    case 'watch-pass-done':
      if (e.checked > 0) printLine(ctx, cont(pc.dim(`head ${e.head}  cursor ${e.cursor}  queue ${e.queue}`)));
      return;
    case 'watch-pass':
      return;
  }
}

/**
 * `specfirst watch` (docs/adr/0006): the unattended loop from chain events to checks and attestations, and
 * `specfirst watch sources` to list (and with --verify, check against the chain) the signal sources. Reads
 * the subject chain only; attests on --network (monad-testnet or anvil, monad-mainnet refused) with
 * WATCH_ISSUER_PRIVATE_KEY, falling back to ISSUER_PRIVATE_KEY only with --share-issuer-key. With a
 * CheckSubscriptions address on that network it reads the active subscriptions and POSTs changes to the
 * webhooks in .specfirst/watch/webhooks.json. Files under .specfirst/watch/<subjectChainId>/ of --project.
 * NDJSON events with --json. Exit 19 when it cannot start.
 */
export function registerWatchCommand(program: Command, deps: WatchCommandDeps = {}): void {
  const watch = program
    .command('watch')
    .description('Watch a chain for ERC-4626 vaults: detect them from events, check them, attest results that changed (ADR 0006). Runs until stopped.')
    .option('--subject-chain <id>', 'chain to watch (read only)', String(MONAD_MAINNET_CHAIN_ID))
    .option('--subject-rpc <url>', 'read-only RPC of the subject chain; repeat for fallbacks, forge forks from the first (default: $MONAD_MAINNET_RPC or rpc1.monad.xyz then rpc.monad.xyz on 143)', collect, [])
    .option('--sources <file>', 'JSON list of signal sources for the subject chain, replacing the built-in list (see examples/watch/sources-demo.json)')
    .option('--from-block <n>', 'read logs from this block (backfill); default: where the last run stopped, or the current head')
    .option('--to-block <n>', 'stop reading logs after this block and exit once the queue is empty')
    .option('--block-lag <n>', 'read logs and check this many blocks below the head', DEFAULT_BLOCK_LAG.toString())
    .option('--log-window <n>', 'largest eth_getLogs window in blocks; shrinks on range errors', DEFAULT_LOG_WINDOW.toString())
    .option('--poll <sec>', 'seconds to wait when caught up and nothing is due', String(DEFAULT_WATCH_POLL_SEC))
    .option('--once', 'read up to the head (or --to-block), run every due check, and exit')
    .option('--runs <n>', 'fuzz runs per property', String(DEFAULT_WATCH_RUNS))
    .option('--check-timeout <sec>', 'wall-clock budget of one check; a check that runs out is recorded, not attested and not retried', String(DEFAULT_WATCH_CHECK_TIMEOUT_SEC))
    .option('--sweep-hours <h>', 're-check every known vault at most once per this many hours', String(DEFAULT_WATCH_CONFIG.sweepHours))
    .option('--sweep-per-hour <n>', 'start at most this many sweep checks per hour (0: no sweep)', String(DEFAULT_WATCH_CONFIG.sweepPerHour))
    .option('--subscribed-minutes <m>', 're-check subscribed subjects this often', String(DEFAULT_WATCH_CONFIG.subscribedMinutes))
    .option(
      '--price-minutes <m>',
      'read the share value (convertToAssets of one share) of attested subjects this often; subscribed subjects at every pass (0: no share value reads)',
      String(DEFAULT_WATCH_CONFIG.priceMinutes),
    )
    .option('--price-drop-bps <n>', 'a fall of the share value of more than this many basis points, seen again at a later block, is a price-drop event', String(DEFAULT_WATCH_CONFIG.priceDropBps))
    .option('--price-all', 'also follow the share value of known vaults nobody subscribed to and nobody attested')
    .option(
      '--price-reads-per-minute <n>',
      'share value reads per minute, all subjects together (one eth_call each with Multicall3, else three); a quarter is kept for attested vaults',
      String(DEFAULT_WATCH_CONFIG.maxPriceReadsPerMinute),
    )
    .option('--max-price-drops-per-day <n>', 'price-drop events (and alerts) of one vault per UTC day; more are logged only', String(DEFAULT_WATCH_CONFIG.maxPriceDropsPerDay))
    .option('--max-attest-per-day <n>', 'attestations per UTC day, every class; more wait for the next day', String(DEFAULT_WATCH_CONFIG.maxAttestPerDay))
    .option('--max-unsolicited-per-day <n>', 'of those, attestations nobody subscribed to (factory, fail, attested-change)', String(DEFAULT_WATCH_CONFIG.maxUnsolicitedPerDay))
    .option('--max-attest-per-subject <n>', 'attestations of one subject per UTC day', String(DEFAULT_WATCH_CONFIG.maxAttestPerSubjectPerDay))
    .option('--min-balance <MON>', 'below this issuer balance nothing is sent (status.json says why)', formatEther(DEFAULT_WATCH_CONFIG.minBalanceWei))
    .option('--issuer-key-env <NAME>', `environment variable holding the issuer key (default ${WATCH_ISSUER_KEY_ENV}); a second watcher, the testnet demo, signs with its own`)
    .option('--no-attest', 'decide and record, send nothing (no key needed)')
    .option('--share-issuer-key', `sign with ${ISSUER_KEY_ENV} when ${WATCH_ISSUER_KEY_ENV} is unset (the desk worker's key: do not run both at once)`)
    .option('--network <name>', 'network of the attestation registry: monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL of that network (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--registry-attest <address>', 'CheckAttestationRegistry (default: $SPECFIRST_ATTEST_REGISTRY_<chainId>)')
    .option('--report-base-url <url>', `public URL of certs/checks for reportURI (default: $${REPORT_BASE_URL_ENV} or ${DEFAULT_REPORT_BASE_URL})`)
    .option('--allow-unknown-proxy', 'attest proxy-shaped subjects whose implementation cannot be resolved')
    .option('--subs <address>', 'CheckSubscriptions on --network to read active subscriptions from and alert (default: $SPECFIRST_SUBS_<chainId>; neither: no subscriptions, no alerts)')
    .option('--webhook-local-origin <origin>', 'exact http(s) origin a webhook may use although it is local, e.g. http://localhost:3417 for the web demo receiver; repeat for more', collect, [])
    .option('--hypersync', `read logs from Envio HyperSync (token in $${ENVIO_API_TOKEN_ENV}), from the subject RPC whenever HyperSync fails (ADR 0009)`)
    .option('--hypersync-url <url>', 'HyperSync of the subject chain (default https://<subject chain id>.hypersync.xyz)')
    .action(async (opts: WatchOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch', WATCH_FAILED_EXIT_CODE, async () => {
        const subjectChainId = Number(positive(opts.subjectChain, '--subject-chain', 2n ** 53n - 1n));
        const fromBlock = opts.fromBlock !== undefined ? nonNegative(opts.fromBlock, '--from-block') : null;
        const toBlock = opts.toBlock !== undefined ? nonNegative(opts.toBlock, '--to-block') : null;
        if (fromBlock !== null && toBlock !== null && toBlock < fromBlock) throw new ConfigError(`--to-block ${toBlock} is below --from-block ${fromBlock}`);
        const blockLag = nonNegative(opts.blockLag, '--block-lag', 10_000n);
        const logWindow = positive(opts.logWindow, '--log-window', 1_000_000n);
        const poll = positive(opts.poll, '--poll', 86_400n);
        const runs = Number(positive(opts.runs, '--runs', 100_000n));
        const checkTimeoutSec = Number(positive(opts.checkTimeout, '--check-timeout', 86_400n));
        const sweepHours = Number(positive(opts.sweepHours, '--sweep-hours', 10_000n));
        const sweepPerHour = Number(nonNegative(opts.sweepPerHour, '--sweep-per-hour', 10_000n));
        const subscribedMinutes = Number(positive(opts.subscribedMinutes, '--subscribed-minutes', 1_000_000n));
        const priceMinutes = Number(nonNegative(opts.priceMinutes, '--price-minutes', 1_000_000n));
        const priceDropBps = Number(positive(opts.priceDropBps, '--price-drop-bps', 9_999n));
        const maxPriceReadsPerMinute = Number(positive(opts.priceReadsPerMinute, '--price-reads-per-minute', 100_000n));
        const maxPriceDropsPerDay = Number(nonNegative(opts.maxPriceDropsPerDay, '--max-price-drops-per-day', 1_000n));
        const maxAttestPerDay = Number(nonNegative(opts.maxAttestPerDay, '--max-attest-per-day', 1_000_000n));
        const maxUnsolicitedPerDay = Number(nonNegative(opts.maxUnsolicitedPerDay, '--max-unsolicited-per-day', 1_000_000n));
        const maxAttestPerSubjectPerDay = Number(nonNegative(opts.maxAttestPerSubject, '--max-attest-per-subject', 1_000n));
        if (!/^\d+(\.\d{1,18})?$/.test(opts.minBalance)) throw new ConfigError(`--min-balance must be a decimal amount of MON, got "${opts.minBalance}"`);
        const minBalanceWei = parseEther(opts.minBalance);
        const keyEnv = opts.issuerKeyEnv ?? WATCH_ISSUER_KEY_ENV;
        if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new ConfigError(`--issuer-key-env must name an environment variable (A-Z, 0-9, _), got "${keyEnv}"`);
        const base = reportBase(opts.reportBaseUrl ?? process.env[REPORT_BASE_URL_ENV] ?? DEFAULT_REPORT_BASE_URL);
        const { sources, from: sourcesFrom } = await loadSources(opts.sources, subjectChainId, ctx.projectDir);
        const hypersync = opts.hypersync || opts.hypersyncUrl ? hypersyncFrom(subjectChainId, opts.hypersyncUrl) : null;

        // The attestation side first: a refused network or a missing key stops before any subject RPC call.
        let registry: AttestationRegistryClient | null = null;
        let issuer: string | null = null;
        let attestOn = '';
        let net: ResolvedNetwork;
        if (opts.attest) {
          net = resolveNetwork(opts);
          let key = optionalKey(keyEnv);
          if (!key && opts.shareIssuerKey) key = optionalKey(ISSUER_KEY_ENV);
          if (!key) {
            try {
              key = resolveKey(net, keyEnv);
            } catch (err) {
              if (err instanceof ConfigError) throw new ConfigError(`${err.message}; --share-issuer-key signs with ${ISSUER_KEY_ENV} instead, or --no-attest sends nothing`);
              throw err;
            }
          }
          const address = resolveAttestRegistry(net, opts);
          for (const n of net.notices) printLine(ctx, `         ! ${n}`);
          const wallet = net.clients.wallet(key);
          const code = await net.clients.publicClient.getCode({ address });
          if (!code || code === '0x') throw new ConfigError(`no contract at the registry address ${address} on ${net.name}`);
          registry = new AttestationRegistryClient(getAddress(address), net.clients.publicClient, wallet);
          issuer = wallet.account.address;
          if (!(await registry.isIssuer(wallet.account.address))) {
            throw new ConfigError(`${wallet.account.address} is not an issuer of ${address}: \`specfirst attest-registry set-issuer ${wallet.account.address} --registry-attest ${address}\``);
          }
          attestOn = `${net.name} ${net.clients.chain.id}`;
        } else {
          // Without attesting, a registry that is configured is still read: it decides what would be attested.
          net = resolveNetwork(opts, process.env, { readOnly: true });
          if (opts.registryAttest ?? process.env[attestRegistryEnvVar(net.clients.chain.id)]) {
            registry = new AttestationRegistryClient(getAddress(resolveAttestRegistry(net, opts)), net.clients.publicClient);
            attestOn = `${net.name} ${net.clients.chain.id}, read only`;
          }
        }

        // Injected hooks (tests) replace the configured ones.
        const alerting = deps.hooks ? null : await alertHooksFrom(net, opts, ctx.projectDir, base);
        const hooks = deps.hooks ?? alerting?.hooks;

        const urls = watchSubjectRpcs(subjectChainId, opts.subjectRpc);
        const subjectClient = await subjectClientFor(urls, subjectChainId);
        await verifyFixturesOnChain(opts.sources, subjectChainId, ctx.projectDir, subjectClient, deps.sleep);
        // Locks first: the key (two watchers on one key collide on nonces wherever they run), then the directory;
        // only the holder repairs the directory (a cut feed line, temp files) as it loads it.
        const releases: Array<() => Promise<void>> = [];
        let store: WatchStore;
        try {
          if (issuer) releases.push(await acquireIssuerLock(issuer));
          releases.push(await acquireWatchLock(ctx.projectDir, subjectChainId));
          store = await WatchStore.load(ctx.projectDir, subjectChainId, { repair: true });
        } catch (err) {
          for (const r of releases.reverse()) await r();
          if (err instanceof WatchError) throw new ConfigError(err.message);
          throw err;
        }
        const release = async () => {
          for (const r of releases.reverse()) await r();
        };
        try {
          const seeded = await seedKnownVaults(ctx.projectDir, store);
          for (const s of seeded.skipped) console.error(pc.yellow(`specfirst watch: warning: skipped ${s}`));
          if (fromBlock !== null) store.state.cursor = fromBlock.toString();
          // HyperSync first (10 s a request), the subject RPC when it fails; each message at most every 10 minutes, so a flapping HyperSync cannot flood the log.
          const QUIET_MS = 10 * 60_000;
          let warnedAt = -QUIET_MS;
          let recoveredAt = -QUIET_MS;
          const getLogs = hypersync
            ? logsWithFallback(hypersyncLogsReader({ ...hypersync, timeoutMs: 10_000 }), batchedLogsReader(urls), {
                onFallback: (err, f, t, cooldownMs) => {
                  if (Date.now() - warnedAt < QUIET_MS) return;
                  warnedAt = Date.now();
                  console.error(pc.yellow(`specfirst watch: warning: HyperSync did not serve blocks ${f} to ${t} (${errorText(err)}); logs from the subject RPC for ${Math.round(cooldownMs / 1000)}s`));
                  emitEvent(ctx, { type: 'watch-logs', via: 'rpc', fromBlock: f.toString(), toBlock: t.toString(), cooldownSec: Math.round(cooldownMs / 1000), error: errorText(err) });
                },
                onRecover: () => {
                  if (Date.now() - recoveredAt < QUIET_MS) return;
                  recoveredAt = Date.now();
                  console.error(pc.dim('specfirst watch: HyperSync serves the logs again'));
                  emitEvent(ctx, { type: 'watch-logs', via: 'hypersync' });
                },
              })
            : null;
          const effects = liveWatchEffects({
            subjectClient,
            subjectChainId,
            subjectRpcUrl: urls[0]!,
            subjectRpcUrls: urls,
            ...(getLogs ? { getLogs } : {}),
            projectDir: ctx.projectDir,
            runs,
            timeoutSec: checkTimeoutSec,
            cacheDir: defaultCacheDir(),
            reportBaseUrl: base,
            registry,
            attest: opts.attest,
            ...(issuer && net.clients
              ? {
                  balance: () => net.clients.publicClient.getBalance({ address: issuer as Address }),
                  issuerNonce: () => net.clients.publicClient.getTransactionCount({ address: issuer as Address, blockTag: 'latest' }),
                }
              : {}),
            ...(deps.runCheck ? { runCheck: deps.runCheck } : {}),
            onCheckEvent: (e) => emitEvent(ctx, e),
          });
          const config: Partial<WatchConfig> = {
            lagBlocks: blockLag,
            sweepHours,
            sweepPerHour,
            subscribedMinutes,
            priceMinutes,
            priceDropBps,
            priceAll: Boolean(opts.priceAll),
            maxPriceReadsPerMinute,
            maxPriceDropsPerDay,
            maxAttestPerDay,
            maxUnsolicitedPerDay,
            maxAttestPerSubjectPerDay,
            minBalanceWei,
            allowUnknownProxy: Boolean(opts.allowUnknownProxy),
            toBlock,
            ...deps.config,
          };
          const watcher = new Watcher({
            effects,
            store,
            sources,
            config,
            window: new LogWindow(logWindow),
            adopt: seeded.adopt,
            ...(hooks ? { hooks } : {}),
            onEvent: (e) => {
              emitEvent(ctx, e);
              logWatchEvent(ctx, e);
            },
          });
          const rel = (p: string) => path.relative(ctx.projectDir, p);
          const known = Object.keys(store.vaults.vaults).length;
          printLine(ctx, stage('watch', `chain ${subjectChainId}  ${sources.length} sources (${sourcesFrom})  ${known} known vault${known === 1 ? '' : 's'}  ${pc.dim(rel(store.dir))}`));
          printLine(
            ctx,
            cont(
              pc.dim(
                `subject RPC ${rpcHost(urls[0]!)}${urls.length > 1 ? ` (+${urls.length - 1} fallback)` : ''}  lag ${blockLag}  window ${logWindow}  runs ${runs}  check timeout ${checkTimeoutSec}s  ${opts.once ? 'one pass' : `poll ${poll}s`}`,
              ),
            ),
          );
          printLine(ctx, cont(pc.dim(hypersync ? `logs from Envio HyperSync ${rpcHost(hypersync.url)}, the subject RPC when it fails` : 'logs from the subject RPC')));
          printLine(
            ctx,
            cont(
              pc.dim(
                registry
                  ? `registry ${registry.address} on ${attestOn}${issuer ? `  issuer ${issuer} (${keyEnv})` : ''}  ${
                      opts.attest
                        ? `${maxAttestPerDay} attestations a day, ${maxUnsolicitedPerDay} unsolicited, ${maxAttestPerSubjectPerDay} per subject, none below ${formatEther(minBalanceWei)} MON`
                        : 'no attest'
                    }`
                  : 'no attest, no registry: decisions assume no attestation',
              ),
            ),
          );
          if (seeded.adopt.length) printLine(ctx, cont(pc.dim(`${seeded.adopt.length} report${seeded.adopt.length === 1 ? '' : 's'} in certs/checks newer than the last check, taken through the change decision`)));
          printLine(
            ctx,
            cont(
              pc.dim(
                priceMinutes > 0
                  ? `share value: subscribed every ${DEFAULT_WATCH_CONFIG.priceUrgentSec}s, ${opts.priceAll ? 'attested and every other known vault' : 'attested'} every ${priceMinutes} min, a drop over ${priceDropBps} bps confirmed at a later block, ${maxPriceReadsPerMinute} reads a minute, ${maxPriceDropsPerDay} drops a vault a day`
                  : 'share value not read (--price-minutes 0)',
              ),
            ),
          );
          printLine(
            ctx,
            cont(
              pc.dim(
                alerting
                  ? `subscriptions ${alerting.subs} on ${net.name}  webhooks ${rel(alerting.webhooksFile)}${opts.webhookLocalOrigin.length ? `  local origins ${opts.webhookLocalOrigin.join(', ')}` : ''}`
                  : deps.hooks
                    ? 'subscriptions and alerts from the caller'
                    : `no subscriptions contract (${subsEnvVar(net.clients.chain.id)} unset): no alerts`,
              ),
            ),
          );
          emitEvent(ctx, {
            type: 'watch-start',
            subjectChainId,
            subjectRpcs: urls.length,
            logs: hypersync ? { via: 'hypersync', host: rpcHost(hypersync.url) } : { via: 'rpc' },
            sources: sources.map((s) => s.name),
            sourcesFrom,
            known,
            seeded: { added: seeded.added, adopted: seeded.adopt.length, skipped: seeded.skipped.length },
            cursor: store.state.cursor,
            toBlock: toBlock?.toString() ?? null,
            lagBlocks: blockLag.toString(),
            logWindow: logWindow.toString(),
            runs,
            checkTimeoutSec,
            once: Boolean(opts.once),
            attest: opts.attest,
            registry: registry?.address ?? null,
            issuer,
            issuerKeyEnv: issuer ? keyEnv : null,
            maxAttestPerDay,
            maxUnsolicitedPerDay,
            maxAttestPerSubjectPerDay,
            minBalanceWei: minBalanceWei.toString(),
            priceMinutes,
            priceDropBps,
            priceAll: Boolean(opts.priceAll),
            maxPriceReadsPerMinute,
            maxPriceDropsPerDay,
            reportBaseUrl: base,
            subs: alerting?.subs ?? null,
            webhooks: alerting ? rel(alerting.webhooksFile) : null,
            webhookLocalOrigins: opts.webhookLocalOrigin,
            dir: rel(store.dir),
          });

          const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
          for (;;) {
            // pass() records its own failures; nothing it meets may end an unattended watcher.
            const r = await watcher.pass({ drain: Boolean(opts.once) });
            if (opts.once) {
              // A one-shot run that could not read the chain must not look like a quiet one.
              if (r.failed.includes('head') || r.failed.includes('logs')) {
                throw new StageError(WATCH_FAILED_EXIT_CODE, `the pass could not read the subject chain (${r.failed.join(', ')}); the cursor stays at ${r.cursor ?? 'its start'}`);
              }
              break;
            }
            if (r.done) break;
            if (r.idle) await sleep(Number(poll) * 1000);
          }
          const s = watcher.status();
          printLine(ctx, cont(pc.dim(`cursor ${s.cursor}  known ${s.counts.known}  queue ${s.queue.length}  attested today ${s.attestBudget.usedToday}`)));
          emitEvent(ctx, { type: 'watch-stop', cursor: s.cursor, head: s.head, known: s.counts.known, queue: s.queue.length, attestedToday: s.attestBudget.usedToday });
        } finally {
          await release();
        }
      });
    });

  watch
    .command('sources')
    .description('List the signal sources of --subject-chain (built in, or --sources <file>); --verify checks every fixture against the chain. Read only.')
    .option('--verify', 'read each fixture block from the subject RPC and decode the vault the factory announced there')
    .action(async (opts: { verify?: boolean }, command: Command) => {
      const ctx = contextFrom(command);
      const all = command.optsWithGlobals() as WatchOptions & { verify?: boolean };
      await runStage(ctx, 'watch sources', WATCH_FAILED_EXIT_CODE, async () => {
        const subjectChainId = Number(positive(all.subjectChain, '--subject-chain', 2n ** 53n - 1n));
        const { sources, fixtures, from } = await loadSources(all.sources, subjectChainId, ctx.projectDir);
        printLine(ctx, stage('sources', `chain ${subjectChainId}  ${sources.length} sources  ${pc.dim(from)}`));
        for (const s of sources) {
          const who = s.address ?? `any emitter${s.candidates ? '' : ', known vaults only'}`;
          printLine(ctx, cont(`${pc.bold(s.name)}  ${s.signal}  ${who}${s.vault ? `  vault = ${s.vault}` : ''}`));
          printLine(ctx, cont(pc.dim(`  ${s.topic0}  ${s.event.name}(${s.event.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name ?? ''}`.trim()).join(', ')})`)));
        }
        const results: Array<{ source: string; block: string; vault: string; ok: boolean; decoded: string[] }> = [];
        if (opts.verify) {
          if (fixtures.length === 0) throw new ConfigError(`no fixtures to verify for chain ${subjectChainId}`);
          const urls = watchSubjectRpcs(subjectChainId, all.subjectRpc ?? []);
          const client = await subjectClientFor(urls, subjectChainId);
          const read = fixtureLogReader(client);
          const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
          for (const f of fixtures) {
            let out: { ok: boolean; decoded: string[] } = { ok: false, decoded: [] };
            // Public RPCs answer an occasional "internal error" to an archive getLogs; a node error is not a verdict.
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                out = await verifySourceFixture(f, sources, read);
                break;
              } catch (err) {
                out = { ok: false, decoded: [`error: ${errorText(err)}`] };
                if (attempt < 3) await sleep(2_000);
              }
            }
            results.push({ source: f.source, block: f.block.toString(), vault: f.vault, ...out });
            printLine(ctx, cont(`${out.ok ? pc.green('ok') : pc.red('FAIL')}  ${f.source}  block ${f.block}  ${f.vault}${out.ok ? '' : pc.red(`  decoded [${out.decoded.join(' ')}]`)}`));
          }
        }
        emitEvent(ctx, {
          type: 'watch-sources',
          subjectChainId,
          from,
          sources: sources.map((s) => ({ name: s.name, signal: s.signal, address: s.address, topic0: s.topic0, event: s.event.name, vault: s.vault, candidates: s.candidates })),
          fixtures: fixtures.map((f) => ({ source: f.source, block: f.block.toString(), vault: f.vault })),
          ...(opts.verify ? { verified: results } : {}),
        });
        const failed = results.filter((r) => !r.ok);
        if (failed.length) throw new StageError(WATCH_FAILED_EXIT_CODE, `${failed.length} of ${results.length} fixtures did not decode to their vault`);
      });
    });

  watch
    .command('discover')
    .description(
      'Find vaults the watcher has never seen in the history of --subject-chain, read from Envio HyperSync (ADR 0009): the first ERC-4626 Deposit of every emitter and the vaults of the factory sources, from --from-block (default 0) to --to-block (default the head less --block-lag), less the vaults in certs/checks and vaults.json, prechecked over the subject RPC. --check checks each one as the watcher does and keeps the report in certs/checks, where the watcher takes it in as a known vault when it next starts. Takes no key and attests nothing.',
    )
    .option('--check', 'check every new vault that passes the precheck, one at a time, the most Deposits first, and keep the reports in certs/checks')
    .option('--max-checks <n>', 'check at most this many')
    .option('--out <file>', 'write the new vaults as JSON')
    .action(async (o: { check?: boolean; maxChecks?: string; out?: string }, command: Command) => {
      const ctx = contextFrom(command);
      const all = command.optsWithGlobals() as WatchOptions;
      await runStage(ctx, 'watch discover', WATCH_FAILED_EXIT_CODE, async () => {
        const subjectChainId = Number(positive(all.subjectChain, '--subject-chain', 2n ** 53n - 1n));
        const hs = hypersyncFrom(subjectChainId, all.hypersyncUrl);
        const blockLag = nonNegative(all.blockLag, '--block-lag', 10_000n);
        const runs = Number(positive(all.runs, '--runs', 100_000n));
        const checkTimeoutSec = Number(positive(all.checkTimeout, '--check-timeout', 86_400n));
        const maxChecks = o.maxChecks !== undefined ? Number(nonNegative(o.maxChecks, '--max-checks', 1_000_000n)) : Number.POSITIVE_INFINITY;
        const base = reportBase(all.reportBaseUrl ?? process.env[REPORT_BASE_URL_ENV] ?? DEFAULT_REPORT_BASE_URL);
        const { sources } = await loadSources(all.sources, subjectChainId, ctx.projectDir);
        const deposit = sources.find((s) => s.signal === 'deposit');
        const factories = sources.filter((s) => s.signal === 'factory');
        const urls = watchSubjectRpcs(subjectChainId, all.subjectRpc ?? []);
        const client = await subjectClientFor(urls, subjectChainId);
        // Every precheck and check reads the vault as it is now, at one block below the head.
        const at = (await client.getBlockNumber()) - blockLag;
        const from = all.fromBlock !== undefined ? nonNegative(all.fromBlock, '--from-block') : 0n;
        const to = all.toBlock !== undefined ? nonNegative(all.toBlock, '--to-block') : at;
        if (to < from) throw new ConfigError(`--to-block ${to} is below --from-block ${from}`);
        if (to > at) throw new ConfigError(`--to-block ${to} is above the head less --block-lag, ${at}`);
        printLine(ctx, stage('discover', `chain ${subjectChainId}  blocks ${from} to ${to}  Envio HyperSync ${rpcHost(hs.url)}`));

        const found = new Map<string, { firstBlock: bigint; via: 'deposit' | 'factory'; deposits: number }>();
        let depositLogs = 0;
        if (deposit) {
          let printedAt = 0;
          const r = await hypersyncFirstEmitters(hs, from, to, deposit.topic0, (p) => {
            if (Date.now() - printedAt < 15_000) return;
            printedAt = Date.now();
            printLine(ctx, cont(pc.dim(`block ${p.nextBlock}  ${p.logs} Deposit logs  ${p.emitters} emitters`)));
          });
          if (r.reachedTo < to) throw new StageError(WATCH_FAILED_EXIT_CODE, `HyperSync's archive ends at block ${r.reachedTo}, below --to-block ${to}`);
          depositLogs = r.logs;
          for (const [a, b] of r.first) found.set(a, { firstBlock: b, via: 'deposit', deposits: r.counts.get(a) ?? 0 });
        }
        let factoryLogs = 0;
        if (factories.length) {
          const logs = await hypersyncLogsReader({ ...hs, maxPages: 100_000, rateLimitRetries: 30 })(from, to, [...new Set(factories.map((s) => s.topic0))]);
          factoryLogs = logs.length;
          for (const l of logs) {
            const s = decodeSignal(l, factories);
            if (!s) continue;
            const a = s.subject.toLowerCase();
            const seen = found.get(a);
            if (!seen || s.block < seen.firstBlock) found.set(a, { firstBlock: s.block, via: 'factory', deposits: seen?.deposits ?? 0 });
          }
        }
        const known = await knownVaultsOf(ctx.projectDir, subjectChainId);
        const fresh = [...found]
          .filter(([a]) => !known.has(a))
          .sort((x, y) => (x[1].firstBlock === y[1].firstBlock ? x[0].localeCompare(y[0]) : x[1].firstBlock < y[1].firstBlock ? -1 : 1));
        printLine(
          ctx,
          cont(`${depositLogs} Deposit logs and ${factoryLogs} factory logs: ${found.size} addresses, ${found.size - fresh.length} already known, ${pc.bold(String(fresh.length))} new; prechecking at block ${at}`),
        );

        type Found = {
          address: Address;
          firstBlock: bigint;
          via: 'deposit' | 'factory';
          deposits: number;
          erc4626: boolean;
          /** The precheck could not be read (a node or transport failure, three times): unknown, not "not a vault". */
          precheckError?: string;
          reason?: string;
          report?: string;
          summary?: { pass: number; fail: number; inconclusive: number; notApplicable: number };
          failed?: string[];
          checkError?: string;
        };
        const results: Found[] = fresh.map(([a, f]) => ({ address: getAddress(a), ...f, erc4626: false }));
        const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        let next = 0;
        await Promise.all(
          Array.from({ length: 4 }, async () => {
            for (let i = next++; i < results.length; i = next++) {
              const v = results[i]!;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  const pre = await precheckErc4626(client, v.address, at);
                  v.erc4626 = pre.ok;
                  if (!pre.ok) v.reason = pre.reason;
                  delete v.precheckError;
                  break;
                } catch (err) {
                  v.precheckError = errorText(err);
                  if (attempt < 3) await sleep(2_000);
                }
              }
            }
          }),
        );
        // The busiest first: a vault many deposits went into matters more than a test deployment.
        const vaults = results.filter((v) => v.erc4626).sort((x, y) => y.deposits - x.deposits || (x.firstBlock < y.firstBlock ? -1 : x.firstBlock > y.firstBlock ? 1 : 0));
        const unread = results.filter((v) => v.precheckError !== undefined);
        printLine(ctx, cont(`${pc.bold(String(vaults.length))} of the ${results.length} new addresses answer as ERC-4626 vaults at block ${at}`));
        if (unread.length) console.error(pc.yellow(`specfirst watch discover: warning: ${unread.length} prechecks could not be read from the subject RPC (${unread[0]!.precheckError}); run discover again for them`));
        for (const v of vaults) printLine(ctx, cont(`${v.address}  ${v.deposits} Deposits, the first ${v.via === 'deposit' ? 'Deposit' : 'a factory event'} at block ${v.firstBlock}`));

        if (o.check) {
          const todo = vaults.slice(0, maxChecks);
          for (const [i, v] of todo.entries()) {
            try {
              const report = await runSubjectCheck(
                { subjectClient: client, subjectChainId, subjectRpcUrl: urls[0]!, projectDir: ctx.projectDir, runs, timeoutSec: checkTimeoutSec, cacheDir: defaultCacheDir() },
                v.address,
                at,
                { seed: watchFuzzSeedOf(v.address) },
              );
              const saved = await saveReportCopy(ctx.projectDir, base, report);
              const outcome = outcomeOfReport(report);
              v.report = saved.reportPath;
              v.summary = outcome.summary;
              v.failed = outcome.failed;
              const s = outcome.summary;
              printLine(ctx, cont(`${i + 1}/${todo.length}  ${v.address}  ${s.fail ? pc.red(`fail ${s.fail}`) : pc.green('no failure')}  pass ${s.pass}  inconclusive ${s.inconclusive}  n/a ${s.notApplicable}  ${pc.dim(saved.reportPath)}`));
            } catch (err) {
              v.checkError = errorText(err);
              printLine(ctx, cont(`${i + 1}/${todo.length}  ${v.address}  ${pc.red(`check failed: ${v.checkError}`)}`));
            }
            emitEvent(ctx, { type: 'watch-discover-check', index: i + 1, of: todo.length, address: v.address, report: v.report ?? null, summary: v.summary ?? null, failed: v.failed ?? [], error: v.checkError ?? null });
          }
        }
        const json = results.map((v) => ({ ...v, firstBlock: v.firstBlock.toString() }));
        if (o.out) await writeFile(path.resolve(ctx.projectDir, o.out), `${JSON.stringify({ chainId: subjectChainId, fromBlock: from.toString(), toBlock: to.toString(), atBlock: at.toString(), hypersync: rpcHost(hs.url), vaults: json }, null, 2)}\n`);
        emitEvent(ctx, {
          type: 'watch-discover',
          subjectChainId,
          fromBlock: from.toString(),
          toBlock: to.toString(),
          atBlock: at.toString(),
          hypersync: rpcHost(hs.url),
          depositLogs,
          factoryLogs,
          addresses: found.size,
          known: found.size - fresh.length,
          new: results.length,
          vaults: vaults.length,
          precheckUnread: unread.length,
          checked: vaults.filter((v) => v.report).length,
          ...(o.out ? { out: o.out } : {}),
        });
      });
    });

  registerWatchDemo(watch);
}

/** Lowercase addresses the watcher of `chainId` knows: a report directory in certs/checks or an entry of vaults.json. */
async function knownVaultsOf(projectDir: string, chainId: number): Promise<Set<string>> {
  const known = new Set<string>();
  try {
    for (const d of await readdir(path.join(projectDir, 'certs', 'checks', String(chainId)))) if (/^0x[0-9a-f]{40}$/.test(d)) known.add(d);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    const file = JSON.parse(await readFile(path.join(projectDir, WATCH_DIR, String(chainId), 'vaults.json'), 'utf8')) as { vaults?: Record<string, unknown> };
    for (const a of Object.keys(file.vaults ?? {})) known.add(a.toLowerCase());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return known;
}

function address(raw: string, what: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || badChecksum(raw)) throw new ConfigError(`${what} must be a 0x address with a valid checksum, got "${raw}"`);
  return getAddress(raw);
}

/**
 * `specfirst watch demo deploy|vault|deposit|set-broken|loss`: the contracts of the watcher demo (ADR 0006) on
 * monad-testnet or anvil, signed with DEPLOYER_PRIVATE_KEY through the guarded wallet. They take --network and
 * --rpc of `watch`; monad-mainnet is refused before a key is read.
 */
function registerWatchDemo(watch: Command): void {
  const demo = watch
    .command('demo')
    .description(`Demo contracts on monad-testnet or anvil (--network and --rpc of watch apply), signed with ${DEPLOYER_KEY_ENV}: DemoVaultFactory at ${DEMO_FACTORY_ADDRESS}, DemoToken, vaults.`);
  const signer = (command: Command) => {
    const all = command.optsWithGlobals() as { network: string; rpc?: string };
    const net = resolveNetwork({ network: all.network, ...(all.rpc ? { rpc: all.rpc } : {}) });
    const key = resolveKey(net, DEPLOYER_KEY_ENV);
    return { net, client: net.clients.publicClient, wallet: net.clients.wallet(key) };
  };
  const failed = (err: unknown): never => {
    if (err instanceof ConfigError || err instanceof StageError) throw err;
    throw new StageError(WATCH_FAILED_EXIT_CODE, errorText(err));
  };

  demo
    .command('deploy')
    .description('Deploy DemoVaultFactory at its CREATE2 address (nothing when it is there), and with --token a DemoToken anyone can mint.')
    .option('--token', 'also deploy a DemoToken as the asset of demo vaults')
    .action(async (opts: { token?: boolean }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo deploy', WATCH_FAILED_EXIT_CODE, async () => {
        const { net, client, wallet } = signer(command);
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        try {
          const factory = await deployDemoFactory({ client, wallet });
          printLine(ctx, stage('demo', `DemoVaultFactory ${pc.bold(factory.address)}  ${pc.dim(factory.tx ? `deployed, tx ${factory.tx.hash}` : 'already deployed')}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
          const token = opts.token ? await deployDemoToken({ client, wallet }) : null;
          if (token) printLine(ctx, cont(`DemoToken ${pc.bold(token.address)}  ${pc.dim(`tx ${token.tx.hash}`)}`));
          emitEvent(ctx, {
            type: 'watch-demo-deployed',
            chainId: net.clients.chain.id,
            factory: factory.address,
            factoryTx: factory.tx?.hash ?? null,
            token: token?.address ?? null,
            tokenTx: token?.tx.hash ?? null,
          });
        } catch (err) {
          failed(err);
        }
      });
    });

  demo
    .command('vault')
    .description('Deploy a DemoVault through the factory; the signer becomes its operator. The watcher finds it from VaultDeployed.')
    .requiredOption('--asset <address>', 'ERC-20 the vault holds (a DemoToken from `watch demo deploy --token`)')
    .option('--broken', 'start with the deliberate previewDeposit bug on')
    .action(async (opts: { asset: string; broken?: boolean }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo vault', WATCH_FAILED_EXIT_CODE, async () => {
        const asset = address(opts.asset, '--asset');
        const { net, client, wallet } = signer(command);
        try {
          const out = await deployDemoVault({ client, wallet, asset, broken: Boolean(opts.broken) });
          printLine(ctx, stage('demo', `DemoVault ${pc.bold(out.vault)}  asset ${asset}${opts.broken ? pc.red('  broken') : ''}  ${pc.dim(`block ${out.tx.blockNumber}  tx ${out.tx.hash}`)}`));
          emitEvent(ctx, { type: 'watch-demo-vault', chainId: net.clients.chain.id, vault: out.vault, asset, broken: Boolean(opts.broken), operator: wallet.account.address, txHash: out.tx.hash, blockNumber: out.tx.blockNumber.toString() });
        } catch (err) {
          failed(err);
        }
      });
    });

  demo
    .command('deposit <vault>')
    .description('Mint DemoToken to the signer and deposit it into <vault> (the first deposit re-checks a vault found at its deploy block).')
    .requiredOption('--asset <address>', "the vault's DemoToken")
    .option('--amount <tokens>', 'tokens to deposit, decimal, 18 decimals', '1')
    .action(async (vaultArg: string, opts: { asset: string; amount: string }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo deposit', WATCH_FAILED_EXIT_CODE, async () => {
        const vault = address(vaultArg, '<vault>');
        const asset = address(opts.asset, '--asset');
        if (!/^\d+(\.\d{1,18})?$/.test(opts.amount)) throw new ConfigError(`--amount must be a decimal number of tokens, got "${opts.amount}"`);
        const amount = parseEther(opts.amount);
        const { net, client, wallet } = signer(command);
        try {
          const tx = await depositIntoDemoVault({ client, wallet, vault, asset, amount });
          printLine(ctx, stage('demo', `deposited ${opts.amount} into ${pc.bold(vault)}  ${pc.dim(`block ${tx.blockNumber}  tx ${tx.hash}`)}`));
          emitEvent(ctx, { type: 'watch-demo-deposit', chainId: net.clients.chain.id, vault, asset, amount: amount.toString(), txHash: tx.hash, blockNumber: tx.blockNumber.toString() });
        } catch (err) {
          failed(err);
        }
      });
    });

  demo
    .command('set-broken <vault> <on|off>')
    .description("Switch the vault's deliberate previewDeposit bug on or off (operator only); a re-check then sees the result change.")
    .action(async (vaultArg: string, state: string, _opts: unknown, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo set-broken', WATCH_FAILED_EXIT_CODE, async () => {
        const vault = address(vaultArg, '<vault>');
        if (state !== 'on' && state !== 'off') throw new ConfigError(`<on|off> must be on or off, got "${state}"`);
        const { net, client, wallet } = signer(command);
        try {
          const tx = await setDemoVaultBroken({ client, wallet, vault, broken: state === 'on' });
          printLine(ctx, stage('demo', `${pc.bold(vault)} previewDeposit bug ${state === 'on' ? pc.red('on') : pc.green('off')}  ${pc.dim(`block ${tx.blockNumber}  tx ${tx.hash}`)}`));
          emitEvent(ctx, { type: 'watch-demo-set-broken', chainId: net.clients.chain.id, vault, broken: state === 'on', txHash: tx.hash, blockNumber: tx.blockNumber.toString() });
        } catch (err) {
          failed(err);
        }
      });
    });

  demo
    .command('loss <vault> <bps>')
    .description(
      `Send <bps> basis points (1 to 9999) of the vault's assets away (operator only): one share is then worth that much less, which the watcher reports as a price-drop. Vaults of the factory before setLoss (${LEGACY_DEMO_FACTORY_ADDRESS}) cannot.`,
    )
    .action(async (vaultArg: string, bpsArg: string, _opts: unknown, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo loss', WATCH_FAILED_EXIT_CODE, async () => {
        const vault = address(vaultArg, '<vault>');
        if (!/^[1-9]\d{0,3}$/.test(bpsArg) || Number(bpsArg) > 9_999) throw new ConfigError(`<bps> must be a whole number of basis points from 1 to 9999, got "${bpsArg}"`);
        const bps = Number(bpsArg);
        const { net, client, wallet } = signer(command);
        try {
          const tx = await setDemoVaultLoss({ client, wallet, vault, bps });
          const event = { type: 'watch-demo-loss', chainId: net.clients.chain.id, vault, bps, assets: tx.assets.toString() };
          if (!tx.sent) {
            printLine(ctx, stage('demo', `${pc.bold(vault)} nothing changed: ${dropPercentText(bps)} of its ${tx.totalAssets} base units of assets rounds to 0, so the share value stays; nothing sent`));
            emitEvent(ctx, { ...event, changed: false, totalAssets: tx.totalAssets.toString(), txHash: null, blockNumber: null });
          } else if (tx.assets === 0n) {
            printLine(ctx, stage('demo', `${pc.bold(vault)} nothing changed: the loss rounded to 0 base units, so the share value stays  ${pc.dim(`block ${tx.blockNumber}  tx ${tx.hash}`)}`));
            emitEvent(ctx, { ...event, changed: false, txHash: tx.hash, blockNumber: tx.blockNumber.toString() });
          } else {
            printLine(ctx, stage('demo', `${pc.bold(vault)} lost ${dropPercentText(bps)} of its assets (${tx.assets} base units)  ${pc.dim(`block ${tx.blockNumber}  tx ${tx.hash}`)}`));
            emitEvent(ctx, { ...event, changed: true, txHash: tx.hash, blockNumber: tx.blockNumber.toString() });
          }
        } catch (err) {
          failed(err);
        }
      });
    });
  registerWatchDemoGate(demo);
}
