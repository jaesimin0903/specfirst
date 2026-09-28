import path from 'node:path';
import { DEPLOY_FAILED_EXIT_CODE, DEPLOY_JSON } from '@specfirst/core';
import type { Command } from 'commander';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import { DEPLOYER_KEY_ENV, resolveKey, resolveNetwork, type NetworkOptions } from '../lib/network.js';
import { deployStage, loadRun } from '../lib/pipeline.js';
import { runStage } from '../lib/stageRunner.js';

interface DeployOptions extends NetworkOptions {
  run: string;
  force?: boolean;
}

/** `specfirst deploy <spec> --run <id>`: builds the run's final commit and deploys it (plan 3.6 item 1). Exit 0 or 12. */
export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <spec>')
    .description('Deploy the contract of a passing run (gas = estimate x 1.2, below 16,777,216) and write deploy.json.')
    .requiredOption('--run <id>', 'run id to deploy')
    .option('--network <name>', 'anvil or monad-testnet', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--force', 'deploy even if the run did not pass (uncertified demo vault)')
    .action(async (_spec: string, opts: DeployOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'deploy', DEPLOY_FAILED_EXIT_CODE, async () => {
        const run = await loadRun(ctx.projectDir, opts.run);
        const net = resolveNetwork(opts);
        const deployerKey = resolveKey(net, DEPLOYER_KEY_ENV);
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const record = await deployStage({ projectDir: ctx.projectDir, run, net, deployerKey, force: opts.force, log: (l) => printLine(ctx, l) });
        emitEvent(ctx, { type: 'deployed', runId: run.runId, ...record, deployJson: path.relative(ctx.projectDir, path.join(run.runDir, DEPLOY_JSON)) });
      });
    });
}
