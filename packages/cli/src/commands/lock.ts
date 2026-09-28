import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { LockError, SPEC_ERROR_EXIT_CODE, SpecError, createLock, parseSpec } from '@specfirst/core';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';

export function registerLockCommand(program: Command): void {
  program
    .command('lock <spec>')
    .description('Compute specHash/invariantSetHash/propertyHash and write .specfirst/lock.json.')
    .action(async (specArg: string, _opts: Record<string, never>, command: Command) => {
      const ctx = contextFrom(command);
      const specPath = path.resolve(ctx.projectDir, specArg);

      let specText: string;
      try {
        specText = await readFile(specPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error(`specfirst lock: spec file not found: ${specPath}`);
          process.exitCode = SPEC_ERROR_EXIT_CODE;
          return;
        }
        throw err;
      }

      let spec;
      try {
        spec = parseSpec(specText);
      } catch (err) {
        if (err instanceof SpecError) {
          console.error(err.message);
          process.exitCode = SPEC_ERROR_EXIT_CODE;
          return;
        }
        throw err;
      }

      try {
        const lock = await createLock({ projectDir: ctx.projectDir, spec, specPath });
        emitEvent(ctx, {
          type: 'lock.done',
          lockPath: path.relative(ctx.projectDir, path.join(ctx.projectDir, '.specfirst', 'lock.json')),
          specHash: lock.specHash,
          invariantSetHash: lock.invariantSetHash,
          propertyHash: lock.propertyHash,
        });

        printLine(ctx, `${pc.bold('specHash:')}         ${lock.specHash}`);
        printLine(ctx, `${pc.bold('invariantSetHash:')}  ${lock.invariantSetHash}`);
        printLine(ctx, `${pc.bold('propertyHash:')}      ${lock.propertyHash}`);
        printLine(ctx, `wrote .specfirst/lock.json (${lock.properties.length} property file(s) locked)`);
        printLine(ctx, pc.dim('mutant check: not implemented yet'));
      } catch (err) {
        if (err instanceof LockError) {
          console.error(`specfirst lock: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });
}
