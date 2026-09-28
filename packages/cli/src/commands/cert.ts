import type { Command } from 'commander';
import { reportNotImplemented } from '../lib/notImplemented.js';

/** `specfirst cert issue --run <id>` and `specfirst cert revoke <address> --evidence <file>`. STUB. */
export function registerCertCommand(program: Command): void {
  const cert = program.command('cert').description('Issue or revoke on-chain certificates.');

  cert
    .command('issue')
    .description('Issue a certificate from a run\'s report. (not implemented)')
    .requiredOption('--run <id>', 'run id whose report to submit')
    .action(() => {
      reportNotImplemented('cert issue');
    });

  cert
    .command('revoke <address>')
    .description('Revoke a certificate with evidence of a violation. (not implemented)')
    .requiredOption('--evidence <file>', 'path to the verify.json showing the violation')
    .action(() => {
      reportNotImplemented('cert revoke');
    });
}
