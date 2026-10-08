import type { MoveCheck } from './decide.js';
import type { Findings } from './findings.js';
import type { Verdict } from './verdict.js';
import type { WatchGuide } from './watch.js';

/*
 * The text block of each tool result: a short account an LLM can read and quote. The full result is the structured
 * content (and a JSON text block after this one, for hosts that do not pass structured content on).
 */

const STATUS: Readonly<Record<Verdict['status'], string>> = {
  'all-passed': 'all passed',
  mismatch: 'mismatch',
  'partly-checked': 'partly checked',
  'not-applicable': 'not applicable',
  unchecked: 'not checked by Specfirst',
  unknown: 'unknown (nothing could be read)',
};

/** Names come from the vault or its deployer: quoted, and already cleaned to one bounded line (verdict.ts clean). */
function vaultLine(v: { address: string; chainId: number; name: string | null; protocol: string | null }): string {
  return `${v.name ? `"${v.name}"${v.protocol ? ` (${v.protocol})` : ''} ` : ''}${v.address} on chain ${v.chainId}`;
}

export function verdictText(v: Verdict): string {
  const out: string[] = [vaultLine(v.vault)];
  const level = v.level === null ? '' : v.level === 'none' ? ', nothing failed' : `, level ${v.level === 'rounding' ? 'rounding (SHOULD only, rounding sized)' : v.level.toUpperCase()}`;
  out.push(`Status: ${STATUS[v.status]}${level}.`);
  if (v.summary) {
    const s = v.summary;
    const age = v.freshness.reportAgeHours !== null ? ` (${v.freshness.reportAgeHours} hours ago${v.freshness.stale ? ', stale' : ''})` : '';
    out.push(
      `${s.pass} pass, ${s.fail} fail, ${s.inconclusive} inconclusive, ${s.notApplicable} not applicable of ${s.total}, at block ${v.blockChecked}${v.checkedAt ? `, checked ${v.checkedAt}${age}` : ''}${v.basis === 'attestation' ? ', from the attestation alone' : ''}.`,
    );
  }
  if (v.failed.length) {
    out.push('Failed:');
    for (const f of v.failed) {
      out.push(`- ${f.id} (${f.level.toUpperCase()}): ${f.explanation}`);
      if (f.call?.kind === 'max-honored') out.push(`  Call: ${f.call.text}`);
      if (f.eip) out.push(`  ${f.eip}`);
    }
  }
  for (const t of v.traits) out.push(`Trait: ${t.label}.`);
  const a = v.attestation;
  if (a.read === 'ok') {
    const about = a.matchesReport
      ? 'the shown report'
      : a.relativeToReport === 'earlier-block'
        ? 'an earlier check, not the shown report'
        : a.relativeToReport === 'later-block'
          ? 'a later check than the shown report'
          : 'another report';
    out.push(`On chain: attestation #${a.id} (${a.status}, block ${a.blockNumber}, issued ${a.issuedAt}), isCompliant ${a.isCompliant}, about ${about}.`);
  } else if (a.read === 'none') {
    out.push('On chain: no attestation in the registry.');
  } else {
    out.push(`On chain: the registry could not be read (${a.reason}).`);
  }
  if (v.status === 'unchecked') {
    out.push(`Not on the board. Request a check: ${v.links.requestCheck}${v.watcher?.knows ? ' (the watcher knows this address)' : ' (the watcher has not found it)'}.`);
  }
  if (v.report) {
    const r = v.report;
    const check =
      r.verified === true
        ? ` (hashes to the reportHash the API names${a.matchesReport ? ' and the attested one' : ''}${r.matchesApiSummary === false ? '; the API summary disagrees with it, the file is used' : ''})`
        : r.verified === false
          ? ' (not used: it does not hash to the reportHash the API names, or is about another vault or block)'
          : ' (not read)';
    out.push(`Report: ${r.url ?? 'link refused'}${check}`);
  }
  out.push(`Page: ${v.links.page}`);
  for (const p of v.problems) out.push(`Problem: ${p}`);
  out.push(...v.meaning);
  return out.join('\n');
}

