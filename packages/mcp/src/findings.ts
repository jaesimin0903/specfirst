import { getAddress } from 'viem';
import { ApiError, onBase, type FeedEvent, type SpecfirstApi, type WatchStatus } from './api.js';
import { shortAddress } from './address.js';
import { propertyLevel } from './levels.js';
import { TESTNET_EXPLORER } from './config.js';
import { clean, MEANING } from './verdict.js';

/*
 * recent_findings: what the watcher found without being asked, read from its feed (GET /api/v1/watch/feed, ADR 0006).
 * Changes of a result and confirmed falls of a share value, newest first, and the vaults whose latest check in the
 * scanned part of the feed is a mismatch.
 */

/** The feed API returns at most 100 events a page; ten pages cover about a day of a busy watcher. */
export const FEED_PAGE = 100;
export const MAX_SCAN_EVENTS = 1000;

type Level = 'must' | 'rounding' | 'should';
type Outcome = { status: string; level: Level | null; failed: string[]; summary: { pass: number; fail: number; inconclusive: number; notApplicable: number } };

export interface FindingVault {
  address: string;
  name: string | null;
  protocol: string | null;
  page: string;
}

export interface Change {
  seq: number;
  at: string;
  /** new (a first check, listed only when it found a mismatch), regressed, recovered, changed, implementation, price-drop. */
  kind: string;
  vault: FindingVault;
  text: string;
  from: Outcome | null;
  to: Outcome | null;
  priceDrop: { fromAssetsPerShare: string; toAssetsPerShare: string; dropBps: number; fromBlock: string; toBlock: string } | null;
  block: string | null;
  attestation: { id: string; txUrl: string | null } | null;
  reportUrl: string | null;
}

export interface CurrentMismatch {
  vault: FindingVault;
  block: string;
  at: string;
  level: Level | null;
  failed: string[];
  /** The check is waiting for its confirming second check (ADR 0006); nothing has followed from it yet. */
  pending: boolean;
  reportUrl: string | null;
}

export interface Findings {
  chainId: number;
  watcher: {
    running: boolean;
    stale: boolean;
    problem: string | null;
    head: string | null;
    behindBlocks: number | null;
    updatedAt: string | null;
    checked24h: number | null;
    changed24h: number | null;
    attested24h: number | null;
  } | null;
  changes: Change[];
  currentMismatches: CurrentMismatch[];
  scanned: { events: number; oldestSeq: number | null; oldestAt: string | null; latestSeq: number | null; reachedStart: boolean };
  links: { feed: string };
  problems: string[];
  meaning: string[];
  readAt: string;
}

const STATUS_WORDS: Readonly<Record<string, string>> = { mismatch: 'mismatch', complete: 'all passed', partial: 'partly checked', not_applicable: 'not applicable' };

function levelOf(o: { failed: string[]; failureLevel?: Level | null | undefined }): Level | null {
  if (o.failureLevel) return o.failureLevel;
  if (o.failed.length === 0) return null;
  // Without the report the ids give the level; a round trip is not shown as rounding then.
  return o.failed.some((id) => propertyLevel(id) === 'must') ? 'must' : 'should';
}

function outcomeOf(o: { status: string; failed: string[]; summary: Outcome['summary']; failureLevel?: Level | null | undefined }): Outcome {
  return { status: o.status, level: levelOf(o), failed: [...o.failed], summary: { ...o.summary } };
}

function describeOutcome(o: Outcome): string {
  const words = STATUS_WORDS[o.status] ?? o.status;
  if (o.status === 'mismatch') return `${words} (${(o.level ?? 'must').toUpperCase()}: ${o.failed.join(', ')})`;
  if (o.status === 'partial') return `${words} (${o.summary.pass} pass, ${o.summary.inconclusive} inconclusive, ${o.summary.notApplicable} not applicable)`;
  return words;
}

function vaultOf(e: FeedEvent, base: string): FindingVault {
  let address: string;
  try {
    address = getAddress(e.subject);
  } catch {
    address = clean(e.subject, 42);
  }
  return { address, name: clean(e.label.name, 80) || null, protocol: clean(e.label.protocol, 80) || null, page: onBase(base, e.vaultPath) ?? `${base}/v/${e.chainId}/${address.toLowerCase()}` };
}

function named(v: FindingVault): string {
  return `${v.name ? `"${v.name}"${v.protocol ? ` (${v.protocol})` : ''} ` : ''}${shortAddress(v.address)}`;
}

/** basis points as a percent with two decimals: 41 -> "0.41%". */
function bpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

/** The attestation an event names, its link rebuilt from the hash rather than taken from the feed. */
function attestationOf(e: FeedEvent): { id: string; txUrl: string | null } | null {
  if (!e.attestation || !/^\d+$/.test(e.attestation.id)) return null;
  return { id: e.attestation.id, txUrl: /^0x[0-9a-fA-F]{64}$/.test(e.attestation.txHash) ? `${TESTNET_EXPLORER}/tx/${e.attestation.txHash}` : null };
}

