import { checkReportHash, ERC4626_UPSTREAM, propertiesHash, STANDARD_PROPERTY_TABLES, suiteHash, suiteOf } from '@specfirst/core';
import type { Address } from 'viem';
import { ApiError, onBase, type ReportJson, type SpecfirstApi, type VaultApi, type WatchVault } from './api.js';
import type { ChainAttestation, ChainReader, LatestRead } from './chain.js';
import { ATTEST_CHAIN_ID, originOf, TESTNET_EXPLORER } from './config.js';
import { classifyFailure, eipSentence, idsOfBitmap, PROPERTY_IDS, propertyLevel, valuePairs, vaultLevelOf, type FailureClass, type FailureTopic, type PropertyLevel, type VaultLevel } from './levels.js';

/*
 * One vault's verdict, put together from the web API (the latest report and its file) and from the registry read on
 * chain by this server. Building it is pure (buildVerdict); gatherVerdict does the reads. Once the report file hashes
 * to the reportHash the API names and is about this vault and block, the file is what the verdict rests on, not the
 * API's summary of it.
 */

export type Action = 'deposit' | 'mint' | 'withdraw' | 'redeem';
export const ACTIONS: readonly Action[] = ['deposit', 'mint', 'withdraw', 'redeem'];

export type VerdictStatus = 'all-passed' | 'mismatch' | 'partly-checked' | 'not-applicable' | 'unchecked' | 'unknown';

export interface ConcreteCall {
  /** max-honored: a call at or below the vault's own max that reverted. fuzz-counterexample: forge's failing input. */
  kind: 'max-honored' | 'fuzz-counterexample';
  /** One line an agent can quote. */
  text: string;
  function?: Action;
  argument?: string;
  maxFunction?: string;
  maxValue?: string;
  revertSelector?: string | null;
  revertError?: string | null;
  test?: string;
  calls?: string[];
}

export interface FailedProperty {
  id: string;
  level: PropertyLevel;
  topic: FailureTopic;
  /** The EIP-4626 sentence the property checks. */
  eip: string | null;
  /** What the check found, in plain words, and for a SHOULD the rule it goes against. Revert text in it is the vault's. */
  explanation: string;
  call: ConcreteCall | null;
  /** The actions this failure concerns directly (concernsOf); decide.ts adds the exits for deposit and mint. */
  concerns: Action[];
}

export interface AttestationView {
  read: 'ok' | 'none' | 'unread';
  /** Why the registry could not be read. */
  reason: string | null;
  registry: { chainId: number; address: string };
  /** Origin of the RPC that was read. */
  rpc: string;
  id: string | null;
  status: string | null;
  isCompliant: boolean | null;
  issuedAt: string | null;
  ageHours: number | null;
  blockNumber: string | null;
  issuer: string | null;
  /** The issuer is still an issuer of the registry (removing one leaves its attestations Valid, ADR 0004); null when not read. */
  issuerCurrent: boolean | null;
  reportHash: string | null;
  /** The reportURI string as the registry stores it. */
  reportURI: string | null;
  /** Where to open that report: reportURI with the legacy jaesimin/specfirst prefix mapped to jaesimin0903/specfirst (reportLinkOf). This server does not fetch it. */
  reportLink: string | null;
  counts: { pass: number; fail: number; inconclusive: number; notApplicable: number } | null;
  /** Ids whose bits are set in the attestation's failedBitmap; a bit past the 30-property table is "bit <i>". */
  failedProperties: string[];
  /** must when a MUST property is among them; should when only SHOULDs; none when nothing failed. */
  failedLevel: 'must' | 'should' | 'none' | null;
  /** The attested reportHash equals the reportHash of the latest report. */
  matchesReport: boolean | null;
  /** The attested implementationKey equals the latest report's; false after an upgrade the attestation did not see. */
  sameImplementationAsReport: boolean | null;
  /** How the attested block relates to the latest report's block. */
  relativeToReport: 'same-block' | 'earlier-block' | 'later-block' | null;
  txUrl: string | null;
  /** The web's own registry read names the same attestation id. */
  serverAgrees: boolean | null;
}

