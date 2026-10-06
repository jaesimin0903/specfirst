import { z } from 'zod';
import { readJsonOrNull, serialized, writeJsonAtomic } from './atomic';
import { watchFile } from './paths';

/*
 * The demo webhook receiver: keeps the last MAX_DEMO_HOOKS JSON bodies POSTed to /api/v1/watch/demo-hook in
 * <watch dir>/demo-hook.json, so a delivery from the watcher can be seen without an outside service. Not where
 * real alerts should go: anyone can post to it. SPECFIRST_DEMO_HOOK=off turns it off. Server only.
 */

export const MAX_DEMO_HOOKS = 50;
export const MAX_DEMO_HOOK_BYTES = 64 * 1024;

export function demoHookEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.SPECFIRST_DEMO_HOOK?.trim().toLowerCase() !== 'off';
}

export interface DemoHookEntry {
  n: number;
  receivedAt: string;
  userAgent: string | null;
  bytes: number;
  body: unknown;
}

const entrySchema = z.object({ n: z.number().int(), receivedAt: z.string(), userAgent: z.string().nullable(), bytes: z.number().int(), body: z.unknown() });

/** The alert payload ADR 0006 has the watcher POST. */
export const alertPayloadSchema = z.object({
  v: z.literal(1),
  subscriptionId: z.string(),
  subject: z.string(),
  chainId: z.number(),
  change: z.unknown(),
  check: z.unknown(),
  attestation: z.unknown(),
  reportURL: z.string().nullable(),
});

export function parseDemoHookFile(raw: unknown): DemoHookEntry[] {
  const r = raw as { v?: unknown; received?: unknown } | null;
  if (!r || r.v !== 1 || !Array.isArray(r.received)) return [];
  return r.received.flatMap((x) => {
    const e = entrySchema.safeParse(x);
    return e.success ? [e.data as DemoHookEntry] : [];
  });
}

/** Newest first. */
export async function readDemoHooks(file: string = watchFile.demoHook()): Promise<DemoHookEntry[]> {
  return parseDemoHookFile(await readJsonOrNull(file)).sort((a, b) => b.n - a.n);
}

export async function storeDemoHook(
  body: unknown,
  meta: { userAgent: string | null; bytes: number; now?: Date },
  file: string = watchFile.demoHook(),
): Promise<DemoHookEntry> {
  return serialized(file, async () => {
    const list = parseDemoHookFile(await readJsonOrNull(file));
    const n = list.reduce((m, e) => Math.max(m, e.n), 0) + 1;
    const entry: DemoHookEntry = {
      n,
      receivedAt: (meta.now ?? new Date()).toISOString(),
      userAgent: meta.userAgent?.slice(0, 200) ?? null,
      bytes: meta.bytes,
      body,
    };
    const kept = [...list, entry].sort((a, b) => a.n - b.n).slice(-MAX_DEMO_HOOKS);
    await writeJsonAtomic(file, { v: 1, received: kept });
    return entry;
  });
}