export function changeOf(e: FeedEvent, base: string): Change | null {
  if (e.kind !== 'changed' || !e.change) return null;
  const vault = vaultOf(e, base);
  const common = {
    seq: e.seq,
    at: e.at,
    vault,
    block: e.check?.block ?? null,
    attestation: attestationOf(e),
    reportUrl: e.check?.reportUrl ? onBase(base, e.check.reportUrl) : null,
  };
  const c = e.change;
  if ('dropBps' in c) {
    return {
      ...common,
      kind: 'price-drop',
      block: c.toBlock,
      text: `${named(vault)}: share value fell ${bpsPercent(c.dropBps)} between block ${c.fromBlock} and block ${c.toBlock} (${c.fromAssetsPerShare} to ${c.toAssetsPerShare} asset base units per share), confirmed at a second block.`,
      from: null,
      to: null,
      priceDrop: { fromAssetsPerShare: c.fromAssetsPerShare, toAssetsPerShare: c.toAssetsPerShare, dropBps: c.dropBps, fromBlock: c.fromBlock, toBlock: c.toBlock },
    };
  }
  const to = outcomeOf(c.to);
  const from = c.from ? outcomeOf(c.from) : null;
  // A first check is a finding only when it found something.
  if (c.kind === 'new' && to.status !== 'mismatch') return null;
  const at = e.check ? ` at block ${e.check.block}` : '';
  const att = e.attestation ? ` Attested as #${e.attestation.id}.` : '';
  const what =
    c.kind === 'new'
      ? `first check found ${describeOutcome(to)}`
      : c.kind === 'implementation'
        ? `implementation changed; the result is now ${describeOutcome(to)}${from ? `, was ${describeOutcome(from)}` : ''}`
        : `${c.kind === 'changed' ? 'result changed' : c.kind} from ${from ? describeOutcome(from) : 'no result'} to ${describeOutcome(to)}`;
  return { ...common, kind: c.kind, text: `${named(vault)}: ${what}${at}.${att}`, from, to, priceDrop: null };
}

export interface FindingsDeps {
  api: SpecfirstApi;
  now?: () => Date;
}

export async function recentFindings(deps: FindingsDeps, chainId: number, limit: number): Promise<Findings> {
  const base = deps.api.base;
  const problems: string[] = [];
  const statusP = deps.api.watchStatus(chainId).catch((err: unknown): WatchStatus | null => {
    problems.push(`Watcher status: ${err instanceof ApiError ? err.message : (err as Error).message}`);
    return null;
  });
  const events: FeedEvent[] = [];
  let latestSeq: number | null = null;
  let reachedStart = false;
  let before: number | undefined;
  try {
    while (events.length < MAX_SCAN_EVENTS) {
      const page = await deps.api.feed(chainId, { limit: FEED_PAGE, ...(before !== undefined ? { before } : {}) });
      if (!page.available) {
        problems.push(`The watcher feed for chain ${chainId} is not available${page.problem ? `: ${page.problem}` : ''}.`);
        reachedStart = true;
        break;
      }
      latestSeq ??= page.latestSeq;
      events.push(...page.events);
      const oldest = page.events.at(-1);
      if (!page.hasOlder || !oldest) {
        reachedStart = true;
        break;
      }
      before = oldest.seq;
    }
  } catch (err) {
    problems.push(`Watcher feed: ${err instanceof ApiError ? err.message : (err as Error).message}`);
  }
  const status = await statusP;

  const changes: Change[] = [];
  const mismatches: CurrentMismatch[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const ch = changeOf(e, base);
    if (ch && changes.length < limit) changes.push(ch);
    if (!e.check) continue;
    // Events come newest first, so the first check seen of a subject is its latest one.
    const key = e.subject.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.check.status !== 'mismatch' || mismatches.length >= limit) continue;
    mismatches.push({
      vault: vaultOf(e, base),
      block: e.check.block,
      at: e.at,
      level: levelOf(e.check),
      failed: [...e.check.failed],
      pending: (e.reason ?? '').startsWith('pending confirmation'),
      reportUrl: e.check.reportUrl ? onBase(base, e.check.reportUrl) : null,
    });
  }
  const oldest = events.at(-1);
  return {
    chainId,
    watcher: status
      ? {
          running: status.running,
          stale: status.stale,
          problem: status.problem,
          head: status.head,
          behindBlocks: status.behindBlocks,
          updatedAt: status.updatedAt,
          checked24h: status.counts?.checked24h ?? null,
          changed24h: status.counts?.changed24h ?? null,
          attested24h: status.counts?.attested24h ?? null,
        }
      : null,
    changes,
    currentMismatches: mismatches,
    scanned: { events: events.length, oldestSeq: oldest?.seq ?? null, oldestAt: oldest?.at ?? null, latestSeq, reachedStart },
    links: { feed: `${base}/watch` },
    problems,
    meaning: [...MEANING],
    readAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}
