import { classifyFailure, failureLevelOf, roundTripDifference, type FailureClass, type FailureLevel, type FailureLike } from './levels.ts';
import type { PropertyStatus, ReasonCategory, ReportResultView, SkipReason, StatusCounts, VaultStatus, VaultTraitView } from './types';

/*
 * Turns the reasons forge and the harness write into sentences for people. Pure and dependency free, so the
 * build script, the server pages and client components can all use it.
 *
 * The patterns below mirror packages/core/src/standards/report.ts and check.ts. This module cannot import
 * @specfirst/core's root (it pulls Node-only code into the Next bundle), so the few strings it matches on are
 * copied; test/board-reasons.test.ts compares them with core's exports so they cannot drift apart silently.
 */

/** core RESTRICTED_ASSET_NOTE: reason of every property when test users cannot move the asset. */
export const RESTRICTED_ASSET_NOTE = 'asset token restricts transfers (allowlist or similar); both suites need freely transferable test balances';
/** core MISSING_PRECOMPILE_NOTE: start of the reason when every rejected input needed a Monad precompile forge's EVM lacks. */
export const MISSING_PRECOMPILE_NOTE = 'a vault call reached Monad precompile';

const TOO_MANY_REJECTS = /^`vm\.assume` rejected too many inputs \((\d+) allowed\)/;
const DEPOSIT_BELOW_MAX = /deposit reverted below maxDeposit (\d+) times/;
const UNFUNDABLE = /^the asset's balance slot cannot be written|^stdStorage (?:find|checked_write)\(StdStorage\): /;
const RPC_ERROR = /^fork RPC error|^EVM error; database error: /;
const MAX_ZERO = /^(max(?:Deposit|Mint|Withdraw|Redeem)) returned 0 for every test user/;
const SEPARATE_SHARE = /^ERC-7575 vault: shares are a separate token \(share\(\) = (0x[0-9a-fA-F]{40})\)/;
const NATIVE_ASSET = /^asset\(\) is the ERC-7535 native-asset sentinel/;
const SETUP_FAILED = /^setUp failed: ([\s\S]*)$/;
const FORGE_STATUS = /^forge status (\S+)/;
/**
 * SpecfirstMaxHonored.t.sol failure text: action, amount, raw selector (or why there is none), max name and value,
 * then optionally the runner's notes after "; " (core minAmountNote).
 */
const MAX_HONORED_FAIL = /^(deposit|mint|withdraw|redeem)\((\d+)\) reverted with (selector (0x[0-9a-fA-F]{8})|no revert data|short revert data) while (max(?:Deposit|Mint|Withdraw|Redeem)) is (\d+)(?:; [\s\S]*)?$/;
/** core missingPrecompileNote: the precompile, and with a count when other inputs were judged. */
const MISSING_PRECOMPILE = /a vault call reached Monad precompile (0x[0-9a-fA-F]{40}), which forge lacks(?:, in (\d+) inputs)?; these inputs were not judged/;
/** core setupPrecompileNote: inputs rejected in a setup deposit that reached a missing precompile. */
const SETUP_PRECOMPILE = /a vault call reached Monad precompile (0x[0-9a-fA-F]{40}) in the setup deposit, which forge lacks, in (\d+) inputs; these inputs were rejected/;
/** core belowBoundNote. */
const BELOW_BOUND = /(\d+) amounts below the bound were refused; the bound itself was accepted/;

/**
 * Custom errors seen in the Monad batch, named by matching the 4-byte selector against candidate signatures.
 * The vault's source was not read to produce these; test/board-reasons.test.ts recomputes every selector.
 */
export const KNOWN_ERROR_SELECTORS: Readonly<Record<string, string>> = {
  '0x75ed2e3e': 'WithdrawalRequestRequired()',
  '0xe14e66da': 'WithdrawalsArePaused()',
  '0x82b42900': 'Unauthorized()',
  '0xea8e4eb5': 'NotAuthorized()',
  '0x9773bb71': 'E_TransferFromFailed(bytes,bytes)',
};

