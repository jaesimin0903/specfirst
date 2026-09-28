import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import pc from 'picocolors';
import { PROPERTIES_DIR, SPEC_ERROR_EXIT_CODE, SpecError, parseSpec } from '@specfirst/core';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import { TEMPLATE_FILES, templatesDir } from '../lib/templates.js';

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Parse a spec and scaffold property drafts (Handler, Invariants, Attacker, ...) under test/specfirst/.')
    .requiredOption('--from-spec <file>', 'path to the specfirst spec YAML file')
    .action(async (opts: { fromSpec: string }, command: Command) => {
      const ctx = contextFrom(command);
      const specPath = path.resolve(ctx.projectDir, opts.fromSpec);

      let specText: string;
      try {
        specText = await readFile(specPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          console.error(`specfirst init: spec file not found: ${specPath}`);
          process.exitCode = SPEC_ERROR_EXIT_CODE;
          return;
        }
        throw err;
      }

      try {
        parseSpec(specText);
      } catch (err) {
        if (err instanceof SpecError) {
          console.error(err.message);
          process.exitCode = SPEC_ERROR_EXIT_CODE;
          return;
        }
        throw err;
      }

      const destDir = path.join(ctx.projectDir, PROPERTIES_DIR);
      const regressionsDir = path.join(destDir, 'regressions');
      await mkdir(regressionsDir, { recursive: true });

      const created: string[] = [];
      const skipped: string[] = [];
      const srcDir = templatesDir();

      for (const file of TEMPLATE_FILES) {
        const dest = path.join(destDir, file);
        const relDest = path.relative(ctx.projectDir, dest).split(path.sep).join('/');
        if (existsSync(dest)) {
          skipped.push(relDest);
          emitEvent(ctx, { type: 'init.skip', path: relDest, reason: 'exists' });
          continue;
        }
        await copyFile(path.join(srcDir, file), dest);
        created.push(relDest);
        emitEvent(ctx, { type: 'init.create', path: relDest });
      }

      const gitkeep = path.join(regressionsDir, '.gitkeep');
      const relGitkeep = path.relative(ctx.projectDir, gitkeep).split(path.sep).join('/');
      if (existsSync(gitkeep)) {
        skipped.push(relGitkeep);
        emitEvent(ctx, { type: 'init.skip', path: relGitkeep, reason: 'exists' });
      } else {
        await writeFile(gitkeep, '');
        created.push(relGitkeep);
        emitEvent(ctx, { type: 'init.create', path: relGitkeep });
      }

      emitEvent(ctx, { type: 'init.done', created, skipped });

      if (!ctx.json) {
        if (created.length > 0) {
          printLine(ctx, pc.bold('created:'));
          for (const p of created) printLine(ctx, `  ${p}`);
        } else {
          printLine(ctx, 'created: (nothing, all files already existed)');
        }
        if (skipped.length > 0) {
          printLine(ctx, pc.dim(`skipped (already existed): ${skipped.join(', ')}`));
        }
      }
    });
}
