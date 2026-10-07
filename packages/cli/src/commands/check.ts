import path from 'node:path';
import {
  badChecksum,
  DEFAULT_STANDARD_RUNS,
  defaultCacheDir,
  MAX_UINT256,
  rpcTransport,
  runStandardCheck,
  STANDARD_CHECK_FAILED_EXIT_CODE,
  STANDARD_CHECK_INCOMPLETE_EXIT_CODE,
  standardCheckExitCode,
  standardCheckPath,
  standardNameSchema,
  type StandardCheckClient,
  type StandardCheckEvent,
  type StandardCheckReport,
  type StandardName,
  type StandardPropertyResult,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createPublicClient, getAddress, type Address } from 'viem';
import { contextFrom, emitEvent, printLine, type CliContext } from '../lib/context.js';
import { ConfigError, resolveNetwork } from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

export interface CheckOptions {
  standard: string;
  network: string;
  rpc?: string;
  block?: string;
  runs: string;
  delta: string;
  seed?: string;
}

export interface CheckArgs {
  standard: StandardName;
  address: Address;
  block?: bigint;
  runs: number;
  delta: bigint;
  seed?: bigint;
}

const UINT = /^(?:\d+|0x[0-9a-fA-F]+)$/;

/** Validates every argument before any RPC call. Throws ConfigError with the flag at fault. */
export function parseCheckArgs(address: string, opts: CheckOptions): CheckArgs {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new ConfigError(`<address> must be a 0x-prefixed 20-byte hex address, got "${address}"`);
  if (badChecksum(address)) throw new ConfigError(`<address> ${address} is mixed-case but not a valid EIP-55 checksum (expected ${getAddress(address)}, or pass it in lowercase)`);
  const standard = standardNameSchema.safeParse(opts.standard);
  if (!standard.success) throw new ConfigError(`unknown --standard "${opts.standard}" (expected ${standardNameSchema.options.join(' or ')})`);
  const runs = Number(opts.runs);
  if (!/^\d+$/.test(opts.runs) || !Number.isSafeInteger(runs) || runs <= 0) throw new ConfigError(`--runs must be a positive integer, got "${opts.runs}"`);
  if (opts.block !== undefined && !/^\d+$/.test(opts.block)) throw new ConfigError(`--block must be a non-negative integer, got "${opts.block}"`);
  if (!/^\d+$/.test(opts.delta) || BigInt(opts.delta) > MAX_UINT256) {
    throw new ConfigError(`--delta must be a non-negative integer below 2^256 (asset base units), got "${opts.delta}"`);
  }
  if (opts.seed !== undefined && (!UINT.test(opts.seed) || BigInt(opts.seed) > MAX_UINT256)) {
    throw new ConfigError(`--seed must be a uint256, decimal or 0x hex, got "${opts.seed}"`);
  }
  return {
    standard: standard.data,
    address: getAddress(address),
    ...(opts.block !== undefined ? { block: BigInt(opts.block) } : {}),
    runs,
    delta: BigInt(opts.delta),
    ...(opts.seed !== undefined ? { seed: BigInt(opts.seed) } : {}),
  };
}

const MARK: Record<StandardPropertyResult['status'], string> = {
  pass: pc.green('✓'),
  fail: pc.red('✗'),
  inconclusive: pc.yellow('?'),
  not_applicable: pc.dim('-'),
};