export function knownErrorName(selector: string): string | null {
  return KNOWN_ERROR_SELECTORS[selector.toLowerCase()] ?? null;
}

export const PROPERTY_STATUS_LABEL: Record<PropertyStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  inconclusive: 'Inconclusive',
  not_applicable: 'Not applicable',
};

export const VAULT_STATUS_LABEL: Record<VaultStatus, string> = {
  mismatch: 'Spec mismatch',
  complete: 'All passed',
  partial: 'Partly checked',
  not_applicable: 'Not applicable',
};

/** The chip of a vault whose only failures are round trips: no MUST sentence failed, so not "Spec mismatch". */
export const ROUNDING_LABEL = 'Rounding favors caller';

/** The label of a vault's chip: its status, except a mismatch made only of round trips. */
export function vaultLabel(status: VaultStatus, failure: FailureLevel | null = null): string {
  return status === 'mismatch' && failure === 'rounding' ? ROUNDING_LABEL : VAULT_STATUS_LABEL[status];
}

/** "0.05%", or "<0.01%" for less: delta as a share of amount. */
export function percentOf(delta: string, amount: string): string {
  const a = BigInt(amount);
  if (a === 0n) return 'all';
  const hundredths = (BigInt(delta) * 10_000n) / a;
  if (hundredths === 0n) return '<0.01%';
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac ? `.${frac}` : ''}%`;
}

/**
 * Under a failed withdraw or redeem: why it counts as a MUST even when its reason names allowance or access control,
 * and where an allowance-only problem shows instead.
 */
export const WITHDRAW_REDEEM_NOTE =
  'A withdraw or redeem failure counts as a MUST whatever its reason says, since the reason text can come from the vault. A vault that only skips the allowance check shows up in withdraw-zero-allowance and redeem-zero-allowance, which are SHOULDs.';

/** The rule a failed SHOULD goes against, by its class; null for a MUST (its rule comes from the failure itself). */
export function shouldRule(c: FailureClass): string | null {
  switch (c.topic) {
    case 'rounding':
      return 'EIP-4626, Security Considerations: rounding should favor the Vault over its users. That is a SHOULD, not a MUST.';
    case 'round-trip':
      return c.delta && c.amount
        ? `EIP-4626's rounding guidance is a SHOULD, but a difference of ${groupDigits(c.delta)} base units, ${percentOf(c.delta, c.amount)} of the amount, is more than rounding.`
        : "EIP-4626's rounding guidance is a SHOULD; the report does not give the size of the difference, so it is not shown as rounding.";
    case 'allowance':
      return "EIP-4626: withdraw and redeem SHOULD check that the caller may spend the owner's shares.";
    default:
      return null;
  }
}

/** Short labels for the "why not checked" tally. */
export const REASON_LABEL: Record<ReasonCategory, string> = {
  'inputs-rejected': 'Vault rejected the fuzzed amounts',
  'max-zero': 'Max value was 0, nothing to honor',
  'unfundable-asset': 'Asset balance cannot be set for test users',
  'asset-transfer-restricted': 'Asset restricts transfers',
  'missing-precompile': 'Inputs needed a Monad precompile the fork lacks',
  'rpc-error': 'RPC failed during the fork',
  'separate-share-token': 'ERC-7575, shares are a separate token',
  'native-asset': 'ERC-7535, native asset',
  'setup-reverted': 'Suite setup reverted',
  other: 'Other',
};

/** Which category an inconclusive or not_applicable result belongs to; null for pass and fail. */
export function classifyReason(status: PropertyStatus, reason: string | undefined): ReasonCategory | null {
  if (status === 'pass' || status === 'fail') return null;
  const r = reason ?? '';
  if (r.startsWith(RESTRICTED_ASSET_NOTE)) return 'asset-transfer-restricted';
  if (r.startsWith(MISSING_PRECOMPILE_NOTE)) return 'missing-precompile';
  if (MAX_ZERO.test(r)) return 'max-zero';
  if (SEPARATE_SHARE.test(r)) return 'separate-share-token';
  if (NATIVE_ASSET.test(r)) return 'native-asset';
  if (RPC_ERROR.test(r)) return 'rpc-error';
  if (UNFUNDABLE.test(r)) return 'unfundable-asset';
  if (TOO_MANY_REJECTS.test(r)) return 'inputs-rejected';
  if (SETUP_FAILED.test(r)) return 'setup-reverted';
  return 'other';
}

