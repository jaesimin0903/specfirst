import { buildRow, metaFor, vaultStatusOf } from '../board/aggregate';
import type { BoardData } from '../board/types';
import { toExplorerRow, type ExplorerRow } from '../board/view';
import { SUBJECT_CHAIN_ID } from '../desk/config';
import type { ContractReader } from '../desk/read';
import { cachedBoard, liveAttestation, runtimeReportPath, vaultMeta, viewOfLive } from '../desk/vault';
import type { FeedEvent } from './core';
import { displayWatchDir, isChainId, watchFile } from './paths';
import { readFeed, readStatus, readVaults, watchedChains } from './read';
import { reportCandidate, reportInfo } from './reports';
import type { FeedEventJson, FeedPageJson, VaultWatchJson, WatchStatusJson } from './types';
import { checksum, countFound, eventJson, foundOf, indexFeed, labelFor, NO_REPORT, pageOf, sourceText, statusJson, type LabelContext } from './view';

/*
 * Server-side assembly of what the watch pages and API routes return. Files are read at request time (the feed
 * incrementally), so a vault the watcher found shows up without a rebuild. Server only.
 */

const boardIdSets = new WeakMap<BoardData, Set<string>>();

function boardIds(board: BoardData): Set<string> {
  let s = boardIdSets.get(board);
  if (!s) {
    s = new Set(board.vaults.map((v) => v.id));
    boardIdSets.set(board, s);
  }
  return s;
}

export function labelContext(events: readonly FeedEvent[]): LabelContext {
  return { meta: vaultMeta(), boardIds: boardIds(cachedBoard()), factories: indexFeed(events).factories };
}

/** The chain asked for when it is a chain id, else 143 when watched (or nothing is), else the first watched chain. */
export async function pickChain(param: string | null | undefined): Promise<{ chainId: number; chains: number[] }> {
  const chains = await watchedChains();
  if (param && isChainId(param)) return { chainId: Number(param), chains };
  if (chains.length === 0 || chains.includes(SUBJECT_CHAIN_ID)) return { chainId: SUBJECT_CHAIN_ID, chains };
  return { chainId: chains[0]!, chains };
}

function statusProblem(s: Awaited<ReturnType<typeof readStatus>>, chains: number[], chainId: number): string | null {
  if (s.available) return null;
  if (!chains.includes(chainId)) return 'not running';
  if (s.problem === 'missing') return 'status.json missing';
  if (s.problem === 'unexpected shape') return `status.json does not match ADR 0006${s.detail ? ` (${s.detail})` : ''}`;
  return `status.json ${s.problem ?? 'unavailable'}`;
}

export async function watchStatusView(chainId: number, chains: number[], now: Date = new Date()): Promise<WatchStatusJson> {
  const [status, feed, vaults] = await Promise.all([readStatus(chainId), readFeed(watchFile.feed(chainId)), readVaults(chainId)]);
  const ctx = labelContext(feed.events);
  const latest = feed.events.length ? feed.events.reduce((m, e) => Math.max(m, e.seq), -1) : null;
  return statusJson({
    chainId,
    chains,
    dir: displayWatchDir(),
    status: status.status,
    problem: statusProblem(status, chains, chainId),
    gasCostWei: status.gasCostWei,
    ctx,
    found: countFound(chainId, vaults.vaults, ctx.meta, ctx.boardIds),
    feed: { available: feed.available, problem: feed.problem, events: feed.events.length, latestSeq: latest, skipped: feed.skipped },
    vaultsFile: { available: vaults.available, problem: vaults.problem, skipped: vaults.skipped },
    now,
  });
}

/** Feed events as the pages show them; `all` is the whole feed, for names and how each subject was found. */
export async function feedEventsJson(events: readonly FeedEvent[], chainId: number, all: readonly FeedEvent[]): Promise<FeedEventJson[]> {
  const vaults = await readVaults(chainId);
  const ctx = labelContext(all);
  const { firstDetected } = indexFeed(all);
  return Promise.all(
    events.map(async (e) => {
      const a = e.subject.toLowerCase();
      const report = e.check ? await reportInfo(e.check, { chainId: e.chainId, address: e.subject }) : NO_REPORT;
      return eventJson(e, ctx, report, foundOf(vaults.vaults[a], firstDetected.get(a)));
    }),
  );
}