function short(s: string, max = 110): string {
  const line = s.split('\n')[0] ?? s;
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function describeIdentity(e: Extract<StandardCheckEvent, { type: 'check-identity' }>['identity']): string {
  const proxy = !e.proxy
    ? 'not a proxy'
    : e.proxy.kind === 'unknown'
      ? 'proxy of unknown kind (keyed by its own code)'
      : `${e.proxy.kind} proxy -> ${e.proxy.implementation}`;
  return `${proxy}  key ${e.implementationKey.slice(0, 18)} (${e.implementationKeyKind.of} ${e.implementationKeyKind.hash})`;
}

function logEvent(ctx: CliContext, e: StandardCheckEvent, network: string): void {
  switch (e.type) {
    case 'check-start':
      printLine(ctx, stage('check', `${e.standard} ${pc.bold(e.address)}  ${pc.dim(`${network} ${e.chainId}  block ${e.blockNumber}`)}`));
      printLine(ctx, cont(pc.dim(`runs ${e.runs}  delta ${e.delta}`)));
      return;
    case 'check-identity':
      printLine(ctx, cont(pc.dim(`identity ${describeIdentity(e.identity)}`)));
      return;
    case 'check-workspace':
      printLine(ctx, cont(pc.dim(`harness sha256 ${e.harnessSha256.slice(0, 18)}  ${e.fetched.length ? `fetched ${e.fetched.join(', ')}` : 'cache reused'}  ${e.dir}`)));
      return;
    case 'check-skip':
      printLine(ctx, cont(pc.yellow(`forge skipped: ${e.reason}`)));
      return;
    case 'check-forge':
      printLine(ctx, cont(pc.dim(`${e.forgeVersion ?? 'forge (version unknown)'}  seed ${e.seed}  sender ${e.sender}`)));
      printLine(ctx, cont(pc.dim(`forge ${e.args.join(' ')}  (minutes on a live RPC)`)));
      return;
    case 'check-traits':
      // Context only: a trait never changes a result.
      for (const t of e.traits) {
        const ev = t.evidence;
        const erc165 = ev.erc165 ? `ERC-165 async redeem ${ev.erc165.asyncRedeem}` : 'no ERC-165';
        printLine(ctx, cont(pc.cyan(`trait ${t.id}: exits go through ${ev.requestFunctions.join(', ')} (run ${ev.run}, ${erc165}, code of ${ev.codeAddress})`)));
      }
      return;
  }
}

function resultLines(r: StandardPropertyResult, width: number): string[] {
  const head = `  ${MARK[r.status]} ${r.id.padEnd(width)}  `;
  if (r.status === 'pass') return [`${head}${pc.dim(r.description)}`];
  if (r.status !== 'fail') return [`${head}${pc.dim(`${r.status === 'inconclusive' ? 'inconclusive' : 'not applicable'}: ${short(r.reason ?? '')}`)}`];
  const lines = [`${head}${pc.red(short(r.reason ?? 'failed'))}`, `      ${pc.dim(r.description)}`];
  for (const l of r.counterexample?.logs.slice(0, 5) ?? []) lines.push(`      ${pc.dim(l.trim())}`);
  for (const c of r.counterexample?.calls ?? []) lines.push(`      ${pc.dim(short(c, 160))}`);
  return lines;
}

function summaryText(r: StandardCheckReport): string {
  const s = r.summary;
  const parts = [
    s.pass ? pc.green(`${s.pass} pass`) : `${s.pass} pass`,
    s.fail ? pc.red(`${s.fail} fail`) : `${s.fail} fail`,
    s.inconclusive ? pc.yellow(`${s.inconclusive} inconclusive`) : `${s.inconclusive} inconclusive`,
    `${s.notApplicable} not applicable`,
  ];
  return parts.join(', ');
}

/**
 * `specfirst check <address> --standard erc4626`: runs the pinned a16z ERC-4626 property suite against an
 * already deployed vault on a fork at one block (docs/adr/0003). Read-only, so monad-mainnet is allowed.
 * Writes .specfirst/checks/<chainId>/<address>/<block>.json and, when forge ran, its JSON next to it.
 * Exit 0 only when every property passed; 16 when any failed; 17 when none failed but the check is
 * incomplete (inconclusive or not applicable properties, or none passed); 1 when it could not run.
 */
export function registerCheckCommand(program: Command): void {
  program
    .command('check <address>')
    .description('Run third-party standard properties (a16z/erc4626-tests) against a deployed contract on a fork. Read-only.')
    .requiredOption('--standard <name>', 'property suite: erc4626')
    .option('--network <name>', 'monad-mainnet, monad-testnet or anvil', 'monad-mainnet')
    .option('--rpc <url>', 'RPC URL; also the fork URL (default: $MONAD_MAINNET_RPC, $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--block <n>', 'fork block (default: latest when the check starts, recorded in the report)')
    .option('--runs <n>', 'fuzz runs per property', String(DEFAULT_STANDARD_RUNS))
    .option('--delta <n>', 'tolerated absolute error in asset base units', '0')
    .option('--seed <n>', 'fuzz seed, uint256 decimal or 0x hex (default: random per run, recorded)')
    .action(async (address: string, opts: CheckOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'check', 1, async () => {
        const args = parseCheckArgs(address, opts);
        const net = resolveNetwork({ network: opts.network, rpc: opts.rpc }, process.env, { readOnly: true });
        const chainId = net.clients.chain.id;
        // One RPC for everything: identity, block and the fork must read the same node, so no fallbacks.
        const client = createPublicClient({ chain: net.clients.chain, transport: rpcTransport([net.forkUrl]) }) as unknown as StandardCheckClient;
        const block = args.block ?? (await client.getBlockNumber({ cacheTime: 0 }));
        const reportPath = standardCheckPath(ctx.projectDir, chainId, args.address, block);
        const rawPath = reportPath.replace(/\.json$/, '.forge.json');
        let forgeRan = true;

        const report = await runStandardCheck({
          standard: args.standard,
          address: args.address,
          rpcUrl: net.forkUrl,
          blockNumber: block,
          runs: args.runs,
          delta: args.delta,
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
          client,
          expectedChainId: chainId,
          cacheDir: defaultCacheDir(),
          recordPath: reportPath,
          rawPath,
          onEvent: (e) => {
            if (e.type === 'check-skip') forgeRan = false;
            emitEvent(ctx, e.type === 'check-start' ? { ...e, network: net.name } : e);
            logEvent(ctx, e, net.name);
          },
        });

        const width = Math.max(...report.results.map((r) => r.id.length));
        for (const r of report.results) {
          emitEvent(ctx, { type: 'check-property', ...r });
          for (const l of resultLines(r, width)) printLine(ctx, l);
        }
        const rel = path.relative(ctx.projectDir, reportPath);
        const failed = report.results.filter((r) => r.status === 'fail').map((r) => r.id);
        const exitCode = standardCheckExitCode(report.summary);
        printLine(ctx, cont(`${summaryText(report)}  ${pc.dim(`${(report.durationMs / 1000).toFixed(1)}s  ${rel}`)}`));
        emitEvent(ctx, {
          type: 'check-summary',
          standard: report.standard,
          chainId: report.chainId,
          address: report.address,
          blockNumber: report.blockNumber,
          vaultKind: report.vaultKind,
          skipReason: report.skipReason,
          traits: report.traits,
          summary: report.summary,
          implementationKey: report.identity.implementationKey,
          seed: report.seed,
          sender: report.sender,
          durationMs: report.durationMs,
          reportPath: rel,
          ...(forgeRan ? { rawPath: path.relative(ctx.projectDir, rawPath) } : {}),
          exitCode,
        });
        if (exitCode === STANDARD_CHECK_FAILED_EXIT_CODE) {
          throw new StageError(exitCode, `${failed.join(', ')} failed on ${report.address} at block ${report.blockNumber}`);
        }
        if (exitCode === STANDARD_CHECK_INCOMPLETE_EXIT_CODE) {
          const s = report.summary;
          throw new StageError(
            exitCode,
            `incomplete, not verified: ${s.pass} pass, ${s.inconclusive} inconclusive, ${s.notApplicable} not applicable on ${report.address} at block ${report.blockNumber}`,
          );
        }
      });
    });
}
