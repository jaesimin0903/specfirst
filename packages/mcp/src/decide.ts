import { PROPERTY_IDS, propertyLevel } from './levels.js';
import { concernsOf, MEANING, MIN_RUNS, quote, SIDE, type Action, type FailedProperty, type Verdict } from './verdict.js';

/*
 * check_before_moving_funds: refuse, caution or proceed for one action on one vault, from a Verdict. Pure, so the
 * rules are tested on fixtures (test/decide.test.ts). The principle: refuse needs evidence of a MUST mismatch that
 * concerns the action, proceed needs evidence that everything passed and is attested, and everything in between,
 * including anything that could not be read, is caution. Nothing that fails to load ever leads to proceed.
 */

export type Decision = 'refuse' | 'caution' | 'proceed';

export const REASON_CODES = [
  'must-failure-on-action',
  'registry-must-failure-on-action',
  'must-failure-elsewhere',
  'one-exit-broken',
  'should-only',
  'rounding-only',
  'not-judged',
  'not-applicable',
  'unchecked',
  'api-unavailable',
  'report-unverified',
  'weaker-check',
  'stale-result',
  'async-redeem',
  'no-attestation',
  'attestation-revoked',
  'registry-not-compliant',
  'registry-unread',
  'issuer-removed',
  'issuer-unread',
  'other-implementation',
  'implementation-unknown',
  'incomplete-evidence',
  'all-passed-attested',
  'attestation-older',
  'amount',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  /** What the reason does to the decision: refuse and caution set it, info only explains. */
  effect: 'refuse' | 'caution' | 'info';
  text: string;
}

export interface MoveCheck {
  decision: Decision;
  action: Action;
  /** As given, in the asset's base units (deposit, withdraw) or in shares (mint, redeem). */
  amount: string | null;
  vault: { address: string; chainId: number; name: string | null; protocol: string | null };
  /** One line for a log or a person. */
  summary: string;
  /** Refusals first, then cautions, then explanations. */
  reasons: Reason[];
  /** How not to size this action from the vault's own answers, when a check showed they are wrong. */
  sizing: string[];
  basis: {
    status: Verdict['status'];
    level: Verdict['level'];
    blockChecked: string | null;
    checkedAt: string | null;
    reportAgeHours: number | null;
    attestationId: string | null;
    attestationCompliant: boolean | null;
    attestationBlock: string | null;
  };
  meaning: string[];
  links: Verdict['links'];
  decidedAt: string;
}

const NOUN: Readonly<Record<Action, string>> = { deposit: 'deposits', mint: 'mints', withdraw: 'withdrawals', redeem: 'redemptions' };
const MAX_OF: Readonly<Record<Action, string>> = { deposit: 'maxDeposit', mint: 'maxMint', withdraw: 'maxWithdraw', redeem: 'maxRedeem' };
const HONORED: Readonly<Record<Action, string>> = {
  deposit: 'sf-maxDeposit-honored',
  mint: 'sf-maxMint-honored',
  withdraw: 'sf-maxWithdraw-honored',
  redeem: 'sf-maxRedeem-honored',
};

export const DECISION_MEANING: readonly string[] = [
  ...MEANING,
  'This server never signs or sends a transaction. The decision is advice for the caller, read from Specfirst reports and the CheckAttestationRegistry on Monad testnet.',
];

function list(ids: readonly string[]): string {
  return ids.join(', ');
}

function quoted(v: Verdict): string {
  return v.vault.name ? `${quote(v.vault.name)}${v.vault.protocol ? ` (${quote(v.vault.protocol)})` : ''} ${v.vault.address}` : v.vault.address;
}

function failureLine(f: FailedProperty): string {
  return `${f.id} (EIP-4626 ${f.level.toUpperCase()}): ${f.call?.kind === 'max-honored' ? f.call.text : f.explanation}`;
}

const exitOf = (id: string): 'withdraw' | 'redeem' | null => (SIDE.withdraw.includes(id) ? 'withdraw' : SIDE.redeem.includes(id) ? 'redeem' : null);