export interface MaxHonoredFailure {
  action: 'deposit' | 'mint' | 'withdraw' | 'redeem';
  amount: string;
  /** 0x + 8 hex, or null when the revert carried no (or too little) data. */
  selector: string | null;
  maxName: string;
  max: string;
}

export function parseMaxHonoredFailure(reason: string | undefined): MaxHonoredFailure | null {
  const m = MAX_HONORED_FAIL.exec(reason ?? '');
  if (!m) return null;
  return {
    action: m[1] as MaxHonoredFailure['action'],
    amount: m[2]!,
    selector: m[4] ? m[4].toLowerCase() : null,
    maxName: m[5]!,
    max: m[6]!,
  };
}

/** "0x75ed2e3e, WithdrawalRequestRequired()" or just the selector when its name is not known. */
export function describeSelector(selector: string | null): string {
  if (!selector) return 'no revert data';
  const name = knownErrorName(selector);
  return name ? `${selector}, ${name}` : selector;
}

/** What EIP-4626 says about the max function a max-honored property checks. */
export function eipSentence(maxName: string): string {
  switch (maxName) {
    case 'maxDeposit':
      return 'EIP-4626: maxDeposit MUST return the maximum amount of assets deposit accepts without reverting.';
    case 'maxMint':
      return 'EIP-4626: maxMint MUST return the maximum amount of shares mint accepts without reverting.';
    case 'maxWithdraw':
      return 'EIP-4626: maxWithdraw MUST return the maximum amount of assets withdraw accepts without reverting, and 0 while withdrawals are disabled.';
    case 'maxRedeem':
      return 'EIP-4626: maxRedeem MUST return the maximum amount of shares redeem accepts without reverting, and 0 while redemptions are disabled.';
    default:
      return '';
  }
}

/**
 * What a failed property found, and the EIP-4626 rule it breaks when that is known. `failure` (its id, and the
 * report's logs or a class computed at build) names SHOULD rules and the size of a round trip's difference.
 */
export function describeFailure(reason: string | undefined, failure?: FailureLike): { finding: string; rule: string | null } {
  const f = parseMaxHonoredFailure(reason);
  if (f) {
    const how = f.selector ? `with ${describeSelector(f.selector)}` : `with ${reason?.includes('short revert data') ? 'short revert data' : 'no revert data'}`;
    return { finding: `${f.maxName} was ${groupDigits(f.max)}, but ${f.action}(${groupDigits(f.amount)}) reverted ${how}.`, rule: eipSentence(f.maxName) || null };
  }
  const c = failure ? classifyFailure({ ...failure, reason: failure.reason ?? reason }) : null;
  const rule = c ? shouldRule(c) : null;
  const note = failure && (failure.id === 'withdraw' || failure.id === 'redeem') ? WITHDRAW_REDEEM_NOTE : null;
  const d = roundTripDifference(failure?.counterexample?.logs);
  const finding = d
    ? `Forge found a counterexample: the round trip ended ${groupDigits(d.delta.toString())} base ${d.delta === 1n ? 'unit' : 'units'} in the caller's favor (${groupDigits(d.a.toString())} against ${groupDigits(d.b.toString())}).`
    : reason
      ? `Forge found a counterexample: ${reason}`
      : 'Forge found a counterexample.';
  return { finding, rule: rule ?? note };
}

/** One or two sentences on what a failed property found. */
export function explainFailure(reason: string | undefined, failure?: FailureLike): string {
  const { finding, rule } = describeFailure(reason, failure);
  return rule ? `${finding} ${rule}` : finding;
}

