import type { Command } from 'commander';
import { reportNotImplemented } from '../lib/notImplemented.js';

/**
 * `specfirst run <spec>`: lock check, fix loop, deploy, rehearsal, verify, cert issue.
 * Options mirror plan.md 3.10; STUB in this scope (core's src/loop and src/agent are
 * still being built by another agent). Always exits 1: "not implemented: run".
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run <spec>')
    .description('Run the full lock-check -> fix loop -> deploy -> rehearsal -> verify -> cert issue pipeline. (not implemented)')
    .option('--no-deploy', 'skip deployment, stop after a passing fix loop')
    .option('--no-agent', 'skip the fix loop; forge judge only')
    .option('--allow-partial', 'issue a partial certificate when not all invariants pass')
    .option('--aux <backend>', 'auxiliary fuzz backend to also run (e.g. ultrafuzz)')
    .option('--runs <n>', 'fuzz runs per invariant')
    .option('--depth <n>', 'fuzz call sequence depth')
    .option('--timeout <s>', 'fuzz campaign timeout in seconds')
    .action(() => {
      reportNotImplemented('run');
    });
}
