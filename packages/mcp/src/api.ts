import { standardCheckReportSchema, type StandardCheckReport } from '@specfirst/core';
import { z } from 'zod';

/*
 * Read-only client of the Specfirst web's JSON API (packages/web/app/api). GET only; the schemas below hold only the
 * fields this server reads, so the web can add fields without breaking it. Every failure becomes an ApiError with a
 * kind, so a tool can say "the API is down" instead of failing opaquely.
 */

const counts = z.object({ pass: z.number(), fail: z.number(), inconclusive: z.number(), notApplicable: z.number() });
const vaultStatus = z.enum(['mismatch', 'complete', 'partial', 'not_applicable']);
const failureLevel = z.enum(['must', 'rounding', 'should']).nullable();
const block = z.string().regex(/^\d+$/, 'a decimal block number');
const hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a 32-byte hex hash');

/** GET /api/v1/vaults/<chainId>/<address> (packages/web/lib/desk/vaultApi.ts, schema specfirst.vault.v1). */
export const vaultApiSchema = z.object({
  schema: z.literal('specfirst.vault.v1'),
  chainId: z.number(),
  address: z.string(),
  checked: z.boolean(),
  vault: z.object({ name: z.string().nullable(), protocol: z.string().nullable(), assetSymbol: z.string().nullable() }),
  report: z
    .object({
      source: z.string(),
      status: vaultStatus,
      blockNumber: block,
      startedAt: z.string(),
      summary: counts,
      total: z.number(),
      failed: z.array(z.object({ id: z.string(), finding: z.string(), level: z.enum(['must', 'should']) })),
      reportHash: hash32,
      suiteHash: hash32,
      url: z.string(),
    })
    .nullable(),
  attestation: z.object({
    state: z.enum(['attested', 'none', 'unread']),
    id: z.string().regex(/^\d+$/).nullable(),
    isCompliant: z.boolean().nullable(),
    txHash: z.string().nullable(),
  }),
});
export type VaultApi = z.infer<typeof vaultApiSchema>;

/** A check report as the web serves it, held to core's own schema (which also checks the summary against the results). */
export type ReportJson = StandardCheckReport;

const outcome = z.object({ summary: counts, failed: z.array(z.string()), status: vaultStatus, failureLevel: failureLevel.optional() });
const label = z.object({ name: z.string().nullable(), protocol: z.string().nullable(), assetSymbol: z.string().nullable() });

/** One event of GET /api/v1/watch/feed (packages/web/lib/watch/types.ts FeedEventJson). */
export const feedEventSchema = z.object({
  seq: z.number(),
  at: z.string(),
  kind: z.string(),
  chainId: z.number(),
  subject: z.string(),
  vaultPath: z.string(),
  label,
  check: z
    .object({
      block: z.string(),
      summary: counts,
      failed: z.array(z.string()),
      status: vaultStatus,
      reportUrl: z.string().nullable(),
      failureLevel: failureLevel.optional(),
    })
    .nullable(),
  attestation: z.object({ id: z.string(), txHash: z.string() }).nullable(),
  change: z
    .union([
      z.object({ kind: z.literal('price-drop'), fromAssetsPerShare: z.string(), toAssetsPerShare: z.string(), dropBps: z.number(), fromBlock: z.string(), toBlock: z.string() }),
      z.object({ kind: z.string(), from: outcome.nullable(), to: outcome }),
    ])
    .nullable(),
  reason: z.string().nullable(),
});
export type FeedEvent = z.infer<typeof feedEventSchema>;

export const feedPageSchema = z.object({
  chainId: z.number(),
  available: z.boolean(),
  problem: z.string().nullable(),
  events: z.array(feedEventSchema),
  latestSeq: z.number().nullable(),
  hasOlder: z.boolean(),
});
export type FeedPage = z.infer<typeof feedPageSchema>;

/** GET /api/v1/watch/status. */
export const watchStatusSchema = z.object({
  chainId: z.number(),
  running: z.boolean(),
  problem: z.string().nullable(),
  head: z.string().nullable(),
  behindBlocks: z.number().nullable(),
  updatedAt: z.string().nullable(),
  stale: z.boolean(),
  counts: z.object({ known: z.number(), detected24h: z.number(), checked24h: z.number(), attested24h: z.number(), changed24h: z.number() }).loose().nullable(),
});
export type WatchStatus = z.infer<typeof watchStatusSchema>;

/** GET /api/v1/watch/vaults/<chainId>/<address>. */
export const watchVaultSchema = z.object({
  watched: z.boolean(),
  found: z.object({ source: z.string(), block: z.string().nullable(), at: z.string() }).nullable(),
  lastCheck: z.object({ block: z.string(), at: z.string(), status: vaultStatus }).nullable(),
  lastAttestationId: z.string().nullable(),
});
export type WatchVault = z.infer<typeof watchVaultSchema>;