function refusalOf(reason: string): string {
  const rest = reason.slice(RESTRICTED_ASSET_NOTE.length).trim();
  const sel = /selector (0x[0-9a-fA-F]{8})/.exec(rest);
  if (sel) return ` The test transfer was refused with ${describeSelector(sel[1]!.toLowerCase())}.`;
  if (/transfer returned false/.test(rest)) return ' The test transfer returned false.';
  if (/no revert data/.test(rest)) return ' The test transfer reverted with no revert data.';
  return '';
}

/**
 * What the runner counted beside the verdict: refusals below the bound (an sf- property checks that the bound is
 * accepted) and inputs not judged because they needed a missing precompile. Empty when there is neither.
 */
export function countedNotes(reason: string | undefined): string {
  const r = reason ?? '';
  const out: string[] = [];
  const below = BELOW_BOUND.exec(r);
  if (below) out.push(`${below[1]} amounts below the bound were refused; the bound itself was accepted.`);
  const pre = MISSING_PRECOMPILE.exec(r);
  if (pre?.[2]) out.push(`${pre[2]} inputs reached Monad precompile ${pre[1]}, which forge's EVM does not have, and were not judged.`);
  const setup = SETUP_PRECOMPILE.exec(r);
  if (setup) out.push(`${setup[2]} inputs were rejected because the setup deposit reached Monad precompile ${setup[1]}, which forge's EVM does not have.`);
  return out.join(' ');
}

function withCounted(sentence: string, reason: string | undefined): string {
  const notes = countedNotes(reason);
  return notes ? `${sentence} ${notes}` : sentence;
}

/** A sentence for one property result, whatever its status. */
export function explainResult(result: Pick<ReportResultView, 'status' | 'reason' | 'runs'> & Partial<Pick<ReportResultView, 'id' | 'counterexample'>>): string {
  const reason = result.reason ?? '';
  switch (result.status) {
    case 'pass':
      return withCounted(result.runs ? `No counterexample in ${result.runs} fuzz runs at this block.` : 'No counterexample at this block.', result.reason);
    case 'fail':
      return withCounted(explainFailure(result.reason, result.id ? { id: result.id, reason: result.reason, ...(result.counterexample ? { counterexample: result.counterexample } : {}) } : undefined), result.reason);
    default:
      break;
  }
  const category = classifyReason(result.status, result.reason);
  switch (category) {
    case 'inputs-rejected': {
      const limit = TOO_MANY_REJECTS.exec(reason)?.[1];
      const deposits = DEPOSIT_BELOW_MAX.exec(reason)?.[1];
      const base = `Never exercised: the vault rejected nearly every amount the fuzzer tried, and forge gave up after ${limit ?? 'too many'} discarded inputs.`;
      return withCounted(
        deposits
          ? `${base} Along the way deposit reverted ${deposits} times at amounts up to maxDeposit; some of these may be tiny amounts that round to zero shares, which many vaults reject. Those inputs were discarded, as upstream does, so this stays inconclusive; whether deposit honors maxDeposit is judged by sf-maxDeposit-honored.`
          : base,
        reason,
      );
    }
    case 'max-zero': {
      const maxName = MAX_ZERO.exec(reason)?.[1] ?? 'The max value';
      return `Nothing to honor: ${maxName} returned 0 for every test user. EIP-4626 allows a max to underestimate, so there was no advertised amount to hold the vault to.`;
    }
    case 'unfundable-asset':
      return 'Never exercised: test users could not be given the asset. Its balances are not in a storage slot forge-std can write, which is typical of rebasing or computed-balance tokens.';
    case 'asset-transfer-restricted':
      return `Not applicable: the asset restricts transfers, through an allowlist or similar, and both suites need test balances that move freely.${refusalOf(reason)}`;
    case 'missing-precompile': {
      const m = MISSING_PRECOMPILE.exec(reason);
      const at = m?.[1] ? ` ${m[1]}` : '';
      if (m?.[2]) {
        return `Not judged: ${m[2]} inputs reached Monad precompile${at}, which forge's EVM does not have, and reverted. The fork cannot tell whether such a revert needed the precompile's answer, so a property with unjudged inputs never counts as a pass; no other input failed.`;
      }
      return `Not judged: every rejected input reached Monad precompile${at}, which forge's EVM does not have, and its call reverted on the fork, which cannot tell whether the revert needed the precompile's answer. These inputs were not judged.`;
    }
    case 'rpc-error':
      return 'Never exercised: the RPC failed while the fork was reading chain state. This says nothing about the vault; a rerun on another RPC should settle it.';
    case 'separate-share-token': {
      const share = SEPARATE_SHARE.exec(reason)?.[1];
      return `Not applicable: this is an ERC-7575 vault whose shares are a separate token${share ? ` at ${share}` : ''}. Both suites treat the vault as its own share token, so their results would say nothing about it.`;
    }
    case 'native-asset':
      return "Not applicable: the vault's asset is the chain's native coin, the ERC-7535 sentinel address. The harness funds test users with ERC-20 deal and approve, which a native-asset vault does not take.";
    case 'setup-reverted': {
      const why = SETUP_FAILED.exec(reason)?.[1]?.trim();
      return `Not applicable: the suite could not start on this contract. setUp reverted${why ? ` with "${why}"` : ''}.`;
    }
    default: {
      if (reason === 'no result in forge output') return 'Inconclusive: forge reported no result for this property.';
      const st = FORGE_STATUS.exec(reason)?.[1];
      if (st) return `Inconclusive: forge ended this property with status ${st}.`;
      return reason ? `${PROPERTY_STATUS_LABEL[result.status]}: ${reason}` : `${PROPERTY_STATUS_LABEL[result.status]}.`;
    }
  }
}

