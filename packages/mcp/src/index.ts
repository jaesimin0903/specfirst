#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError } from './config.js';
import { serverFactoryFromEnv } from './server.js';

// stdout is the JSON-RPC channel: everything this process says for people goes to stderr.
let factory: ReturnType<typeof serverFactoryFromEnv>;
try {
  factory = serverFactoryFromEnv();
} catch (err) {
  console.error(`specfirst-mcp: ${err instanceof ConfigError ? err.message : (err as Error).stack}`);
  process.exit(1);
}

// A stray rejection is logged, never left to end the session.
process.on('unhandledRejection', (err) => console.error(`specfirst-mcp: unhandled ${(err as Error)?.stack ?? String(err)}`));

const handle = serveStdio(factory, { onerror: (err) => console.error(`specfirst-mcp: ${err.message}`) });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void handle.close().finally(() => process.exit(0)));
console.error('specfirst-mcp: serving on stdio (read only, no keys)');