export type ApiErrorKind = 'unreachable' | 'http' | 'bad-response';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind: ApiErrorKind,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * The URL on `base` for a link the API returned: only an http(s) URL or an absolute path is taken, only its path and
 * query are kept, and the result must have the base's origin. null for anything else, so a link in an API answer can
 * never send a read, or a link in a result, to another host.
 */
export function onBase(base: string, link: string): string | null {
  let u: URL;
  try {
    u = new URL(link, 'http://placeholder.invalid');
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  let target: URL;
  try {
    target = new URL(`${base}${u.pathname}${u.search}`);
  } catch {
    return null;
  }
  return target.origin === new URL(base).origin ? target.href : null;
}

export type FetchLike = (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<Response>;

/** Reports are a few to a few dozen KB; anything far larger is not one. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** The body as text, refusing more than MAX_BODY_BYTES before it is all read. */
async function boundedText(res: Response, what: string): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (declared > MAX_BODY_BYTES) throw new ApiError(`Specfirst API answer for ${what} is too large (${declared} bytes)`, 'bad-response', res.status);
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ApiError(`Specfirst API answer for ${what} is too large`, 'bad-response', res.status);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export interface SpecfirstApi {
  readonly base: string;
  /** A 404 is read too: the route answers it with the same shape (checked: false) for a vault it never checked. */
  vault(chainId: number, address: string): Promise<VaultApi>;
  /** A report by the link the API gave, on the API base (onBase), held to core's report schema. */
  report(link: string): Promise<{ json: unknown; parsed: ReportJson }>;
  watchVault(chainId: number, address: string): Promise<WatchVault>;
  feed(chainId: number, o: { before?: number; limit: number }): Promise<FeedPage>;
  watchStatus(chainId: number): Promise<WatchStatus>;
}

type SafeParser<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } } };

export function createApi(o: { base: string; timeoutMs: number; fetch?: FetchLike }): SpecfirstApi {
  const base = o.base.replace(/\/+$/, '');
  const doFetch: FetchLike = o.fetch ?? ((input, init) => fetch(input, init));

  async function getJson(path: string, accept404 = false): Promise<unknown> {
    const target = onBase(base, path);
    if (!target) throw new ApiError(`refused to follow a link that is not on ${base}: ${path.slice(0, 120)}`, 'bad-response');
    const what = new URL(target).pathname;
    let res: Response;
    try {
      res = await doFetch(target, { signal: AbortSignal.timeout(o.timeoutMs), headers: { accept: 'application/json' } });
    } catch (err) {
      throw new ApiError(`Specfirst API at ${base} did not answer (${(err as Error).message})`, 'unreachable');
    }
    if (!res.ok && !(accept404 && res.status === 404)) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError(`Specfirst API answered ${res.status} for ${what}`, 'http', res.status);
    }
    let text: string;
    try {
      text = await boundedText(res, what);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(`Specfirst API at ${base} stopped answering for ${what} (${(err as Error).message})`, 'unreachable');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError(`Specfirst API answered ${res.status} with something that is not JSON for ${what}`, 'bad-response', res.status);
    }
  }

  function parse<T>(schema: SafeParser<T>, value: unknown, what: string): T {
    const r = schema.safeParse(value);
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new ApiError(`Specfirst API answer for ${what} does not have the expected shape${issue ? ` (${issue.path.join('.')}: ${issue.message})` : ''}`, 'bad-response');
    }
    return r.data;
  }

  return {
    base,
    async vault(chainId, address) {
      return parse(vaultApiSchema as SafeParser<VaultApi>, await getJson(`/api/v1/vaults/${chainId}/${address}`, true), 'the vault');
    },
    async report(link) {
      const json = await getJson(link);
      return { json, parsed: parse(standardCheckReportSchema as unknown as SafeParser<ReportJson>, json, 'the report') };
    },
    async watchVault(chainId, address) {
      return parse(watchVaultSchema as SafeParser<WatchVault>, await getJson(`/api/v1/watch/vaults/${chainId}/${address}`, true), 'the watched vault');
    },
    async feed(chainId, f) {
      const q = new URLSearchParams({ chainId: String(chainId), limit: String(f.limit) });
      if (f.before !== undefined) q.set('before', String(f.before));
      return parse(feedPageSchema as SafeParser<FeedPage>, await getJson(`/api/v1/watch/feed?${q}`), 'the watcher feed');
    },
    async watchStatus(chainId) {
      return parse(watchStatusSchema as SafeParser<WatchStatus>, await getJson(`/api/v1/watch/status?chainId=${chainId}`), 'the watcher status');
    },
  };
}
