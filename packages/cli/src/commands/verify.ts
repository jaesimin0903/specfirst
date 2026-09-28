import type { Command } from 'commander';
import { reportNotImplemented } from '../lib/notImplemented.js';

/** `specfirst verify <address> --run <id>`: rehearsal + fork/probe property comparison. STUB. */
export function registerVerifyCommand(program: Command): void {
  program
    .command('verify <address>')
    .description('Rehearse and compare deployed behaviour against the locked properties. (not implemented)')
    .requiredOption('--run <id>', 'run id whose rehearsal record to use')
    .action(() => {
      reportNotImplemented('verify');
    });
}