export interface ReportView {
  url: string | null;
  reportHash: string;
  /** The file hashes to the reportHash the API names (keccak256 of its canonical JSON, computed here) and is about this chain, vault and block. */
  verified: boolean | null;
  /** The API's summary, status and failed ids agree with the verified file; null without a verified file. */
  matchesApiSummary: boolean | null;
  /** The file's results are exactly the 30 properties of a published property table (ids, tests and descriptions), in order. */
  coversAllProperties: boolean | null;
  /**
   * The check ran at full strength: the pinned a16z/erc4626-tests commit, at least 16 fuzz runs a property and a delta
   * of 0, and its suite hash (core suiteOf) is the one the API names. A check with fewer runs or a tolerance passes more.
   */
  fullStrength: boolean | null;
  /** The `specfirst check` command that replays the verified file; null without one. */
  reproduce: string | null;
}

export interface Verdict {
  vault: { address: Address; chainId: number; name: string | null; protocol: string | null; assetSymbol: string | null };
  status: VerdictStatus;
  level: VaultLevel | null;
  /** Where status and level come from: the latest report, the attestation alone (API down), or nothing. */
  basis: 'report' | 'attestation' | 'none';
  summary: { pass: number; fail: number; inconclusive: number; notApplicable: number; total: number } | null;
  blockChecked: string | null;
  checkedAt: string | null;
  failed: FailedProperty[];
  notJudged: { id: string; status: 'inconclusive' | 'not_applicable'; reason: string }[];
  traits: { id: string; label: string; basis: string }[];
  report: ReportView | null;
  attestation: AttestationView;
  freshness: { reportAgeHours: number | null; staleAfterHours: number; stale: boolean | null; attestationAgeHours: number | null };
  watcher: { knows: boolean; foundBy: string | null; foundAt: string | null; lastCheckBlock: string | null; lastCheckAt: string | null } | null;
  links: { page: string; requestCheck: string; inbox: string };
  /** What could not be read or did not agree, in plain words. */
  problems: string[];
  meaning: string[];
  readAt: string;
}

export const MEANING: readonly string[] = [
  'A pass means no counterexample to these 30 properties was found at that block (16 fuzz runs each). It is not a safety guarantee or an audit.',
  'A mismatch is a disagreement with a sentence of EIP-4626, shown by a concrete call on a fork of that block. It is not a claim that funds are at risk or were lost.',
  "Names, symbols and revert texts are quoted from the vault and its deployer; only the server's own fields (status, level, decision, reason codes) are its judgment.",
];

const COMMON = ['asset', 'totalAssets', 'convertToShares', 'convertToAssets'];
export const SIDE: Readonly<Record<Action, readonly string[]>> = {
  deposit: ['maxDeposit', 'previewDeposit', 'deposit', 'sf-maxDeposit-honored'],
  mint: ['maxMint', 'previewMint', 'mint', 'sf-maxMint-honored'],
  withdraw: ['maxWithdraw', 'previewWithdraw', 'withdraw', 'withdraw-zero-allowance', 'sf-maxWithdraw-honored'],
  redeem: ['maxRedeem', 'previewRedeem', 'redeem', 'redeem-zero-allowance', 'sf-maxRedeem-honored'],
};

/**
 * The actions a property concerns directly: the accounting views every action, each entry point itself, and an id
 * outside the table every action. That money put in must come out through withdraw or redeem is decide.ts's rule.
 */
export function concernsOf(id: string): Action[] {
  if (COMMON.includes(id)) return [...ACTIONS];
  const own = ACTIONS.filter((a) => SIDE[a].includes(id));
  return own.length === 0 ? [...ACTIONS] : own;
}

