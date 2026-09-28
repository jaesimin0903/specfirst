import path from 'node:path';
import type { Command } from 'commander';

/** Resolved global options every command reads: which project tree to act on, and how to report progress. */
export interface CliContext {
  /** Absolute path to the project directory (--project, default cwd). */
  projectDir: string;
  /** True when --json was passed: commands emit NDJSON events on stdout instead of human-readable text. */
  json: boolean;
}

/** Reads --project/--json from the root program plus any local options already merged onto `command`. */
export function contextFrom(command: Command): CliContext {
  const opts = command.optsWithGlobals() as { project?: string; json?: boolean };
  return {
    projectDir: path.resolve(opts.project ?? process.cwd()),
    json: Boolean(opts.json),
  };
}

/** JSON.stringify replacer that renders bigint (e.g. certId, issuedAt) as decimal strings. */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

/** Writes one NDJSON event line when --json is set; no-op otherwise. */
export function emitEvent(ctx: CliContext, event: Record<string, unknown>): void {
  if (ctx.json) {
    process.stdout.write(`${JSON.stringify(event, jsonReplacer)}\n`);
  }
}

/** Writes one human-readable line when --json is not set; no-op otherwise. */
export function printLine(ctx: CliContext, line = ''): void {
  if (!ctx.json) {
    console.log(line);
  }
}
