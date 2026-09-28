import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_FORK_RUNS,
  DEPLOY_JSON,
  readJson,
  REHEARSAL_JSON,
  VERIFY_FAILED_EXIT_CODE,
  type DeployRecord,
  type RehearsalRecord,
} from '@specfirst/core';
import type { Command } from 'commander';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import { ConfigError, DEPLOYER_KEY_ENV, resolveKey, resolveNetwork, type NetworkOptions } from '../lib/network.js';
import { loadRun, rehearseStage, StageError, verifyStage } from '../lib/pipeline.js';
import { runStage } from '../lib/stageRunner.js';

interface VerifyOptions extends NetworkOptions {
  run: string;
  rehearse: boolean;
  runs: string;
  seed?: string;
  forceProbe?: boolean;
}

/**
 * `specfirst verify <address> --run <id>`: rehearsal (unless rehearsal.json exists or --no-rehearse),
 * then the fork comparison with the Probe fallback (plan 3.6). Exit 0, or 13 when an invariant is violated.
 */
export function registerVerifyCommand(program: Command): void {
  program
    .command('verify <address>')
    .description('Rehearse, then run the locked properties on a fork of the deployed contract. Writes verify.json.')
    .requiredOption('--run <id>', 'run id whose deploy.json and rehearsal.json to use')
    .option('--network <name>', 'anvil or monad-testnet', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL; also the fork URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--no-rehearse', 'do not send rehearsal txs even when rehearsal.json is missing')
    .option('--runs <n>', 'invariant runs on the fork', String(DEFAULT_FORK_RUNS))
    .option('--seed <seed>', 'fuzz seed for the fork campaign')
    .option('--force-probe', 'skip the fork and judge INV-1, 2, 6 with SpecfirstProbe')
    .action(async (address: string, opts: VerifyOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'verify', VERIFY_FAILED_EXIT_CODE, async () => {
        const run = await loadRun(ctx.projectDir, opts.run);
        const deployPath = path.join(run.runDir, DEPLOY_JSON);
        if (!existsSync(deployPath)) throw new ConfigError(`run ${run.runId} has no deploy.json; run \`specfirst deploy\` first`);
        const deploy = await readJson<DeployRecord>(deployPath);
        if (deploy.address.toLowerCase() !== address.toLowerCase()) {
          throw new ConfigError(`run ${run.runId} deployed ${deploy.address}, not ${address}`);
        }
        const runs = Number(opts.runs);
        if (!Number.isInteger(runs) || runs <= 0) throw new ConfigError(`--runs must be a positive integer, got "${opts.runs}"`);
        const net = resolveNetwork(opts);
        if (net.clients.chain.id !== deploy.chainId) throw new ConfigError(`deploy.json is on chain ${deploy.chainId}, --network ${net.name} is ${net.clients.chain.id}`);
        const log = (l: string) => printLine(ctx, l);

        const rehearsalPath = path.join(run.runDir, REHEARSAL_JSON);
        let rehearsal: RehearsalRecord | null = null;
        if (existsSync(rehearsalPath)) {
          rehearsal = await readJson<RehearsalRecord>(rehearsalPath);
          log(`rehearse ${rehearsal.txs.length} tx from ${path.relative(ctx.projectDir, rehearsalPath)}`);
        } else if (opts.rehearse) {
          const deployerKey = resolveKey(net, DEPLOYER_KEY_ENV);
          for (const n of net.notices) log(`         ! ${n}`);
          try {
            rehearsal = await rehearseStage({ run, net, deployerKey, deploy, log });
          } catch (err) {
            throw new StageError(VERIFY_FAILED_EXIT_CODE, `rehearsal failed: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        const v = await verifyStage({ projectDir: ctx.projectDir, run, net, deploy, rehearsal, runs, seed: opts.seed, forceProbe: opts.forceProbe, log });
        emitEvent(ctx, { type: 'verified', runId: run.runId, target: v.target, path: v.path, passed: v.passed, violated: v.violated, unjudged: v.unjudged, ok: v.ok });
      });
    });
}