/** Text that came from a vault, a deployer or the API, made safe to put in a line an LLM reads: one line, bounded. */
export function clean(s: string | null | undefined, max = 300): string {
  // Control and line separator characters become spaces; zero-width and bidi controls are dropped.
  const one = (s ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max)}...` : one;
}

/** The reportURI prefix of attestations recorded before 2026-10-08: a GitHub account that is not ours. */
const LEGACY_REPORT_PREFIX = 'https://raw.githubusercontent.com/jaesimin/specfirst/';
/** Where the same files are published: the public Specfirst repository. */
const REPORT_PREFIX = 'https://raw.githubusercontent.com/jaesimin0903/specfirst/';

/**
 * The link to give for an attested reportURI, as packages/web/lib/report.ts reportLinkOf does: only the exact legacy
 * prefix is rewritten, every other string comes back unchanged. The on-chain reportHash still binds the file.
 */
export function reportLinkOf(reportURI: string): string {
  return reportURI.startsWith(LEGACY_REPORT_PREFIX) ? REPORT_PREFIX + reportURI.slice(LEGACY_REPORT_PREFIX.length) : reportURI;
}

/** A quoted form of text from a vault or a deployer: JSON quoting, so an inner quote cannot close it. */
export function quote(s: string): string {
  return JSON.stringify(s);
}

function cleanOrNull(s: string | null | undefined, max = 80): string | null {
  const c = clean(s, max);
  return c ? c : null;
}

/** Custom errors seen in the Monad batch, by 4-byte selector (packages/web/lib/board/reasons.ts; test/verdict.test.ts recomputes them). */
export const KNOWN_ERROR_SELECTORS: Readonly<Record<string, string>> = {
  '0x75ed2e3e': 'WithdrawalRequestRequired()',
  '0xe14e66da': 'WithdrawalsArePaused()',
  '0x82b42900': 'Unauthorized()',
  '0xea8e4eb5': 'NotAuthorized()',
  '0x9773bb71': 'E_TransferFromFailed(bytes,bytes)',
};

/** SpecfirstMaxHonored.t.sol failure text (the pattern of packages/web/lib/board/reasons.ts). */
const MAX_HONORED_FAIL =
  /^(deposit|mint|withdraw|redeem)\((\d+)\) reverted with (selector (0x[0-9a-fA-F]{8})|no revert data|short revert data) while (max(?:Deposit|Mint|Withdraw|Redeem)) is (\d+)(?:; [\s\S]*)?$/;

export function groupDigits(n: string): string {
  return n.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function maxHonoredCall(reason: string | undefined): ConcreteCall | null {
  const m = MAX_HONORED_FAIL.exec(reason ?? '');
  if (!m) return null;
  const selector = m[4] ? m[4].toLowerCase() : null;
  const error = selector ? (KNOWN_ERROR_SELECTORS[selector] ?? null) : null;
  const how = selector ? `${selector}${error ? `, ${error}` : ''}` : m[3]!;
  return {
    kind: 'max-honored',
    text: `${m[5]} returned ${groupDigits(m[6]!)}, then ${m[1]}(${groupDigits(m[2]!)}) reverted with ${how}.`,
    function: m[1] as Action,
    argument: m[2]!,
    maxFunction: m[5]!,
    maxValue: m[6]!,
    revertSelector: selector,
    revertError: error,
  };
}

function percentOf(delta: string, amount: string): string {
  const a = BigInt(amount);
  if (a === 0n) return 'all';
  const hundredths = (BigInt(delta) * 10_000n) / a;
  if (hundredths === 0n) return 'less than 0.01%';
  const frac = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${hundredths / 100n}${frac ? `.${frac}` : ''}%`;
}

/** The rule a failure goes against beyond what the finding says, by its class. */
function ruleOf(id: string, c: FailureClass, asyncRedeem: boolean): string | null {
  switch (c.topic) {
    case 'rounding':
      return 'EIP-4626, Security Considerations: rounding should favor the vault over its users. That is a SHOULD, not a MUST, and the difference is rounding sized.';
    case 'round-trip':
      return c.delta && c.amount
        ? `EIP-4626's rounding guidance is a SHOULD, but a difference of ${groupDigits(c.delta)} base units, ${percentOf(c.delta, c.amount)} of the amount, is more than rounding.`
        : "EIP-4626's rounding guidance is a SHOULD; the report does not give the size of the difference.";
    case 'allowance':
      return "EIP-4626: withdraw and redeem SHOULD check that the caller may spend the owner's shares.";
    default:
      if (asyncRedeem && (id === 'sf-maxWithdraw-honored' || id === 'sf-maxRedeem-honored')) {
        return 'The vault takes exits through a request (asynchronous redemption); ERC-7540 still requires maxWithdraw and maxRedeem to report what can be taken out now.';
      }
      if (id === 'withdraw' || id === 'redeem') return 'A withdraw or redeem failure counts as a MUST whatever its reason says, since the reason text can come from the vault.';
      return null;
  }
}

