import path from 'node:path';
import {
  acquireWorkerLock,
  AttestationRegistryClient,
  badChecksum,
  checkRequestDeskCreationCodeHash,
  DEFAULT_BLOCK_LAG,
  DEFAULT_REPORT_BASE_URL,
  DEFAULT_WORKER_CONFIG,
  DEFAULT_WORKER_POLL_SEC,
  DEFAULT_WORKER_RUNS,
  defaultCacheDir,
  DESK_FAILED_EXIT_CODE,
  DeskError,
  deployRequestDesk,
  errorText,
  liveWorkerEffects,
  MONAD_MAINNET_CHAIN_ID,
  NETWORKS,
  reasonOf,
  REPORT_BASE_URL_ENV,
  REQUEST_STATUS,
  RequestDeskClient,
  rpcTransport,
  runWorkerPass,
  STANDARDS,
  standardIdOf,
  WorkerError,
  WorkerStore,
  type DeskRequest,
  type RunStandardCheckInput,
  type StandardCheckClient,
  type StandardCheckReport,
  type StandardName,
  type SubjectClient,
  type WorkerConfig,
  type WorkerEvent,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createPublicClient, formatEther, getAddress, parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contextFrom, emitEvent, printLine, type CliContext } from '../lib/context.js';
import {
  ConfigError,
  DEPLOYER_KEY_ENV,
  deskEnvVar,
  ISSUER_KEY_ENV,
  optionalKey,
  REQUESTER_KEY_ENV,
  resolveAttestRegistry,
  resolveDesk,
  resolveKey,
  resolveNetwork,
  subjectRpcFor,
} from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

export const DEFAULT_DESK_FEE_MON = '0.1';
/** Six hours: long enough for a queue of suite runs, short enough that a stopped worker does not hold fees for days. */
export const DEFAULT_DESK_TIMEOUT_SEC = '21600';
const MAX_UINT96 = 2n ** 96n - 1n;
const MAX_UINT64 = 2n ** 64n - 1n;

interface NetOptions {
  network: string;
  rpc?: string;
  desk?: string;
}

function address(raw: string, what: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || badChecksum(raw)) throw new ConfigError(`${what} must be a 0x address with a valid checksum, got "${raw}"`);
  return getAddress(raw);
}

function positiveInt(raw: string, what: string, max = BigInt(Number.MAX_SAFE_INTEGER)): bigint {
  if (!/^[1-9]\d*$/.test(raw) || BigInt(raw) > max) throw new ConfigError(`${what} must be a positive integer up to ${max}, got "${raw}"`);
  return BigInt(raw);
}

function mon(wei: bigint): string {
  return `${formatEther(wei)} MON`;
}

function warn(name: string, warnings: string[], message: string): void {
  warnings.push(message);
  console.error(pc.yellow(`specfirst ${name}: warning: ${message}`));
}

