#!/usr/bin/env node
import { Command } from 'commander';
import { registerCertCommand } from './commands/cert.js';
import { registerCheckCommand } from './commands/check.js';
import { registerDeployCommand } from './commands/deploy.js';
import { registerInitCommand } from './commands/init.js';
import { registerLockCommand } from './commands/lock.js';
import { registerRunCommand } from './commands/run.js';
import { registerStatusCommand } from './commands/status.js';
import { registerVerifyCommand } from './commands/verify.js';

const program = new Command();

program
  .name('specfirst')
  .description('Specfirst: fuzz-verify a Solidity contract against a spec, then certify it on-chain.')
  .version('0.0.1')
  .option('--json', 'emit NDJSON events on stdout instead of human-readable text', false)
  .option('--project <dir>', 'project directory to operate on', process.cwd());

registerInitCommand(program);
registerLockCommand(program);
registerRunCommand(program);
registerDeployCommand(program);
registerVerifyCommand(program);
registerCertCommand(program);
registerStatusCommand(program);
registerCheckCommand(program);

await program.parseAsync(process.argv);