/** What a failed property found, from the report itself (the board's wording, packages/web/lib/board/reasons.ts). */
function findingOf(r: ReportJson['results'][number]): string {
  const call = maxHonoredCall(r.reason);
  if (call) return call.text;
  if (r.id.startsWith('RT-') && propertyLevel(r.id) === 'should') {
    let best: { a: bigint; b: bigint; delta: bigint } | null = null;
    for (const p of valuePairs(r.counterexample?.logs)) if (!best || p.delta > best.delta) best = p;
    if (best) {
      return `Forge found a counterexample: the round trip ended ${groupDigits(best.delta.toString())} base ${best.delta === 1n ? 'unit' : 'units'} in the caller's favor (${groupDigits(best.a.toString())} against ${groupDigits(best.b.toString())}).`;
    }
  }
  return r.reason ? `Forge found a counterexample: ${clean(r.reason)}` : 'Forge found a counterexample.';
}

/** Unix seconds as an ISO time; null for a value no Date can hold (a registry answer this code cannot use). */
function isoOfSeconds(seconds: bigint): string | null {
  return seconds >= 0n && seconds <= 8_640_000_000_000n ? new Date(Number(seconds) * 1000).toISOString() : null;
}

/** Hours since an ISO time; null when unknown or more than five minutes in the future. */
function hoursSince(from: string | null, now: Date): number | null {
  if (from === null) return null;
  const t = Date.parse(from);
  if (!Number.isFinite(t) || t - now.getTime() > 5 * 60_000) return null;
  return Math.max(0, Math.round(((now.getTime() - t) / 3_600_000) * 10) / 10);
}