/**
 * The report's skipReason when it has one (schemaVersion 3), else what an older report implies from vaultKind
 * or from its reasons. Null when at least one property was exercised.
 */
export function effectiveSkipReason(report: {
  skipReason?: SkipReason | null;
  vaultKind?: string;
  results: ReadonlyArray<Pick<ReportResultView, 'status' | 'reason'>>;
}): SkipReason | null {
  if (report.skipReason !== undefined) return report.skipReason;
  if (report.vaultKind === 'erc7535') return 'native-asset';
  if (report.vaultKind === 'erc7575') return 'separate-share-token';
  if (report.results.length === 0 || !report.results.every((r) => r.status === 'not_applicable')) return null;
  if (report.results.every((r) => (r.reason ?? '').startsWith(RESTRICTED_ASSET_NOTE))) return 'asset-transfer-restricted';
  if (report.results.every((r) => NATIVE_ASSET.test(r.reason ?? ''))) return 'native-asset';
  if (report.results.every((r) => SEPARATE_SHARE.test(r.reason ?? ''))) return 'separate-share-token';
  return 'setup-reverted';
}

/** Vault-level sentence for a report whose properties were all skipped. */
export function explainSkip(skip: SkipReason): string {
  switch (skip) {
    case 'native-asset':
      return "No property applies. The vault's asset is the chain's native coin (ERC-7535), and both suites fund test users with ERC-20 deal and approve. Nothing here says the vault is wrong or right.";
    case 'separate-share-token':
      return 'No property applies. This is an ERC-7575 vault whose shares live in a separate token, while both suites assume the vault is its own share token. Nothing here says the vault is wrong or right.';
    case 'asset-transfer-restricted':
      return 'No property applies. The asset only moves between allowed parties, so test users cannot be funded and moved around as both suites require. Nothing here is attributed to the vault.';
    case 'missing-precompile':
      return "No property could be exercised. Every property ran out of inputs, and its vault calls reverted after reaching a Monad precompile that forge's EVM does not have; those inputs were not judged. Nothing here says the vault is wrong or right.";
    case 'setup-reverted':
      return 'No property applies. The suites could not start on this contract because setUp reverted. The reason is listed with each property below.';
  }
}

/** "requestRedeem(uint256,address,address)" -> "requestRedeem". */
function functionName(signature: string): string {
  const i = signature.indexOf('(');
  return i === -1 ? signature : signature.slice(0, i);
}