function deskFailure(err: unknown): never {
  if (err instanceof DeskError) throw new StageError(DESK_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
  throw err;
}

const deskOptions = (c: Command, readOnly = false) =>
  c
    .option(
      '--network <name>',
      readOnly ? 'network of the desk (monad-testnet, anvil; read only, so monad-mainnet is allowed)' : 'network of the desk: monad-testnet or anvil (monad-mainnet is refused)',
      'monad-testnet',
    )
    .option('--rpc <url>', 'RPC URL of that network (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--desk <address>', 'CheckRequestDesk address (default: $SPECFIRST_DESK_<chainId>)');

function requestJson(id: bigint, r: DeskRequest): Record<string, unknown> {
  const status = REQUEST_STATUS[r.status] ?? String(r.status);
  return {
    id: id.toString(),
    requester: r.requester,
    subjectChainId: r.subjectChainId.toString(),
    subject: r.subject,
    standardId: r.standardId,
    standard: STANDARDS.find((s) => standardIdOf(s) === r.standardId.toLowerCase()) ?? null,
    fee: r.fee.toString(),
    requestedAt: r.requestedAt.toString(),
    status,
    ...(status === 'Fulfilled' ? { attestationId: r.attestationId.toString() } : {}),
    ...(status === 'Rejected' ? { rejectReason: reasonOf(r.rejectReason) } : {}),
  };
}

function requestLine(id: bigint, r: DeskRequest, timeout: bigint): string {
  const status = REQUEST_STATUS[r.status] ?? String(r.status);
  const color = status === 'Fulfilled' ? pc.green : status === 'Pending' ? pc.yellow : status === 'Rejected' || status === 'Refunded' ? pc.red : pc.dim;
  const when = new Date(Number(r.requestedAt) * 1000).toISOString();
  const tail =
    status === 'Fulfilled'
      ? `attestation ${r.attestationId}`
      : status === 'Rejected'
        ? `reason ${reasonOf(r.rejectReason)}`
        : status === 'Pending'
          ? `refundable from ${new Date(Number(r.requestedAt + timeout) * 1000).toISOString()}`
          : '';
  return `  #${String(id).padEnd(4)} ${color(status.padEnd(9))} ${r.subject}  chain ${r.subjectChainId}  ${mon(r.fee)}  ${pc.dim(`${when}  by ${r.requester}`)}  ${tail}`;
}

/**
 * `specfirst desk deploy|request|status|withdraw` (docs/adr/0005). Writes go through resolveNetwork without
 * readOnly, so monad-mainnet is refused before a key is read, and through the guarded wallet whose transport
 * checks eth_chainId before the first send. Exit 0, or 18 on any desk failure.
 */
export function registerDeskCommand(program: Command): void {
  const group = program.command('desk').description('CheckRequestDesk: paid check requests fulfilled by the worker (ADR 0005).');

  group
    .command('deploy')
    .description('Deploy CheckRequestDesk with DEPLOYER_PRIVATE_KEY as owner, the ISSUER_PRIVATE_KEY address as worker and the attestation registry.')
    .option('--network <name>', 'monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--registry-attest <address>', 'CheckAttestationRegistry the desk fulfills against (default: $SPECFIRST_ATTEST_REGISTRY_<chainId>)')
    .option('--worker <address>', 'address allowed to fulfill and reject (default: the address of ISSUER_PRIVATE_KEY)')
    .option('--fee <MON>', 'fee per request in MON, decimal', DEFAULT_DESK_FEE_MON)
    .option('--timeout <sec>', 'seconds after a request from which anyone can refund it', DEFAULT_DESK_TIMEOUT_SEC)
    .action(async (opts: { network: string; rpc?: string; registryAttest?: string; worker?: string; fee: string; timeout: string }, command: Command) => {
      const ctx = contextFrom(command);
      const name = 'desk deploy';
      await runStage(ctx, name, DESK_FAILED_EXIT_CODE, async () => {
        if (!/^\d+(\.\d{1,18})?$/.test(opts.fee)) throw new ConfigError(`--fee must be a decimal amount of MON with at most 18 decimals, got "${opts.fee}"`);
        const fee = parseEther(opts.fee);
        if (fee > MAX_UINT96) throw new ConfigError(`--fee ${opts.fee} MON does not fit uint96`);
        const timeout = positiveInt(opts.timeout, '--timeout', MAX_UINT64);
        const explicit = opts.worker !== undefined ? address(opts.worker, '--worker') : undefined;
        const net = resolveNetwork(opts);
        const deployerKey = resolveKey(net, DEPLOYER_KEY_ENV);
        const issuerKey = optionalKey(ISSUER_KEY_ENV);
        const worker = explicit ?? (issuerKey ? privateKeyToAccount(issuerKey).address : undefined);
        if (!worker) throw new ConfigError(`no worker: pass --worker <address> or set ${ISSUER_KEY_ENV} (the worker signs with it)`);
        const registry = resolveAttestRegistry(net, opts);
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const client = net.clients.publicClient;
        const code = await client.getCode({ address: registry });
        if (!code || code === '0x') throw new ConfigError(`no contract at the registry address ${registry} on ${net.name}`);
        const warnings: string[] = [];
        if (fee === 0n) warn(name, warnings, 'the fee is 0: anyone can queue checks for free, and every one costs the worker gas');
        const reg = new AttestationRegistryClient(registry, client);
        if (!(await reg.isIssuer(worker))) {
          warn(name, warnings, `worker ${worker} is not an issuer of ${registry}; it cannot attest, so fulfill has nothing to point at until \`specfirst attest-registry set-issuer ${worker}\``);
        }
        if (explicit && issuerKey && explicit !== privateKeyToAccount(issuerKey).address) {
          warn(name, warnings, `--worker ${explicit} is not the address of ${ISSUER_KEY_ENV}; \`specfirst worker\` signs with ${ISSUER_KEY_ENV} and refuses to start until they match`);
        }
        const wallet = net.clients.wallet(deployerKey);
        const envName = deskEnvVar(net.clients.chain.id);
        let out;
        try {
          out = await deployRequestDesk({ client, wallet, owner: wallet.account.address, worker, registry, fee, timeout });
        } catch (err) {
          deskFailure(err);
        }
        printLine(ctx, stage('desk', `CheckRequestDesk ${pc.bold(out.address)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
        printLine(ctx, cont(`fee ${mon(fee)}  timeout ${timeout}s  worker ${worker}  owner ${wallet.account.address}`));
        printLine(ctx, cont(pc.dim(`registry ${registry}  tx ${out.tx.hash}  block ${out.tx.blockNumber}  creation code keccak ${checkRequestDeskCreationCodeHash}`)));
        printLine(ctx, cont(`export ${envName}=${out.address}`));
        emitEvent(ctx, {
          type: 'desk-deployed',
          address: out.address,
          chainId: net.clients.chain.id,
          owner: wallet.account.address,
          worker,
          registry,
          fee: fee.toString(),
          timeout: timeout.toString(),
          txHash: out.tx.hash,
          blockNumber: out.tx.blockNumber.toString(),
          creationCodeKeccak: checkRequestDeskCreationCodeHash,
          envName,
          warnings,
        });
      });
    });

  deskOptions(
    group
      .command('request <address>')
      .description('Pay the fee from REQUESTER_PRIVATE_KEY to request a check of <address>. For testing the desk; users request from the web.')
      .option('--subject-chain <id>', 'chain the subject lives on', String(MONAD_MAINNET_CHAIN_ID))
      .option('--standard <name>', `standard to check (${STANDARDS.join(', ')})`, 'erc4626'),
  ).action(async (subjectArg: string, opts: NetOptions & { subjectChain: string; standard: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'desk request', DESK_FAILED_EXIT_CODE, async () => {
      const subject = address(subjectArg, '<address>');
      const subjectChainId = positiveInt(opts.subjectChain, '--subject-chain', MAX_UINT64);
      if (!(STANDARDS as readonly string[]).includes(opts.standard)) throw new ConfigError(`--standard must be one of ${STANDARDS.join(', ')}, got "${opts.standard}"`);
      const standardId = standardIdOf(opts.standard as StandardName);
      const net = resolveNetwork(opts);
      const requesterKey = optionalKey(REQUESTER_KEY_ENV);
      if (!requesterKey) throw new ConfigError(`${REQUESTER_KEY_ENV} is not set; desk request pays the fee from that key (never the deployer's or the worker's)`);
      const deskAddress = resolveDesk(net, opts);
      const desk = new RequestDeskClient(deskAddress, net.clients.publicClient, net.clients.wallet(requesterKey));
      let out;
      try {
        out = await desk.requestCheck({ subjectChainId, subject, standardId });
      } catch (err) {
        deskFailure(err);
      }
      const requester = privateKeyToAccount(requesterKey).address;
      printLine(ctx, stage('request', `#${out.id}  ${subject}  chain ${subjectChainId}  ${opts.standard}  paid ${mon(out.fee)}  ${pc.dim(`desk ${deskAddress}`)}`));
      printLine(ctx, cont(pc.dim(`requester ${requester}  tx ${out.hash}  block ${out.blockNumber}`)));
      emitEvent(ctx, {
        type: 'desk-requested',
        id: out.id.toString(),
        desk: deskAddress,
        chainId: net.clients.chain.id,
        requester,
        subjectChainId: subjectChainId.toString(),
        subject,
        standard: opts.standard,
        standardId,
        fee: out.fee.toString(),
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
      });
    });
  });

  deskOptions(
    group
      .command('status [id]')
      .description('Read the desk: settings, earned, withdrawn and escrowed fees, and the latest requests (or one). Read only.')
      .option('--limit <n>', 'how many of the latest requests to list', '20'),
    true,
  ).action(async (idArg: string | undefined, opts: NetOptions & { limit: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'desk status', DESK_FAILED_EXIT_CODE, async () => {
      if (idArg !== undefined && !/^(0|[1-9]\d*)$/.test(idArg)) throw new ConfigError(`[id] must be a non-negative integer, got "${idArg}"`);
      const limit = positiveInt(opts.limit, '--limit', 1000n);
      const net = resolveNetwork(opts, process.env, { readOnly: true });
      const deskAddress = resolveDesk(net, opts);
      const desk = new RequestDeskClient(deskAddress, net.clients.publicClient);
      const s = await desk.summary();
      const ids: bigint[] = [];
      if (idArg !== undefined) ids.push(BigInt(idArg));
      else for (let id = s.requestCount > limit ? s.requestCount - limit : 0n; id < s.requestCount; id++) ids.push(id);
      const requests: Array<{ id: bigint; request: DeskRequest }> = [];
      for (const id of ids) {
        try {
          requests.push({ id, request: await desk.requestOf(id) });
        } catch (err) {
          deskFailure(err);
        }
      }
      const available = s.earned - s.withdrawn;
      printLine(ctx, stage('desk', `${pc.bold(deskAddress)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}  fee ${mon(s.fee)}  timeout ${s.timeout}s  ${s.requestCount} request${s.requestCount === 1n ? '' : 's'}`));
      printLine(ctx, cont(`earned ${pc.green(mon(s.earned))}  withdrawn ${mon(s.withdrawn)}  withdrawable ${mon(available)}  escrowed ${pc.yellow(mon(s.escrowed))}  balance ${mon(s.balance)}`));
      printLine(ctx, cont(pc.dim(`owner ${s.owner}  worker ${s.worker}  registry ${s.registry}`)));
      for (const r of requests) printLine(ctx, requestLine(r.id, r.request, s.timeout));
      emitEvent(ctx, {
        type: 'desk-status',
        desk: deskAddress,
        chainId: net.clients.chain.id,
        owner: s.owner,
        worker: s.worker,
        registry: s.registry,
        fee: s.fee.toString(),
        timeout: s.timeout.toString(),
        requestCount: s.requestCount.toString(),
        earned: s.earned.toString(),
        withdrawn: s.withdrawn.toString(),
        withdrawable: available.toString(),
        escrowed: s.escrowed.toString(),
        balance: s.balance.toString(),
        requests: requests.map((r) => requestJson(r.id, r.request)),
      });
    });
  });

  deskOptions(
    group
      .command('withdraw')
      .description('Pay the earned fees not withdrawn yet to --to. Signs with DEPLOYER_PRIVATE_KEY (the owner). Escrowed fees stay.')
      .requiredOption('--to <address>', 'recipient of the earned fees'),
  ).action(async (opts: NetOptions & { to: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'desk withdraw', DESK_FAILED_EXIT_CODE, async () => {
      const to = address(opts.to, '--to');
      const net = resolveNetwork(opts);
      const ownerKey = resolveKey(net, DEPLOYER_KEY_ENV);
      const deskAddress = resolveDesk(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const wallet = net.clients.wallet(ownerKey);
      const desk = new RequestDeskClient(deskAddress, net.clients.publicClient, wallet);
      const owner = await desk.owner();
      if (owner !== wallet.account.address) throw new ConfigError(`${DEPLOYER_KEY_ENV} is ${wallet.account.address}, the desk owner is ${owner}`);
      const [earned, withdrawn, escrowed] = [await desk.earned(), await desk.withdrawn(), await desk.escrowed()];
      if (earned === withdrawn) {
        throw new StageError(DESK_FAILED_EXIT_CODE, `nothing to withdraw: earned ${mon(earned)}, withdrawn ${mon(withdrawn)}; ${mon(escrowed)} escrowed for Pending requests is not the owner's`);
      }
      let out;
      try {
        out = await desk.withdraw(to);
      } catch (err) {
        deskFailure(err);
      }
      printLine(ctx, stage('withdraw', `${pc.green(mon(out.amount))} to ${to}  ${pc.dim(`desk ${deskAddress}  tx ${out.hash}`)}`));
      printLine(ctx, cont(pc.dim(`escrowed ${mon(escrowed)} stays for Pending requests`)));
      emitEvent(ctx, {
        type: 'desk-withdrawn',
        desk: deskAddress,
        chainId: net.clients.chain.id,
        to,
        amount: out.amount.toString(),
        earned: earned.toString(),
        withdrawn: (withdrawn + out.amount).toString(),
        escrowed: escrowed.toString(),
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
      });
    });
  });
}

/** Injection points for tests: the property suite, and faster retries. */
export interface WorkerCommandDeps {
  runCheck?: (input: RunStandardCheckInput) => Promise<StandardCheckReport>;
  config?: Partial<WorkerConfig>;
  sleep?: (ms: number) => Promise<void>;
}

interface WorkerOptions extends NetOptions {
  subjectRpc?: string;
  poll: string;
  once?: boolean;
  runs: string;
  blockLag: string;
  reportBaseUrl?: string;
  allowUnknownProxy?: boolean;
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

function logWorkerEvent(ctx: CliContext, e: WorkerEvent): void {
  switch (e.type) {
    case 'worker-pass':
      if (e.open.length) printLine(ctx, stage('pass', `${e.requestCount} requests  cursor ${e.cursor}  open ${e.open.map((i) => `#${i}`).join(' ')}`));
      return;
    case 'worker-stage': {
      const extra = [e.block ? `block ${e.block}` : '', e.reportPath ?? '', e.attestationId ? `attestation ${e.attestationId}` : '', e.txHash ? `tx ${e.txHash}` : ''].filter(Boolean).join('  ');
      printLine(ctx, cont(`#${e.id} ${e.stage}  ${pc.dim(extra)}`));
      return;
    }
    case 'worker-retry':
      printLine(ctx, cont(pc.yellow(`#${e.id} ${e.step} attempt ${e.attempt} failed, retrying: ${e.error}`)));
      return;
    case 'worker-step-failed':
      printLine(ctx, cont(pc.yellow(`#${e.id} ${e.step} failed (${e.failures}): ${e.error}`)));
      return;
    case 'worker-fulfilled':
      printLine(ctx, cont(`#${e.id} ${pc.green('fulfilled')}  attestation ${e.attestationId}  ${pc.dim(`tx ${e.txHash}  gas ${formatEther(BigInt(e.gasCostWei))} MON`)}`));
      return;
    case 'worker-rejected':
      printLine(ctx, cont(`#${e.id} ${pc.red('rejected')} ${e.reason}${e.detail ? `: ${e.detail}` : ''}  ${pc.dim(`refunded, tx ${e.txHash}`)}`));
      return;
    case 'worker-closed':
      printLine(ctx, cont(pc.dim(`#${e.id} closed onchain (${e.status})`)));
      return;
    case 'worker-reused':
      printLine(ctx, cont(pc.dim(`#${e.id} delivered by this worker's attestation ${e.attestationId}, made after the request; no second check`)));
      return;
    case 'worker-gave-up':
      printLine(ctx, cont(pc.red(`#${e.id} gave up: ${e.error}`)));
      return;
    case 'worker-error':
      printLine(ctx, cont(pc.red(`#${e.id} error: ${e.error}`)));
      return;
    case 'worker-pass-done':
      if (e.fulfilled.length || e.rejected.length || e.open.length) {
        printLine(ctx, cont(pc.dim(`cursor ${e.cursor}  fulfilled ${e.fulfilled.length}  rejected ${e.rejected.length}  open ${e.open.length}`)));
      }
      return;
  }
}

/**
 * `specfirst worker`: the unattended loop behind the desk. Each pass reads requestCount() and requestOf()
 * from the cursor in .specfirst/worker/state.json (no event logs: the testnet caps getLogs at 100 blocks and
 * the public RPC at about 15 requests per second), handles Pending requests one at a time (pre-check,
 * check, report copy, identity check, attest, fulfill; reject with a refund when it cannot) and writes
 * per-request progress to .specfirst/worker/status.json for the web. Signs with ISSUER_PRIVATE_KEY, which
 * must be both the desk's worker and a registry issuer; monad-mainnet is refused for the desk network.
 * NDJSON events with --json. Runs until stopped, or one pass with --once.
 */
export function registerWorkerCommand(program: Command, deps: WorkerCommandDeps = {}): void {
  deskOptions(
    program
      .command('worker')
      .description('Serve the request desk: check Pending requests, attest and fulfill them, or reject with a refund. Runs until stopped.')
      .option('--subject-rpc <url>', 'read-only RPC of the subject chain; requests for other chains are rejected (default: Monad mainnet, $MONAD_MAINNET_RPC or the public RPC)')
      .option('--poll <sec>', 'seconds between passes', String(DEFAULT_WORKER_POLL_SEC))
      .option('--once', 'run a single pass and exit')
      .option('--runs <n>', 'fuzz runs per property', String(DEFAULT_WORKER_RUNS))
      .option('--block-lag <n>', 'check this many blocks below the latest subject block', DEFAULT_BLOCK_LAG.toString())
      .option('--report-base-url <url>', `public URL of certs/checks for reportURI (default: $${REPORT_BASE_URL_ENV} or ${DEFAULT_REPORT_BASE_URL})`)
      .option('--allow-unknown-proxy', 'attest proxy-shaped subjects whose implementation cannot be resolved instead of rejecting them'),
  ).action(async (opts: WorkerOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'worker', DESK_FAILED_EXIT_CODE, async () => {
      const poll = positiveInt(opts.poll, '--poll', 86_400n);
      const runs = Number(positiveInt(opts.runs, '--runs', 100_000n));
      if (!/^(0|[1-9]\d*)$/.test(opts.blockLag)) throw new ConfigError(`--block-lag must be a non-negative integer, got "${opts.blockLag}"`);
      const blockLag = BigInt(opts.blockLag);
      const base = reportBase(opts.reportBaseUrl ?? process.env[REPORT_BASE_URL_ENV] ?? DEFAULT_REPORT_BASE_URL);
      const net = resolveNetwork(opts);
      const workerKey = resolveKey(net, ISSUER_KEY_ENV);
      const deskAddress = resolveDesk(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const wallet = net.clients.wallet(workerKey);
      const me = wallet.account.address;
      const desk = new RequestDeskClient(deskAddress, net.clients.publicClient, wallet);
      const deskWorker = await desk.worker();
      if (deskWorker !== me) throw new ConfigError(`the desk's worker is ${deskWorker}, ${ISSUER_KEY_ENV} is ${me}; run the worker with the desk's worker key (or setWorker)`);
      const registryAddress = getAddress(await desk.registry());
      const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient, wallet);
      if (!(await registry.isIssuer(me))) throw new ConfigError(`${me} is not an issuer of ${registryAddress}: \`specfirst attest-registry set-issuer ${me} --registry-attest ${registryAddress}\``);

      const subjectUrl = opts.subjectRpc ?? subjectRpcFor(MONAD_MAINNET_CHAIN_ID, undefined);
      const probe = createPublicClient({ transport: rpcTransport([subjectUrl]) });
      const subjectChainId = await probe.getChainId();
      const chain = Object.values(NETWORKS).find((c) => c.id === subjectChainId);
      const subjectClient = createPublicClient({ ...(chain ? { chain } : {}), transport: rpcTransport([subjectUrl]) }) as unknown as StandardCheckClient & SubjectClient;

      let store: WorkerStore;
      let release: () => Promise<void>;
      try {
        store = await WorkerStore.load(ctx.projectDir, { address: deskAddress, chainId: net.clients.chain.id });
        release = await acquireWorkerLock(ctx.projectDir);
      } catch (err) {
        if (err instanceof WorkerError) throw new ConfigError(err.message);
        throw err;
      }
      const effects = liveWorkerEffects({
        desk,
        registry,
        workerAddress: me,
        subjectClient,
        subjectChainId,
        subjectRpcUrl: subjectUrl,
        projectDir: ctx.projectDir,
        reportBaseUrl: base,
        runs,
        cacheDir: defaultCacheDir(),
        ...(deps.runCheck ? { runCheck: deps.runCheck } : {}),
        ...(deps.sleep ? { sleep: deps.sleep } : {}),
        onCheckEvent: (e) => emitEvent(ctx, e),
      });
      const config: Partial<WorkerConfig> = { ...DEFAULT_WORKER_CONFIG, blockLag, allowUnknownProxy: Boolean(opts.allowUnknownProxy), ...deps.config };
      const rel = (p: string) => path.relative(ctx.projectDir, p);
      printLine(ctx, stage('worker', `${me}  desk ${pc.bold(deskAddress)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
      printLine(ctx, cont(pc.dim(`registry ${registryAddress}  subject chain ${subjectChainId}  runs ${runs}  block lag ${blockLag}  ${opts.once ? 'one pass' : `poll ${poll}s`}  ${rel(store.statusPath)}`)));
      emitEvent(ctx, {
        type: 'worker-start',
        worker: me,
        desk: deskAddress,
        chainId: net.clients.chain.id,
        registry: registryAddress,
        subjectChainId,
        runs,
        blockLag: blockLag.toString(),
        poll: Number(poll),
        once: Boolean(opts.once),
        reportBaseUrl: base,
        statusPath: rel(store.statusPath),
        statePath: rel(store.statePath),
      });

      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      try {
        for (;;) {
          try {
            await runWorkerPass({
              effects,
              store,
              config,
              onEvent: (e) => {
                emitEvent(ctx, e);
                logWorkerEvent(ctx, e);
              },
            });
          } catch (err) {
            const error = errorText(err);
            emitEvent(ctx, { type: 'worker-pass-error', error });
            console.error(pc.red(`specfirst worker: pass failed: ${error}`));
            if (opts.once) throw new StageError(DESK_FAILED_EXIT_CODE, `pass failed: ${error}`);
          }
          if (opts.once) break;
          await sleep(Number(poll) * 1000);
        }
      } finally {
        await release();
      }
    });
  });
}
