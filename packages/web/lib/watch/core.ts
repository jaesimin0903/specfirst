/*
 * The watcher's file schemas (ADR 0006, "Interfaces"): feed.ndjson, status.json and vaults.json, with the names,
 * shapes and strictness the watcher writes them with. They come from @specfirst/core/watch, which imports only viem
 * and zod, so client components can use them too; every other web module imports them from here. The webhook
 * message and its verification belong to @specfirst/core/subs (lib/subs/core.ts).
 */
export * from '@specfirst/core/watch';