/** The label of a trait, shown next to the verdict and in the vault's board row. Context, never a verdict. */
export function traitLabel(trait: VaultTraitView): string {
  const via = trait.evidence.requestFunctions[0];
  return `Asynchronous withdrawals: exits go through ${via ? functionName(via) : 'a request function'}`;
}

/** What the label rests on, for a tooltip or a line under it. */
export function traitBasis(trait: VaultTraitView): string {
  const e = trait.evidence;
  const code = `${e.requestFunctions.join(' and ')} in the code at ${e.codeAddress}`;
  const erc165 = e.erc165 ? (e.erc165.asyncRedeem ? 'ERC-165 declares ERC-7540 asynchronous redemption' : 'ERC-165 does not declare ERC-7540 asynchronous redemption') : null;
  const run =
    e.run === 'exits-rejected'
      ? 'in this check deposits worked while every withdraw and redeem reverted'
      : 'the exits could not be run on the fork, so the label comes from the code and ERC-165 only';
  return [code, erc165, run].filter(Boolean).join('; ') + '.';
}

/** The sentence added to a failed maxWithdraw or maxRedeem property of a vault with the async-redeem trait. */
export const ASYNC_MAX_NOTE = 'For an asynchronous vault, ERC-7540 still requires maxWithdraw and maxRedeem to report what can be claimed now.';

/** ASYNC_MAX_NOTE for a failed sf-maxWithdraw-honored or sf-maxRedeem-honored of an async-redeem vault, else null. */
export function asyncFailureNote(result: Pick<ReportResultView, 'id' | 'status'>, traits: ReadonlyArray<VaultTraitView> | undefined): string | null {
  if (result.status !== 'fail' || !traits?.some((t) => t.id === 'async-redeem')) return null;
  return result.id === 'sf-maxWithdraw-honored' || result.id === 'sf-maxRedeem-honored' ? ASYNC_MAX_NOTE : null;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function maxDelta(classes: ReadonlyArray<FailureClass>): FailureClass | null {
  let best: FailureClass | null = null;
  for (const c of classes) if (c.delta && (!best || BigInt(c.delta) > BigInt(best.delta!))) best = c;
  return best;
}

function units(delta: string): string {
  return `${groupDigits(delta)} base ${delta === '1' ? 'unit' : 'units'}`;
}

/**
 * The one-line verdict at the top of a vault page. A mismatch follows the classes of its failures (`failures`, with
 * their reasons and logs when known): any MUST keeps "contradicts an EIP-4626 MUST sentence"; round trips off by a
 * rounding-sized amount read as rounding; other SHOULD failures say what went through and by how much. Without
 * failures it reads as a MUST, so nothing is softened by mistake.
 */
export function verdictSentence(status: VaultStatus, summary: StatusCounts, blockNumber: string, failures: ReadonlyArray<FailureLike> = []): string {
  const total = summary.pass + summary.fail + summary.inconclusive + summary.notApplicable;
  const block = formatBlock(blockNumber);
  switch (status) {
    case 'mismatch': {
      const level = failureLevelOf(failures);
      const classes = failures.map(classifyFailure);
      const of = (t: FailureClass['topic']) => classes.filter((c) => c.topic === t);
      if (level === 'rounding') {
        const top = maxDelta(classes);
        return `Rounding favors the caller: ${plural(classes.length, 'round-trip property fails', 'round-trip properties fail')} EIP-4626's SHOULD guidance (Security Considerations) at block ${block}${top ? `, by at most ${units(top.delta!)}` : ''}; no MUST sentence failed.`;
      }
      if (level === 'should') {
        const parts: string[] = [];
        const allowance = of('allowance');
        if (allowance.length > 0) {
          parts.push(`${plural(allowance.length, 'withdraw or redeem', 'withdraws or redeems')} for an owner went through without the owner's allowance, which the vault SHOULD check`);
        }
        const large = of('round-trip').filter((c) => c.delta);
        if (large.length > 0) {
          const top = maxDelta(large)!;
          parts.push(`${large.length === 1 ? 'a round trip favors' : `${large.length} round trips favor`} the caller by ${large.length === 1 ? '' : 'up to '}${units(top.delta!)}, ${percentOf(top.delta!, top.amount!)} of the amount, more than rounding`);
        }
        const unknown = of('round-trip').filter((c) => !c.delta);
        if (unknown.length > 0) parts.push(`${unknown.length === 1 ? 'a round trip favors' : `${unknown.length} round trips favor`} the caller by an amount the report does not give`);
        const small = of('rounding');
        if (small.length > 0) parts.push(`${small.length === 1 ? 'a round trip favors' : `${small.length} round trips favor`} the caller by a rounding difference`);
        return `${summary.fail} of ${total} properties failed at block ${block}, all of them EIP-4626 SHOULD sentences: ${parts.join('; ')}. No MUST sentence failed.`;
      }
      return `${summary.fail} of ${total} properties failed at block ${block}. The vault's behavior contradicts an EIP-4626 MUST sentence.`;
    }
    case 'complete':
      return `All ${total} properties passed at block ${block}. No counterexample was found; that is evidence, not a safety guarantee.`;
    case 'partial': {
      const open = summary.inconclusive + summary.notApplicable;
      return `${summary.pass} of ${total} properties passed and none failed at block ${block}. ${open} could not be exercised.`;
    }
    case 'not_applicable':
      return `None of the ${total} properties apply to this vault at block ${block}.`;
  }
}

/** "109195820" -> "109,195,820". Amounts and block numbers are decimal strings in reports. */
export function groupDigits(decimal: string): string {
  return /^\d+$/.test(decimal) ? decimal.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : decimal;
}

export function formatBlock(blockNumber: string): string {
  return groupDigits(blockNumber);
}

/** Which EIP-4626 action a failed max-honored property is about, for grouping findings. */
export function failedActions(reasons: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const r of reasons) {
    const f = parseMaxHonoredFailure(r);
    if (f) out.add(f.action);
  }
  return [...out];
}

