import { Command } from 'commander';

/**
 * Builds a minimal program carrying the same global options as src/index.ts
 * (--json, --project) around a single command registrar, so tests exercise the
 * real command wiring (contextFrom, optsWithGlobals) instead of calling action
 * callbacks directly.
 */
export function buildProgram(register: (program: Command) => void): Command {
  const program = new Command();
  program
    .exitOverride()
    .option('--json', 'emit NDJSON events on stdout instead of human-readable text', false)
    .option('--project <dir>', 'project directory to operate on', process.cwd());
  register(program);
  return program;
}