export function decide(v: Verdict, action: Action, amount: string | null = null, now: Date = new Date()): MoveCheck {
  const reasons: Reason[] = [];
  const add = (code: ReasonCode, effect: Reason['effect'], text: string) => reasons.push({ code, effect, text });
  const a = v.attestation;
  const entry = action === 'deposit' || action === 'mint';

  // MUST failures: in the latest report, and in the registry's latest attestation when it can stand as evidence
  // (Valid, not compliant, ids in the table, and not about code the vault no longer runs).
  const must = v.failed.filter((f) => f.level === 'must');
  const chainUsable = a.read === 'ok' && a.status === 'Valid' && a.isCompliant === false && a.sameImplementationAsReport !== false;
  const chainMust = chainUsable ? a.failedProperties.filter((id) => PROPERTY_IDS.includes(id) && propertyLevel(id) === 'must') : [];
  const mustIds = new Set([...must.map((f) => f.id), ...chainMust]);
  // Money that goes in has to come out: for deposit and mint the exits count when both withdraw and redeem are broken.
  const broken = { withdraw: [...mustIds].filter((id) => exitOf(id) === 'withdraw'), redeem: [...mustIds].filter((id) => exitOf(id) === 'redeem') };
  const bothExits = broken.withdraw.length > 0 && broken.redeem.length > 0;
  const concerns = (id: string) => concernsOf(id).includes(action) || (entry && bothExits && exitOf(id) !== null);

  // Refuse: a MUST failure that concerns the action, in the latest report or in the registry's latest attestation.
  const mustHere = must.filter((f) => concerns(f.id));
  for (const f of mustHere) {
    const viaExit = entry && exitOf(f.id) !== null;
    add('must-failure-on-action', 'refuse', `${failureLine(f)}${viaExit ? ` Both withdraw and redeem fail a MUST, so money put in has no exit that works as the vault says; this concerns ${action} too.` : ''}`);
  }
  const shown = new Set(mustHere.map((f) => f.id));
  const onChain = chainMust.filter((id) => concerns(id) && !shown.has(id));
  if (onChain.length > 0) {
    const newer = v.basis === 'report' && a.relativeToReport === 'earlier-block';
    add(
      'registry-must-failure-on-action',
      'refuse',
      `The registry's latest attestation #${a.id} (block ${a.blockNumber}) is not compliant and records MUST failures that concern ${action}: ${list(onChain)}.${
        newer
          ? ` The newer report of block ${v.blockChecked} does not show them, but it is not attested, so the registry's answer stands until a newer check is attested (a desk request does that: ${v.links.requestCheck}).`
          : ''
      }`,
    );
  }

  // Caution: everything that falls short of evidence either way.
  if (entry && !bothExits && (broken.withdraw.length > 0 || broken.redeem.length > 0)) {
    const [bad, good] = broken.withdraw.length > 0 ? (['withdraw', 'redeem'] as const) : (['redeem', 'withdraw'] as const);
    add('one-exit-broken', 'caution', `${bad} fails a MUST (${list(broken[bad])}) while ${good} does not, as far as this check shows: money put in can come out through ${good} only.`);
  }
  const elsewhere = must.filter((f) => !concerns(f.id) && !(entry && exitOf(f.id) !== null));
  if (elsewhere.length > 0) add('must-failure-elsewhere', 'caution', `The vault fails EIP-4626 MUST properties that do not concern ${action}: ${elsewhere.map(failureLine).join(' ')}`);
  if (v.level === 'rounding') {
    add('rounding-only', 'caution', `Only round trips failed, each by a rounding-sized difference in the caller's favor (${list(v.failed.map((f) => f.id))}). EIP-4626 says rounding SHOULD favor the vault; that is guidance, not a MUST.`);
  } else if (v.level === 'should') {
    add('should-only', 'caution', `Only EIP-4626 SHOULD properties failed: ${v.failed.map(failureLine).join(' ')}`);
  }
  if (v.status === 'unchecked') {
    const w = v.watcher;
    const watcher = w?.knows
      ? ` The watcher knows it (found by ${w.foundBy ?? 'a signal'}${w.lastCheckBlock ? `, last checked at block ${w.lastCheckBlock}` : ', not checked yet'}).`
      : ' The watcher has not found it yet; it finds vaults by itself from factory events, first deposits and upgrades.';
    const known = a.read === 'ok' ? 'Specfirst has no report of this vault, though the registry holds an attestation of it (its reasons are listed here).' : 'Specfirst has not checked this vault, so nothing is known about it either way.';
    add('unchecked', 'caution', `${known}${watcher} A paid request on the desk checks it now: ${v.links.requestCheck}`);
  }
  if (v.basis !== 'none' && v.summary) {
    const inc = v.summary.inconclusive;
    const na = v.summary.notApplicable;
    if (v.status === 'not-applicable') add('not-applicable', 'caution', `None of the ${v.summary.total} properties applied to this vault, so the check says nothing about it either way.`);
    else if (inc > 0 || na > 0) {
      const ids = v.notJudged.map((n) => n.id);
      add('not-judged', 'caution', `${inc + na} of ${v.summary.total} properties were not judged (${inc} inconclusive, ${na} not applicable)${ids.length ? `: ${list(ids)}` : ''}. An unjudged property is never a pass.`);
    }
  }
  if (v.basis !== 'report') {
    if (v.status !== 'unchecked') {
      add(
        'api-unavailable',
        'caution',
        `No usable result came from the Specfirst API${v.problems[0] ? ` (${v.problems[0]})` : ''}. ${v.basis === 'attestation' ? 'This decision rests on the registry alone; the report behind it, its freshness and its details were not seen.' : 'Nothing about the vault could be read from it.'}`,
      );
    }
  } else if (v.report?.verified !== true || v.report.matchesApiSummary !== true || v.report.coversAllProperties !== true) {
    const why =
      v.report?.verified !== true
        ? 'could not be read, does not hash to the reportHash the API names, or is about another vault or block, so this rests on the API summary alone'
        : v.report.matchesApiSummary !== true
          ? "disagrees with the API's summary of it; the file is used"
          : 'does not cover exactly the 30 properties of the table';
    add('report-unverified', 'caution', `The latest report file ${why}.`);
  } else if (v.report.fullStrength !== true) {
    add('weaker-check', 'caution', `The latest check did not run at full strength (at least ${MIN_RUNS} fuzz runs a property, delta 0, the pinned suite whose hash the API names), so a pass in it is weaker than this server vouches for.`);
  }
  if (v.freshness.stale) {
    add(
      'stale-result',
      'caution',
      v.freshness.reportAgeHours === null
        ? 'The time of the latest check is unknown or in the future, so it cannot be shown to be fresh.'
        : `The latest check is ${v.freshness.reportAgeHours} hours old, more than ${v.freshness.staleAfterHours}; the vault may have changed since block ${v.blockChecked}.`,
    );
  }
  const async = v.traits.find((t) => t.id === 'async-redeem');
  if (async) add('async-redeem', 'caution', `${async.label} (${async.basis.replace(/\.$/, '')}). Withdraw and redeem can revert until a request is claimable.`);
  if (a.read === 'unread') {
    add('registry-unread', 'caution', `The CheckAttestationRegistry on Monad testnet could not be read (${a.reason ?? 'unknown error'}). Without the on-chain answer this server does not say proceed.`);
  } else if (a.read === 'none') {
    add('no-attestation', 'caution', 'The registry has no attestation of this vault, so nothing on chain backs this result.');
  } else if (a.status === 'Revoked') {
    add('attestation-revoked', 'caution', `The registry's latest attestation #${a.id} was revoked; isCompliant is false and nothing older counts in its place.`);
  } else if (a.isCompliant === false && onChain.length === 0) {
    const unknown = a.failedProperties.filter((id) => !PROPERTY_IDS.includes(id));
    const what = unknown.length
      ? `bits outside the 30-property table: ${list(unknown)}, so it is about another property table`
      : a.failedProperties.length
        ? `${a.failedLevel === 'must' ? 'failed' : 'only SHOULD properties failed'}: ${list(a.failedProperties)}`
        : `${(a.counts?.inconclusive ?? 0) + (a.counts?.notApplicable ?? 0)} properties not judged`;
    const either = reasons.some((r) => r.effect === 'refuse') ? ' either' : '';
    add('registry-not-compliant', 'caution', `The registry's latest attestation #${a.id} (block ${a.blockNumber}) is not compliant${either} (${what}).`);
  }
  if (a.read === 'ok') {
    if (a.issuerCurrent === false) add('issuer-removed', 'caution', `The issuer of attestation #${a.id}, ${a.issuer}, is no longer an issuer of the registry.`);
    if (a.issuerCurrent === null) add('issuer-unread', 'caution', `Whether ${a.issuer}, the issuer of attestation #${a.id}, is still an issuer could not be read.`);
    if (a.sameImplementationAsReport === false) {
      add('other-implementation', 'caution', `Attestation #${a.id} is about another implementation than the latest report: the vault's code changed between block ${a.blockNumber} and block ${v.blockChecked}.`);
    }
    if (a.sameImplementationAsReport === null && v.basis === 'report') {
      add('implementation-unknown', 'caution', `Whether attestation #${a.id} is about the code the latest report checked could not be shown, since the report's identity was not read.`);
    }
  }

  const refuse = reasons.some((r) => r.effect === 'refuse');
  const caution = reasons.some((r) => r.effect === 'caution');
  // Proceed needs every piece of positive evidence, not only the absence of a caution.
  const n = PROPERTY_IDS.length;
  const proven =
    v.basis === 'report' &&
    v.status === 'all-passed' &&
    v.level === 'none' &&
    v.summary !== null &&
    v.summary.total === n &&
    v.summary.pass === n &&
    v.report?.verified === true &&
    v.report.matchesApiSummary === true &&
    v.report.coversAllProperties === true &&
    v.report.fullStrength === true &&
    v.freshness.stale === false &&
    a.read === 'ok' &&
    a.status === 'Valid' &&
    a.isCompliant === true &&
    a.issuedAt !== null &&
    a.failedProperties.length === 0 &&
    a.counts !== null &&
    a.counts.pass === n &&
    a.counts.fail + a.counts.inconclusive + a.counts.notApplicable === 0 &&
    a.issuerCurrent === true &&
    a.sameImplementationAsReport === true;
  const decision: Decision = refuse ? 'refuse' : caution || !proven ? 'caution' : 'proceed';

  if (decision === 'proceed') {
    add(
      'all-passed-attested',
      'info',
      `All ${n} properties passed at block ${v.blockChecked} (checked ${v.freshness.reportAgeHours} hours ago), and the registry's latest attestation #${a.id} is compliant. That is no counterexample found at that block, not a safety guarantee.`,
    );
    if (a.matchesReport === false) {
      add(
        'attestation-older',
        'info',
        a.relativeToReport === 'later-block'
          ? `Attestation #${a.id} is of a later all-pass check, at block ${a.blockNumber}, than the report shown (block ${v.blockChecked}).`
          : a.relativeToReport === 'same-block'
            ? `Attestation #${a.id} is of another all-pass report of the same block ${a.blockNumber}.`
            : `Attestation #${a.id} is of the check at block ${a.blockNumber}; the later all-pass check at block ${v.blockChecked} is not attested, since the watcher does not re-attest an unchanged result.`,
      );
    }
  } else if (decision === 'caution' && !caution) {
    add('incomplete-evidence', 'caution', 'The evidence needed to proceed (every property passed in a verified, fresh report and a compliant attestation of the same code) is not complete.');
  }
  if (amount !== null) {
    add('amount', 'info', `The decision does not depend on the amount (${amount}): the check tried amounts up to the vault's own max values for test users${v.blockChecked ? ` at block ${v.blockChecked}` : ''}, not this amount for this account.`);
  }

  const order = { refuse: 0, caution: 1, info: 2 } as const;
  reasons.sort((x, y) => order[x.effect] - order[y.effect]);
  const lead = reasons.find((r) => r.effect === decision) ?? reasons.find((r) => r.effect === 'info');
  return {
    decision,
    action,
    amount,
    vault: { address: v.vault.address, chainId: v.vault.chainId, name: v.vault.name, protocol: v.vault.protocol },
    summary: `${decision.toUpperCase()} ${action} on ${quoted(v)}${lead ? `. ${lead.text}` : ''}`,
    reasons,
    sizing: sizingOf(v, action, chainMust),
    basis: {
      status: v.status,
      level: v.level,
      blockChecked: v.blockChecked,
      checkedAt: v.checkedAt,
      reportAgeHours: v.freshness.reportAgeHours,
      attestationId: a.id,
      attestationCompliant: a.isCompliant,
      attestationBlock: a.blockNumber,
    },
    meaning: [...DECISION_MEANING],
    links: v.links,
    decidedAt: now.toISOString(),
  };
}