/** One sentence per category for the tally on the board. */
export const REASON_DETAIL: Record<ReasonCategory, string> = {
  'inputs-rejected': 'Forge discarded too many inputs because the vault reverted on them, for example deposits into a full or closed vault.',
  'max-zero': 'The vault reported a max of 0 for every test user, which EIP-4626 allows, so there was no promised amount to test.',
  'unfundable-asset': "The asset keeps balances where forge-std cannot write them, such as rebasing tokens, so test users could not be funded.",
  'asset-transfer-restricted': 'The asset only moves between allowed parties, and both suites need test users who can send it freely.',
  'missing-precompile': "Every rejected input reached a Monad precompile, such as staking at 0x1000, that forge's EVM does not have; those inputs were not judged.",
  'rpc-error': 'The public RPC failed while the fork read chain state. A rerun on another RPC should settle it.',
  'separate-share-token': 'Shares live in a separate token, as EIP-7575 allows, while both suites treat the vault as its own share token.',
  'native-asset': "The vault holds the chain's native coin, and the harness funds users with ERC-20 transfers.",
  'setup-reverted': 'The suite could not start on the contract.',
  other: 'Forge gave no usable result.',
};

/** True for categories that make a property not applicable rather than inconclusive. */
export function isNotApplicableCategory(c: ReasonCategory): boolean {
  return c === 'max-zero' || c === 'asset-transfer-restricted' || c === 'separate-share-token' || c === 'native-asset' || c === 'setup-reverted';
}

/** What an implementationKey was computed from (ADR 0003, "Implementation identity"), in words. */
export function describeKeyKind(kind: { of: string; hash: string }): string {
  const whose = kind.of === 'implementation' ? 'Implementation behind the proxy' : "The vault's own code";
  switch (kind.hash) {
    case 'metadataHash+maskedCodeHash':
      return `${whose}: same compiler metadata and same code with immutables masked`;
    case 'maskedCodeHash':
      return `${whose}: same code with immutables masked, no compiler metadata`;
    default:
      return `${whose}: same exact runtime code`;
  }
}
