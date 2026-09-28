import { ConfigError } from './network.js';
import { StageError } from './pipeline.js';
import { emitEvent, type CliContext } from './context.js';

/**
 * Runs one command body and maps failures to exit codes: StageError carries its own (12, 13, 14),
 * ConfigError (missing key, registry, bad network) uses `configExit`, anything else exits 1.
 */
export async function runStage(ctx: CliContext, name: string, configExit: number, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    const code = err instanceof StageError ? err.exitCode : err instanceof ConfigError ? configExit : 1;
    const message = `specfirst ${name}: ${(err as Error).message}`;
    console.error(message);
    emitEvent(ctx, { type: `${name.replace(/ /g, '-')}-error`, exitCode: code, message });
    process.exitCode = code;
  }
}