export const FEED_PAGE_MAX = 100;

export async function feedPageView(chainId: number, o: { after?: number | null; before?: number | null; limit?: number } = {}): Promise<FeedPageJson> {
  const feed = await readFeed(watchFile.feed(chainId));
  const limit = Math.min(Math.max(o.limit ?? 40, 1), FEED_PAGE_MAX);
  const { page, hasOlder, gap, latestSeq } = pageOf(feed.events, { after: o.after, before: o.before, limit, filter: (e) => e.chainId === chainId });
  return {
    chainId,
    available: feed.available,
    problem: feed.problem,
    events: await feedEventsJson(page, chainId, feed.events),
    latestSeq,
    hasOlder,
    gap,
    skipped: feed.skipped,
    readAt: new Date().toISOString(),
  };
}

/** One vault's watcher record and its feed history, newest first. */
export async function vaultWatchView(chainId: number, address: string, limit = 60): Promise<VaultWatchJson> {
  const a = address.toLowerCase();
  const [feed, vaults] = await Promise.all([readFeed(watchFile.feed(chainId)), readVaults(chainId)]);
  const ctx = labelContext(feed.events);
  const mine = feed.events.filter((e) => e.chainId === chainId && e.subject.toLowerCase() === a);
  const page = [...mine].sort((x, y) => y.seq - x.seq).slice(0, limit);
  const entry = vaults.vaults[a] ?? null;
  const firstDetected = mine.find((e) => e.kind === 'detected');
  return {
    chainId,
    address: a,
    watched: Boolean(entry) || mine.length > 0,
    found: foundOf(entry, firstDetected),
    lastCheck: entry?.lastCheck
      ? { block: entry.lastCheck.block, at: entry.lastCheck.at, summary: { ...entry.lastCheck.summary }, status: vaultStatusOf(entry.lastCheck.summary) }
      : null,
    lastAttestationId: entry?.lastAttestationId ?? null,
    label: labelFor(chainId, a, ctx),
    history: await feedEventsJson(page, chainId, feed.events),
    readAt: new Date().toISOString(),
  };
}

/**
 * Board rows for vaults the watcher knows on the board's chain that the board build does not have, built from
 * each vault's last report like any other row. The attestation column reads the registry (cached 30 s per vault,
 * batched by the client), or says "not read" when it cannot.
 */
export async function overlayRows(reader?: ContractReader | null, chainId: number = SUBJECT_CHAIN_ID): Promise<ExplorerRow[]> {
  const [vaults, feed] = await Promise.all([readVaults(chainId), readFeed(watchFile.feed(chainId))]);
  const ids = boardIds(cachedBoard());
  const meta = vaultMeta();
  const { firstDetected, factories } = indexFeed(feed.events);
  const ctx: LabelContext = { meta, boardIds: ids, factories };
  const at = new Date().toISOString();
  const rows = await Promise.all(
    Object.entries(vaults.vaults).map(async ([address, entry]): Promise<ExplorerRow | null> => {
      if (ids.has(`${chainId}/${address}`) || !entry.lastCheck) return null;
      const { candidate } = await reportCandidate(entry.lastCheck.reportPath);
      if (!candidate || candidate.report.address.toLowerCase() !== address || candidate.report.chainId !== chainId) return null;
      const live =
        reader === null
          ? { kind: 'unread' as const, reason: 'registry not read' }
          : await liveAttestation(chainId, address, reader).catch(() => ({ kind: 'unread' as const, reason: 'registry not read' }));
      const label = labelFor(chainId, address, ctx);
      const row = buildRow({
        candidate,
        meta: metaFor(meta, chainId, address) ?? { name: null, protocol: label.protocol, assetSymbol: null },
        attestation: viewOfLive(live, candidate, at),
        reportPath: runtimeReportPath(candidate.file),
      });
      const first = firstDetected.get(address);
      return {
        ...toExplorerRow(row),
        found: {
          sourceText: sourceText(entry.firstSeen.source, first?.factory) ?? entry.firstSeen.source,
          block: entry.firstSeen.block,
          at: entry.firstSeen.at,
        },
      };
    }),
  );
  return rows.filter((r): r is ExplorerRow => r !== null).map((r) => ({ ...r, address: checksum(r.address) }));
}