/** The board's label of the one trait there is, async-redeem (packages/web/lib/board/reasons.ts traitLabel, traitBasis). */
function traitView(t: NonNullable<ReportJson['traits']>[number]): { id: string; label: string; basis: string } {
  const e = t.evidence;
  const parts = [
    `${e.requestFunctions.join(' and ')} in the code at ${e.codeAddress}`,
    e.erc165 ? (e.erc165.asyncRedeem ? 'ERC-165 declares ERC-7540 asynchronous redemption' : 'ERC-165 does not declare ERC-7540 asynchronous redemption') : null,
    e.run === 'exits-rejected' ? 'in this check deposits worked while every withdraw and redeem reverted' : 'the exits could not be run on the fork, so the label comes from the code and ERC-165 only',
  ].filter(Boolean);
  return { id: t.id, label: `Asynchronous withdrawals: exits go through ${e.requestFunctions[0]!.split('(')[0]}`, basis: `${parts.join('; ')}.` };
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

function attestationView(o: {
  chain: LatestRead;
  registry: string;
  rpc: string;
  now: Date;
  reportHash: string | null;
  reportBlock: string | null;
  implementationKey: string | null;
  server: VaultApi['attestation'] | null;
}): AttestationView {
  const v: AttestationView = {
    read: 'unread',
    reason: null,
    registry: { chainId: ATTEST_CHAIN_ID, address: o.registry },
    rpc: o.rpc,
    id: null,
    status: null,
    isCompliant: null,
    issuedAt: null,
    ageHours: null,
    blockNumber: null,
    issuer: null,
    issuerCurrent: null,
    reportHash: null,
    reportURI: null,
    reportLink: null,
    counts: null,
    failedProperties: [],
    failedLevel: null,
    matchesReport: null,
    sameImplementationAsReport: null,
    relativeToReport: null,
    txUrl: null,
    serverAgrees: null,
  };
  if (o.chain.read === 'unread') return { ...v, reason: clean(o.chain.reason) };
  if (o.chain.read === 'none') return { ...v, read: 'none', isCompliant: false, serverAgrees: o.server && o.server.state !== 'unread' ? o.server.state === 'none' : null };
  const a: ChainAttestation = o.chain.attestation;
  const failed = idsOfBitmap(a.failedBitmap);
  const issuedAt = isoOfSeconds(a.issuedAt);
  const id = a.id.toString();
  const rel = o.reportBlock === null ? null : BigInt(o.reportBlock) === a.blockNumber ? 'same-block' : a.blockNumber < BigInt(o.reportBlock) ? 'earlier-block' : 'later-block';
  const reportURI = a.reportURI ? clean(a.reportURI, 512) : null;
  return {
    ...v,
    read: 'ok',
    id,
    status: a.status,
    isCompliant: o.chain.isCompliant,
    issuedAt,
    ageHours: hoursSince(issuedAt, o.now),
    blockNumber: a.blockNumber.toString(),
    issuer: a.issuer,
    issuerCurrent: o.chain.issuerCurrent,
    reportHash: a.reportHash,
    reportURI,
    reportLink: reportURI ? reportLinkOf(reportURI) : null,
    counts: { pass: a.passCount, fail: a.failCount, inconclusive: a.inconclusiveCount, notApplicable: a.notApplicableCount },
    failedProperties: failed,
    failedLevel: failed.length === 0 ? 'none' : failed.some((f) => propertyLevel(f) === 'must') ? 'must' : 'should',
    matchesReport: o.reportHash ? o.reportHash.toLowerCase() === a.reportHash.toLowerCase() : null,
    sameImplementationAsReport: o.implementationKey ? o.implementationKey.toLowerCase() === a.implementationKey.toLowerCase() : null,
    relativeToReport: rel,
    txUrl: o.server?.id === id && o.server.txHash && TX_HASH.test(o.server.txHash) ? `${TESTNET_EXPLORER}/tx/${o.server.txHash}` : null,
    serverAgrees: o.server && o.server.state !== 'unread' ? o.server.id === id : null,
  };
}

export type ReportRead = { ok: true; json: unknown; parsed: ReportJson } | { ok: false; reason: string };
export type ApiRead = { ok: true; vault: VaultApi } | { ok: false; reason: string };

export interface VerdictInput {
  address: Address;
  chainId: number;
  api: ApiRead;
  /** null when there was no report to fetch. */
  report: ReportRead | null;
  chain: LatestRead;
  watch: WatchVault | null;
  apiBase: string;
  registry: string;
  rpcUrl: string;
  staleHours: number;
  now: Date;
}

/** keccak256 of the report's canonical JSON, the way the registry's reportHash is made (ADR 0004). */
export function reportHashOf(json: unknown): string | null {
  try {
    return checkReportHash(json as never).toLowerCase();
  } catch {
    return null;
  }
}

const NETWORK_FLAG: Readonly<Record<number, string>> = { 10143: ' --network monad-testnet', 31337: ' --network anvil' };

/** The command that replays a report (packages/web/lib/board/reproduce.ts), built from the verified file. */
function reproduceOf(r: ReportJson): string {
  return `specfirst check ${r.address} --standard ${r.standard} --block ${r.blockNumber} --runs ${r.runs}${r.seed ? ` --seed ${r.seed}` : ''}${r.delta !== '0' ? ` --delta ${r.delta}` : ''}${NETWORK_FLAG[r.chainId] ?? ''}`;
}

function statusOf(s: { pass: number; fail: number; inconclusive: number; notApplicable: number }): VerdictStatus {
  // packages/web/lib/board/aggregate.ts vaultStatusOf
  if (s.fail > 0) return 'mismatch';
  const total = s.pass + s.inconclusive + s.notApplicable;
  if (total > 0 && s.pass === total) return 'all-passed';
  if (s.pass === 0 && s.inconclusive === 0) return 'not-applicable';
  return 'partly-checked';
}

/** What a check must have run with for this server to vouch for a pass: the 16 runs a property the watcher and the desk use. */
export const MIN_RUNS = 16;
const TABLE_HASHES: readonly string[] = (STANDARD_PROPERTY_TABLES.erc4626 ?? []).map((t) => propertiesHash(t).toLowerCase());

const API_STATUS = { mismatch: 'mismatch', complete: 'all-passed', partial: 'partly-checked', not_applicable: 'not-applicable' } as const;

export function buildVerdict(i: VerdictInput): Verdict {
  const { address, chainId, now } = i;
  const lower = address.toLowerCase();
  const api = i.api.ok ? i.api.vault : null;
  const apiReport = api?.report ?? null;
  const problems: string[] = [];
  if (!i.api.ok) problems.push(clean(i.api.reason));
  if (i.report && !i.report.ok) problems.push(`Report file: ${clean(i.report.reason)}`);
  if (i.chain.read === 'unread') problems.push(`Registry on Monad testnet could not be read: ${clean(i.chain.reason)}`);

  // The report file counts only when it hashes to what the API names and is about this chain, vault and block.
  let detail: ReportJson | null = null;
  let verified: boolean | null = null;
  if (apiReport && i.report?.ok) {
    const f = i.report.parsed;
    if (reportHashOf(i.report.json) !== apiReport.reportHash.toLowerCase()) {
      problems.push(`The report file does not hash to the reportHash the API names (${apiReport.reportHash}); it is not used.`);
    } else if (f.chainId !== chainId || f.address.toLowerCase() !== lower || f.blockNumber !== apiReport.blockNumber) {
      problems.push(`The report file is about chain ${f.chainId}, ${f.address}, block ${f.blockNumber}, not this vault at block ${apiReport.blockNumber}; it is not used.`);
    } else {
      detail = f;
    }
    verified = detail !== null;
  }
  const traits = (detail?.traits ?? []).map(traitView);
  const asyncRedeem = traits.some((t) => t.id === 'async-redeem');

  const attestation = attestationView({
    chain: i.chain,
    registry: i.registry,
    rpc: originOf(i.rpcUrl),
    now,
    reportHash: apiReport?.reportHash ?? null,
    reportBlock: detail?.blockNumber ?? apiReport?.blockNumber ?? null,
    implementationKey: detail?.identity.implementationKey ?? null,
    server: api?.attestation ?? null,
  });

  if (attestation.read === 'ok' && attestation.issuedAt === null) problems.push(`The registry answered a time for attestation #${attestation.id} that is not a time; it is not used.`);

  let failed: FailedProperty[] = [];
  let status: VerdictStatus;
  let level: VaultLevel | null;
  let basis: Verdict['basis'];
  let summary: Verdict['summary'] = null;
  let blockChecked: string | null = null;
  let checkedAt: string | null = null;
  let notJudged: Verdict['notJudged'] = [];
  let matchesApiSummary: boolean | null = null;
  let coversAllProperties: boolean | null = null;
  let fullStrength: boolean | null = null;

  if (apiReport && detail) {
    basis = 'report';
    const results = detail.results;
    const count = (s: string) => results.filter((r) => r.status === s).length;
    summary = { pass: count('pass'), fail: count('fail'), inconclusive: count('inconclusive'), notApplicable: count('not_applicable'), total: results.length };
    status = statusOf(summary);
    blockChecked = detail.blockNumber;
    checkedAt = detail.startedAt;
    coversAllProperties =
      results.length === PROPERTY_IDS.length && results.every((r, k) => r.id === PROPERTY_IDS[k]) && TABLE_HASHES.includes(propertiesHash(results).toLowerCase());
    fullStrength =
      detail.runs >= MIN_RUNS &&
      detail.delta === '0' &&
      detail.upstream.repo === ERC4626_UPSTREAM.repo &&
      detail.upstream.commit === ERC4626_UPSTREAM.commit &&
      suiteHash(suiteOf(detail)).toLowerCase() === apiReport.suiteHash.toLowerCase();
    if (!fullStrength) {
      problems.push(
        `The check ran with ${detail.runs} fuzz runs a property, delta ${clean(detail.delta, 40)} and ${clean(detail.upstream.repo, 80)} at ${clean(detail.upstream.commit, 40)}, or its suite hash is not the one the API names; this server vouches only for ${MIN_RUNS} runs or more, delta 0 and the pinned suite.`,
      );
    }
    const findingFromApi = new Map(apiReport.failed.map((f) => [f.id, f.finding]));
    const classes: FailureClass[] = [];
    failed = results
      .filter((r) => r.status === 'fail')
      .map((r) => {
        const c = classifyFailure({ id: r.id, ...(r.counterexample ? { counterexample: r.counterexample } : {}) });
        classes.push(c);
        const call: ConcreteCall | null =
          maxHonoredCall(r.reason) ??
          (r.counterexample?.calls.length ? { kind: 'fuzz-counterexample', text: `forge input that failed ${r.test}: ${clean(r.counterexample.calls[0], 400)}`, test: r.test, calls: r.counterexample.calls.map((x) => clean(x, 400)) } : null);
        const finding = findingFromApi.has(r.id) ? clean(findingFromApi.get(r.id)) : findingOf(r);
        const rule = ruleOf(r.id, c, asyncRedeem);
        return { id: r.id, level: c.level, topic: c.topic, eip: eipSentence(r.id), explanation: rule ? `${finding} ${rule}` : finding, call, concerns: concernsOf(r.id) };
      });
    level = vaultLevelOf(classes);
    notJudged = results
      .filter((r) => r.status === 'inconclusive' || r.status === 'not_applicable')
      .map((r) => ({ id: r.id, status: r.status as 'inconclusive' | 'not_applicable', reason: clean(r.reason, 200) }));
    const s = apiReport.summary;
    const apiIds = [...apiReport.failed.map((f) => f.id)].sort().join();
    matchesApiSummary =
      s.pass === summary.pass && s.fail === summary.fail && s.inconclusive === summary.inconclusive && s.notApplicable === summary.notApplicable &&
      apiReport.total === summary.total && API_STATUS[apiReport.status] === status && apiIds === failed.map((f) => f.id).sort().join() && apiReport.startedAt === detail.startedAt;
    if (!matchesApiSummary) problems.push('The API summary of the report disagrees with the report file; the file is used.');
  } else if (apiReport) {
    // The file could not be used: the API's summary is all there is, and it is not shown to be rounding.
    basis = 'report';
    summary = { ...apiReport.summary, total: apiReport.total };
    status = API_STATUS[apiReport.status];
    blockChecked = apiReport.blockNumber;
    checkedAt = apiReport.startedAt;
    const classes: FailureClass[] = [];
    failed = apiReport.failed.map((f) => {
      const c: FailureClass = propertyLevel(f.id) === 'must' || f.level === 'must' ? { level: 'must', topic: 'must' } : { level: 'should', topic: f.id.startsWith('RT-') ? 'round-trip' : 'allowance' };
      classes.push(c);
      const finding = clean(f.finding);
      const rule = ruleOf(f.id, c, false);
      return { id: clean(f.id, 60), level: c.level, topic: c.topic, eip: eipSentence(f.id), explanation: rule ? `${finding} ${rule}` : finding, call: null, concerns: concernsOf(f.id) };
    });
    level = vaultLevelOf(classes);
  } else if (!api && attestation.read === 'ok' && attestation.status === 'Valid' && attestation.counts && attestation.failedProperties.every((id) => PROPERTY_IDS.includes(id))) {
    // The API is down: a Valid attestation read on chain is the only result there is.
    basis = 'attestation';
    const c = attestation.counts;
    const total = c.pass + c.fail + c.inconclusive + c.notApplicable;
    summary = { ...c, total };
    blockChecked = attestation.blockNumber;
    status = statusOf(c);
    // A bitmap carries no logs, so a SHOULD round trip cannot be shown to be rounding here.
    level = attestation.failedLevel;
    failed = attestation.failedProperties.map((id) => {
      const must = propertyLevel(id) === 'must';
      return {
        id,
        level: must ? ('must' as const) : ('should' as const),
        topic: must ? ('must' as const) : id.startsWith('RT-') ? ('round-trip' as const) : ('allowance' as const),
        eip: eipSentence(id),
        explanation: `Failed in the attested check of block ${attestation.blockNumber}. The report with the finding could not be read from the Specfirst API.`,
        call: null,
        concerns: concernsOf(id),
      };
    });
  } else {
    basis = 'none';
    status = api && !api.checked ? 'unchecked' : 'unknown';
    if (api?.checked) problems.push('The API says the vault was checked but names no report for it.');
    level = null;
  }

  const reportAgeHours = hoursSince(checkedAt, now);
  if (checkedAt !== null && reportAgeHours === null) problems.push(`The time of the latest check (${clean(checkedAt, 40)}) is unknown or in the future.`);
  const base = i.apiBase;
  return {
    vault: { address, chainId, name: cleanOrNull(api?.vault.name), protocol: cleanOrNull(api?.vault.protocol), assetSymbol: cleanOrNull(api?.vault.assetSymbol, 20) },
    status,
    level,
    basis,
    summary,
    blockChecked,
    checkedAt,
    failed,
    notJudged,
    traits,
    report: apiReport
      ? { url: onBase(base, apiReport.url), reportHash: apiReport.reportHash, verified, matchesApiSummary, coversAllProperties, fullStrength, reproduce: detail ? reproduceOf(detail) : null }
      : null,
    attestation,
    freshness: {
      reportAgeHours,
      staleAfterHours: i.staleHours,
      stale: checkedAt === null ? null : reportAgeHours === null ? true : reportAgeHours > i.staleHours,
      attestationAgeHours: attestation.ageHours,
    },
    watcher: i.watch
      ? { knows: i.watch.watched, foundBy: cleanOrNull(i.watch.found?.source, 40), foundAt: i.watch.found?.at ?? null, lastCheckBlock: i.watch.lastCheck?.block ?? null, lastCheckAt: i.watch.lastCheck?.at ?? null }
      : null,
    links: { page: `${base}/v/${chainId}/${lower}`, requestCheck: `${base}/check?vault=${lower}`, inbox: `${base}/watch/inbox` },
    problems,
    meaning: [...MEANING],
    readAt: now.toISOString(),
  };
}

export interface VerdictDeps {
  api: SpecfirstApi;
  chain: ChainReader;
  registry: string;
  rpcUrl: string;
  staleHours: number;
  now?: () => Date;
}

function apiReason(err: unknown): string {
  return err instanceof ApiError ? err.message : `Specfirst API read failed: ${(err as Error).message}`;
}

/** Reads the API and the registry at the same time, then the report file or, for a vault with no report, the watcher. */
export async function gatherVerdict(deps: VerdictDeps, address: Address, chainId: number): Promise<Verdict> {
  const [apiRes, chain] = await Promise.all([
    deps.api.vault(chainId, address).then(
      (vault): ApiRead => ({ ok: true, vault }),
      (err): ApiRead => ({ ok: false, reason: apiReason(err) }),
    ),
    deps.chain.latest(chainId, address),
  ]);
  let report: ReportRead | null = null;
  let watch: WatchVault | null = null;
  if (apiRes.ok && apiRes.vault.report) {
    report = await deps.api.report(apiRes.vault.report.url).then(
      (r): ReportRead => ({ ok: true, json: r.json, parsed: r.parsed }),
      (err): ReportRead => ({ ok: false, reason: apiReason(err) }),
    );
  } else if (apiRes.ok) {
    watch = await deps.api.watchVault(chainId, address).catch(() => null);
  }
  const input: VerdictInput = {
    address,
    chainId,
    api: apiRes,
    report,
    chain,
    watch,
    apiBase: deps.api.base,
    registry: deps.registry,
    rpcUrl: deps.rpcUrl,
    staleHours: deps.staleHours,
    now: (deps.now ?? (() => new Date()))(),
  };
  return verdictOrFallback(input);
}

/**
 * buildVerdict, and when an answer cannot be used, the same without it: without the API's answer, else without the
 * registry's, else without both, so whichever source is usable is kept. An unusable answer is an unreadable source,
 * never a tool error.
 */
export function verdictOrFallback(input: VerdictInput): Verdict {
  try {
    return buildVerdict(input);
  } catch (err) {
    const why = clean((err as Error).message, 200);
    const api: ApiRead = { ok: false, reason: `The Specfirst API answer could not be used (${why})` };
    const chain: LatestRead = { read: 'unread', reason: `The registry answer could not be used (${why})` };
    try {
      return buildVerdict({ ...input, api, report: null, watch: null });
    } catch {
      try {
        return buildVerdict({ ...input, chain });
      } catch {
        return buildVerdict({ ...input, api, report: null, watch: null, chain });
      }
    }
  }
}
