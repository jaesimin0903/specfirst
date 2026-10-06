import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  acquireWatchLock,
  badChecksum,
  DEMO_FACTORY_ADDRESS,
  deployDemoFactory,
  deployDemoToken,
  deployDemoVault,
  depositIntoDemoVault,
  setDemoVaultBroken,
  ANVIL_CHAIN_ID,
  ANVIL_DEFAULT_RPC,
  AttestationRegistryClient,
  builtinSources,
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
  verifySourceFixture,
  WATCH_FAILED_EXIT_CODE,
  Watcher,
  WatchError,
  WatchStore,
  type FeedEvent,
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
import { createPublicClient, getAddress, parseEther, type Address, type PublicClient } from 'viem';
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
  WATCH_ISSUER_KEY_ENV,
  attestRegistryEnvVar,
} from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

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
  maxAttestPerDay: string;
  attest: boolean;
  shareIssuerKey?: boolean;
  network: string;
  rpc?: string;
  registryAttest?: string;
  reportBaseUrl?: string;
  allowUnknownProxy?: boolean;
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

/** A read-only client over `urls` that also fails over on node errors, and refuses an RPC of another chain. */
async function subjectClientFor(urls: string[], chainId: number): Promise<StandardCheckClient & SubjectClient & Pick<PublicClient, 'request'>> {
  const chain = Object.values(NETWORKS).find((c) => c.id === chainId);
  const client = createPublicClient({ ...(chain ? { chain } : {}), transport: rpcTransport(urls, { failoverIf: isNodeError }) });
  let reported: number;
  try {
    reported = await client.getChainId();
  } catch (err) {
    throw new ConfigError(`the subject RPC ${urls.join(', ')} did not answer eth_chainId: ${errorText(err)}`);
  }
  if (reported !== chainId) throw new ConfigError(`the subject RPC ${urls[0]} serves chain ${reported}, not --subject-chain ${chainId}`);
  return client as unknown as StandardCheckClient & SubjectClient & Pick<PublicClient, 'request'>;
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
    case 'changed':
      return cont(`${pc.yellow('changed')}  ${who}  ${e.change!.kind}  ${pc.dim(e.change!.from ? `failed [${e.change!.from.failed.join(' ')}] to [${e.change!.to.failed.join(' ')}]` : `failed [${e.change!.to.failed.join(' ')}]`)}`);
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
 * WATCH_ISSUER_PRIVATE_KEY, falling back to ISSUER_PRIVATE_KEY only with --share-issuer-key. Files under
 * .specfirst/watch/<subjectChainId>/ of --project. NDJSON events with --json. Exit 19 when it cannot start.
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
    .option('--max-attest-per-day <n>', 'attestations per UTC day; more wait for the next day', String(DEFAULT_WATCH_CONFIG.maxAttestPerDay))
    .option('--no-attest', 'decide and record, send nothing (no key needed)')
    .option('--share-issuer-key', `sign with ${ISSUER_KEY_ENV} when ${WATCH_ISSUER_KEY_ENV} is unset (the desk worker's key: do not run both at once)`)
    .option('--network <name>', 'network of the attestation registry: monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL of that network (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--registry-attest <address>', 'CheckAttestationRegistry (default: $SPECFIRST_ATTEST_REGISTRY_<chainId>)')
    .option('--report-base-url <url>', `public URL of certs/checks for reportURI (default: $${REPORT_BASE_URL_ENV} or ${DEFAULT_REPORT_BASE_URL})`)
    .option('--allow-unknown-proxy', 'attest proxy-shaped subjects whose implementation cannot be resolved')
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
        const maxAttestPerDay = Number(nonNegative(opts.maxAttestPerDay, '--max-attest-per-day', 1_000_000n));
        const base = reportBase(opts.reportBaseUrl ?? process.env[REPORT_BASE_URL_ENV] ?? DEFAULT_REPORT_BASE_URL);
        const { sources, from: sourcesFrom } = await loadSources(opts.sources, subjectChainId, ctx.projectDir);

        // The attestation side first: a refused network or a missing key stops before any subject RPC call.
        let registry: AttestationRegistryClient | null = null;
        let issuer: string | null = null;
        let attestOn = '';
        if (opts.attest) {
          const net = resolveNetwork(opts);
          let key = optionalKey(WATCH_ISSUER_KEY_ENV);
          if (!key && opts.shareIssuerKey) key = optionalKey(ISSUER_KEY_ENV);
          if (!key) {
            try {
              key = resolveKey(net, WATCH_ISSUER_KEY_ENV);
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
          const net = resolveNetwork(opts, process.env, { readOnly: true });
          if (opts.registryAttest ?? process.env[attestRegistryEnvVar(net.clients.chain.id)]) {
            registry = new AttestationRegistryClient(getAddress(resolveAttestRegistry(net, opts)), net.clients.publicClient);
            attestOn = `${net.name} ${net.clients.chain.id}, read only`;
          }
        }

        const urls = watchSubjectRpcs(subjectChainId, opts.subjectRpc);
        const subjectClient = await subjectClientFor(urls, subjectChainId);
        let store: WatchStore;
        let release: () => Promise<void>;
        try {
          store = await WatchStore.load(ctx.projectDir, subjectChainId);
          release = await acquireWatchLock(ctx.projectDir, subjectChainId);
        } catch (err) {
          if (err instanceof WatchError) throw new ConfigError(err.message);
          throw err;
        }
        try {
          const seeded = await seedKnownVaults(ctx.projectDir, store);
          for (const s of seeded.skipped) console.error(pc.yellow(`specfirst watch: warning: skipped ${s}`));
          if (fromBlock !== null) store.state.cursor = fromBlock.toString();
          const effects = liveWatchEffects({
            subjectClient,
            subjectChainId,
            subjectRpcUrl: urls[0]!,
            projectDir: ctx.projectDir,
            runs,
            timeoutSec: checkTimeoutSec,
            cacheDir: defaultCacheDir(),
            reportBaseUrl: base,
            registry,
            attest: opts.attest,
            ...(deps.runCheck ? { runCheck: deps.runCheck } : {}),
            onCheckEvent: (e) => emitEvent(ctx, e),
          });
          const config: Partial<WatchConfig> = {
            lagBlocks: blockLag,
            sweepHours,
            sweepPerHour,
            subscribedMinutes,
            maxAttestPerDay,
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
            ...(deps.hooks ? { hooks: deps.hooks } : {}),
            onEvent: (e) => {
              emitEvent(ctx, e);
              logWatchEvent(ctx, e);
            },
          });
          const rel = (p: string) => path.relative(ctx.projectDir, p);
          const known = Object.keys(store.vaults.vaults).length;
          printLine(ctx, stage('watch', `chain ${subjectChainId}  ${sources.length} sources (${sourcesFrom})  ${known} known vault${known === 1 ? '' : 's'}  ${pc.dim(rel(store.dir))}`));
          printLine(ctx, cont(pc.dim(`subject RPC ${urls.length > 1 ? `${urls[0]} (+${urls.length - 1} fallback)` : urls[0]}  lag ${blockLag}  window ${logWindow}  runs ${runs}  check timeout ${checkTimeoutSec}s  ${opts.once ? 'one pass' : `poll ${poll}s`}`)));
          printLine(
            ctx,
            cont(pc.dim(registry ? `registry ${registry.address} on ${attestOn}${issuer ? `  issuer ${issuer}` : ''}  ${opts.attest ? `max ${maxAttestPerDay} attestations a day` : 'no attest'}` : 'no attest, no registry: decisions assume no attestation')),
          );
          emitEvent(ctx, {
            type: 'watch-start',
            subjectChainId,
            subjectRpcs: urls.length,
            sources: sources.map((s) => s.name),
            sourcesFrom,
            known,
            seeded: { added: seeded.added, updated: seeded.updated, skipped: seeded.skipped.length },
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
            maxAttestPerDay,
            reportBaseUrl: base,
            dir: rel(store.dir),
          });

          const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
          for (;;) {
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

  registerWatchDemo(watch);
}

function address(raw: string, what: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || badChecksum(raw)) throw new ConfigError(`${what} must be a 0x address with a valid checksum, got "${raw}"`);
  return getAddress(raw);
}

/**
 * `specfirst watch demo deploy|vault|deposit|set-broken`: the contracts of the watcher demo (ADR 0006) on
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
}
