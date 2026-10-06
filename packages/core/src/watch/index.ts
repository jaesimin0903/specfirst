// Browser-safe part of the watcher (docs/adr/0006): the zod schemas of feed.ndjson, status.json and
// vaults.json, the subscription and alert hooks, and the signal sources as data. Only viem and zod are
// imported here and in the modules below, so the web can use `@specfirst/core/watch` without Node-only
// modules. The loop itself (watcher.ts, store.ts) is exported from the package root.
export * from './schema.js';
export * from './hooks.js';
export * from './sources.js';