/** How not to size an action from the vault's own answers: failed max-honored properties (the action's own first), then the async trait. */
function sizingOf(v: Verdict, action: Action, chainMust: readonly string[]): string[] {
  const out: string[] = [];
  const own = HONORED[action];
  const first = (ids: string[]) => ids.sort((x, y) => (x === own ? -1 : y === own ? 1 : 0));
  const honored = Object.values(HONORED);
  const actionOf = (id: string) => (Object.keys(HONORED) as Action[]).find((k) => HONORED[k] === id)!;
  const reported = v.failed.filter((f) => honored.includes(f.id));
  for (const id of first(reported.map((f) => f.id))) {
    const f = reported.find((x) => x.id === id)!;
    const at = v.blockChecked ? ` at block ${v.blockChecked}` : '';
    const how = f.call?.kind === 'max-honored' ? `${f.call.text.replace(/\.$/, '')}${at}` : `${id} failed${at}`;
    out.push(`Do not size ${NOUN[actionOf(id)]} from ${MAX_OF[actionOf(id)]}: ${how}.`);
  }
  const shown = new Set(reported.map((f) => f.id));
  for (const id of first(chainMust.filter((x) => honored.includes(x) && !shown.has(x)))) {
    out.push(`Do not size ${NOUN[actionOf(id)]} from ${MAX_OF[actionOf(id)]}: the registry's attestation #${v.attestation.id} records ${id} failed at block ${v.attestation.blockNumber}.`);
  }
  const async = v.traits.find((t) => t.id === 'async-redeem');
  if (async) out.push(`${async.label}. Plan exits as a request and a later claim; a direct withdraw or redeem can revert even when maxWithdraw or maxRedeem says otherwise.`);
  return out;
}
