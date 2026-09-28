import type { Command } from 'commander';
import { reportNotImplemented } from '../lib/notImplemented.js';

/** `specfirst deploy <spec> --run <id>`: deploy a passing run's contract. STUB. */
export function registerDeployCommand(program: Command): void {
  program
    .command('deploy <spec>')
    .description('Deploy the target contract produced by a passing run. (not implemented)')
    .requiredOption('--run <id>', 'run id to deploy')
    .action(() => {
      reportNotImplemented('deploy');
    });
}