export function moveText(m: MoveCheck): string {
  const out: string[] = [`${m.decision.toUpperCase()}: ${m.action} on ${vaultLine(m.vault)}${m.amount !== null ? `, amount ${m.amount}` : ''}.`];
  for (const effect of ['refuse', 'caution', 'info'] as const) {
    const rs = m.reasons.filter((r) => r.effect === effect);
    if (!rs.length) continue;
    out.push(`${effect === 'refuse' ? 'Refuse' : effect === 'caution' ? 'Caution' : 'Note'}:`);
    for (const r of rs) out.push(`- [${r.code}] ${r.text}`);
  }
  if (m.sizing.length) {
    out.push('Sizing:');
    for (const s of m.sizing) out.push(`- ${s}`);
  }
  out.push(...m.meaning);
  return out.join('\n');
}

export function findingsText(f: Findings): string {
  const out: string[] = [];
  const w = f.watcher;
  out.push(
    w
      ? `Watcher on chain ${f.chainId}: ${w.running ? (w.stale ? 'running but no update lately' : 'running') : 'not running'}${w.behindBlocks !== null ? `, ${w.behindBlocks} blocks behind the head` : ''}${w.checked24h !== null ? `, ${w.checked24h} checks and ${w.changed24h} changes in 24 hours` : ''}.`
      : `Watcher on chain ${f.chainId}: status not read.`,
  );
  out.push(`Scanned ${f.scanned.events} feed events${f.scanned.oldestAt ? ` back to ${f.scanned.oldestAt}` : ''}${f.scanned.reachedStart ? ' (the whole feed)' : ''}.`);
  out.push(f.changes.length ? 'Changes, newest first:' : 'No changes in the scanned events.');
  for (const c of f.changes) out.push(`- ${c.at} ${c.text}`);
  out.push(f.currentMismatches.length ? 'Current mismatches (latest check in the scanned events):' : 'No vault whose latest scanned check is a mismatch.');
  for (const m of f.currentMismatches) {
    out.push(`- ${m.vault.name ? `"${m.vault.name}" ` : ''}${m.vault.address}: ${(m.level ?? 'must').toUpperCase()}, ${m.failed.join(', ')} at block ${m.block}${m.pending ? ' (waiting for its confirming check)' : ''}.`);
  }
  for (const p of f.problems) out.push(`Problem: ${p}`);
  out.push(`Feed: ${f.links.feed}`);
  out.push(...f.meaning);
  return out.join('\n');
}

export function watchText(g: WatchGuide): string {
  const s = g.subscriptions;
  return [
    `Alerts for ${g.vault.address} on chain ${g.vault.chainId}: subscribe on CheckSubscriptions ${s.contract} (Monad testnet ${s.chainId}).`,
    s.fee === 'chain' ? `Fee: ${s.feePerDayMon} MON per day (${s.feePerDayWei} wei), read on chain now.` : `Fee: not read (${s.reason}).`,
    `Call: ${s.call} with subjectChainId ${s.args.subjectChainId}, subject ${s.args.subject}, standardId ${s.args.standardId}, days ${s.args.days}; value = ${s.value}.`,
    `Or use "Watch this vault" on ${g.web.vaultPage}. Inbox and webhook registration: ${g.web.inbox}.`,
    `Webhook kinds: ${g.webhook.kinds.map((k) => k.kind).join(', ')}; idempotency key ${g.webhook.idempotencyKey}.`,
    g.watcher?.knows
      ? `The watcher knows this vault${g.watcher.lastCheckBlock ? `, last checked at block ${g.watcher.lastCheckBlock}` : ''}.`
      : 'The watcher does not know this vault yet; it checks a subscribed vault first.',
    ...g.notes,
  ].join('\n');
}
