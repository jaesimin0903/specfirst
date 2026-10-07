import type { AttestationView, ReportResultView, VaultDetail, VaultTraitView } from '../../lib/board/types';
import {
  asyncFailureNote,
  describeKeyKind,
  effectiveSkipReason,
  describeFailure,
  explainResult,
  explainSkip,
  formatBlock,
  traitBasis,
  traitLabel,
  verdictSentence,
} from '../../lib/board/reasons';
import { addressUrl, txUrl } from '../../lib/board/attestations';
import { shortAddress, shortHash } from '../../lib/format';
import { LevelTag, PropertyChip, VaultChip } from './StatusChip';
import { failureLevelOf, propertyLevel } from '../../lib/board/levels';
import { Glyph } from './Glyph';
import { CopyButton } from './CopyButton';
import { chainName, reproduceCommandMultiline } from '../../lib/board/reproduce';
import { BadgeSnippet } from '../desk/BadgeSnippet';
import type { ReactNode } from 'react';
import type { VaultWatchJson } from '../../lib/watch/types';
import { foundSentence } from '../../lib/watch/words';
import { VaultHistory } from '../watch/VaultHistory';

export { chainName, reproduceArgs, reproduceCommand, reproduceCommandMultiline } from '../../lib/board/reproduce';

function rawText(r: ReportResultView): string {
  const lines: string[] = [];
  if (r.reason) lines.push(`reason: ${r.reason}`);
  if (r.runs !== undefined) lines.push(`runs: ${r.runs}`);
  if (r.counterexample) {
    for (const c of r.counterexample.calls) lines.push(`call: ${c}`);
    if (r.counterexample.calldata) lines.push(`calldata: ${r.counterexample.calldata}`);
    for (const l of r.counterexample.logs) lines.push(`log: ${l}`);
  }
  return lines.join('\n');
}

function StripBig({ results, split }: { results: ReportResultView[]; split: number }) {
  const CW = 22;
  const P = 26;
  const CH = 30;
  const GAP = 18;
  const x = (i: number) => i * P + (i >= split ? GAP : 0);
  const W = results.length ? x(results.length - 1) + CW : 0;
  const H = CH + 40;
  return (
    <div className="sb-strip-big">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${results.length} properties in report order: ${results.map((r, i) => `bit ${i} ${r.id} ${r.status}`).join('; ')}`}>
        {results.map((r, i) => (
          <a key={r.id} href={`#p-${r.id}`}>
            <title>{`bit ${i}, ${r.id}: ${r.status.replace('_', ' ')}`}</title>
            {r.status === 'inconclusive' ? (
              <rect className="i" x={x(i) + 0.75} y={0.75} width={CW - 1.5} height={CH - 1.5} />
            ) : r.status === 'not_applicable' ? (
              <rect className="n" x={x(i)} y={CH / 2 - 2} width={CW} height={4} />
            ) : (
              <rect className={r.status === 'pass' ? 'p' : 'f'} x={x(i)} y={0} width={CW} height={CH} />
            )}
            <text x={x(i) + CW / 2} y={CH + 13} textAnchor="middle">
              {i}
            </text>
          </a>
        ))}
        <text x={0} y={H - 2}>
          a16z/erc4626-tests
        </text>
        {results.length > split && (
          <text x={x(split)} y={H - 2}>
            Specfirst
          </text>
        )}
      </svg>
    </div>
  );
}

function AttestationPanel({ a, detail }: { a: AttestationView; detail: VaultDetail }) {
  const reg = detail.registry;
  const registryLink = (
    <a href={addressUrl(reg.address)} className="mono">
      {shortAddress(reg.address)}
    </a>
  );
  return (
    <section aria-labelledby="att-h">
      <h2 className="sb-h3" id="att-h">
        Onchain attestation
      </h2>
      {a.kind === 'unread' && (
        <>
          <p className="sb-att-state">
            <strong>Could not read attestation status.</strong>
          </p>
          <p className="soft">
            CheckAttestationRegistry {registryLink} on Monad testnet did not answer when this page was built ({a.reason}). The check result on this page
            does not depend on it.
          </p>
        </>
      )}
      {a.kind === 'none' && (
        <>
          <p className="sb-att-state">
            <strong>Not attested yet.</strong>
          </p>
          <p className="soft">
            CheckAttestationRegistry {registryLink} on Monad testnet holds no erc4626 attestation for this vault
            {reg.readAt ? ` as of ${reg.readAt.slice(0, 10)}` : ''}.
          </p>
        </>
      )}
      {a.kind === 'attested' && (
        <>
          <p className="sb-att-state">
            <span className="sb-seal">Attestation #{a.id}</span> <strong>{a.status}</strong>
          </p>
          <p>
            {a.matchesReport
              ? 'It records this exact report: the reportHash stored onchain equals the hash of the report on this page.'
              : `It records a different report, for block ${formatBlock(a.blockNumber)}${a.suiteMatches ? '' : ' with a different suite'}. This page shows block ${formatBlock(detail.report.blockNumber)}.`}{' '}
            {a.status === 'Revoked' ? 'The issuer has revoked it.' : a.status === 'Superseded' ? 'A newer attestation replaced it.' : ''}
          </p>
          <p className="soft" style={{ marginTop: 8 }}>
            {a.compliant === true
              ? 'isCompliant is true: every property passed in the attested report. That is the registry repeating the check result, not a safety rating.'
              : a.compliant === false
                ? 'isCompliant is false: the attested report has failing, inconclusive or not applicable properties.'
                : 'isCompliant could not be read.'}
          </p>
          <dl className="sb-facts" style={{ marginTop: 12 }}>
            <dt>Issued</dt>
            <dd>{a.issuedAt.slice(0, 16).replace('T', ' ')} UTC</dd>
            <dt>Issuer</dt>
            <dd className="mono">{shortAddress(a.issuer)}</dd>
            <dt>Counts</dt>
            <dd>
              {a.counts.pass} pass, {a.counts.fail} fail, {a.counts.inconclusive} inconclusive, {a.counts.notApplicable} n/a
            </dd>
            <dt>reportHash</dt>
            <dd className="mono" title={a.reportHash}>
              {shortHash(a.reportHash)}
            </dd>
            <dt>suiteHash</dt>
            <dd className="mono" title={a.suiteHash}>
              {shortHash(a.suiteHash)}
            </dd>
            <dt>Transaction</dt>
            <dd>
              {a.txHash ? (
                <a href={txUrl(a.txHash)} className="mono" title={a.txHash}>
                  {shortHash(a.txHash)}
                </a>
              ) : (
                <span className="soft">not recorded here; look for Attested id {a.id} in the registry&apos;s logs</span>
              )}
            </dd>
            <dt>Registry</dt>
            <dd>{registryLink}</dd>
          </dl>
          {/^https:\/\//.test(a.reportURI) && (
            <p style={{ marginTop: 12 }}>
              <a href={a.reportURI}>Report at the attested reportURI</a>
            </p>
          )}
        </>
      )}
    </section>
  );
}

/**
 * board: from the prerendered board data. requested: from a report written after the build (a paid check), read
 * when the page was requested. watcher: from a report the watcher wrote after the build, nobody asked for it.
 */
export type VaultViewSource = 'board' | 'requested' | 'watcher';

export interface VaultViewProps {
  detail: VaultDetail;
  source?: VaultViewSource;
  /** What the watcher knows about this vault (ADR 0006); its history is shown when there is any. */
  watch?: VaultWatchJson | null;
  /** The "Watch this vault" box, placed under the attestation. */
  subscribe?: ReactNode;
}

export function VaultView({ detail, source = 'board', watch = null, subscribe = null }: VaultViewProps) {
  const { row, report } = detail;
  const split = report.results.filter((r) => !r.id.startsWith('sf-')).length;
  const skip = effectiveSkipReason(report);
  const failed = report.results.filter((r) => r.status === 'fail');
  const failure = failureLevelOf(failed.map((r) => r.id));
  const upstream = report.results.slice(0, split);
  const upstreamShould = upstream.filter((r) => propertyLevel(r.id) === 'should').length;
  const traits: VaultTraitView[] = report.traits ?? [];
  const cmd = reproduceCommandMultiline(report);
  const title = row.name ?? row.address;
  const upstreamShort = report.upstream.commit.slice(0, 7);

  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/">All vaults</a>
        {row.protocol ? (
          <>
            {' / '}
            <a href={`/?protocol=${encodeURIComponent(row.protocol)}#vaults`}>{row.protocol}</a>
          </>
        ) : null}
      </p>
      <header className="sb-vault-head">
        <VaultChip status={row.status} failure={failure} />
        <h1 className="sb-vault-name">{title}</h1>
        <p className="sb-vault-meta">
          {row.protocol && <span>{row.protocol}</span>}
          {row.assetSymbol && <span>Asset {row.assetSymbol}</span>}
          <span className="mono break">{row.address}</span>
          <span>{chainName(row.chainId)}</span>
        </p>
        <p className="sb-verdict">{verdictSentence(row.status, report.summary, report.blockNumber, failed.map((r) => r.id))}</p>
        {traits.map((t) => (
          <p key={t.id} className="sb-trait" title={traitBasis(t)}>
            {traitLabel(t)}
            <span className="sb-trait-basis">{traitBasis(t)}</span>
          </p>
        ))}
        {skip && <p className="sb-skip">{explainSkip(skip)}</p>}
        {watch?.found && (
          <p className="sw-vault-found">
            {foundSentence(watch.found)}
            {watch.label.onList ? '' : ' It was not on the hand-made list the board started from.'}
          </p>
        )}
        <StripBig results={report.results} split={split} />
        <p className="sb-links">
          <a className="sb-btn" href={`/check?vault=${row.address}`}>
            Request a re-check
          </a>
          <span className="soft" style={{ fontSize: 13, alignSelf: 'center' }}>
            {source === 'requested'
              ? `This report comes from a check requested on ${report.startedAt.slice(0, 10)}, newer than the board build.`
              : source === 'watcher'
                ? `This report comes from a check the watcher ran on its own on ${report.startedAt.slice(0, 10)}; nobody asked for it.`
                : `Runs the same ${report.results.length} properties at the latest block and attests the new report.`}
          </span>
        </p>
      </header>

      <div className="sb-vault-grid">
        <div>
          {failed.length > 0 && (
            <section aria-labelledby="failed-h" style={{ marginBottom: 40 }}>
              <h2 className="sb-h2" id="failed-h">
                What failed
              </h2>
              <ul className="sb-finding-lines" style={{ borderTop: '1px solid var(--rule-strong)', paddingTop: 16 }}>
                {failed.map((r) => (
                  <li key={r.id}>
                    <Glyph kind="fail" />
                    <div>
                      <a href={`#p-${r.id}`} className="sb-finding-prop">
                        {r.id}
                      </a>
                      <LevelTag id={r.id} />
                      <p>{describeFailure(r.reason, r.id).finding}</p>
                      {describeFailure(r.reason, r.id).rule && <p className="sb-rule">{describeFailure(r.reason, r.id).rule}</p>}
                      {asyncFailureNote(r, traits) && <p className="sb-rule">{asyncFailureNote(r, traits)}</p>}
                      {r.counterexample && r.counterexample.calls.length > 0 && (
                        <p className="soft" style={{ fontSize: 13, marginTop: 6 }}>
                          Counterexample: <code className="break">{r.counterexample.calls[0]}</code>
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="sb-note">
                {failure === 'must'
                  ? `A spec mismatch is a disagreement with an EIP-4626 MUST sentence, shown by a concrete call.${failed.some((r) => propertyLevel(r.id) === 'should') ? ' Properties marked SHOULD go against guidance the standard recommends rather than requires.' : ''} It is not a claim that funds are at risk.`
                  : failure === 'rounding'
                    ? "Each round trip shown went in the caller's favor by the amount in its counterexample, against EIP-4626's guidance that rounding should favor the vault. That guidance is a SHOULD; no MUST sentence failed, and it is not a claim that funds are at risk."
                    : 'These properties go against EIP-4626 SHOULD sentences, shown by a concrete call; no MUST sentence failed.'}
              </p>
            </section>
          )}

          {watch && <VaultHistory watch={watch} />}

          <section aria-labelledby="props-h">
            <h2 className="sb-h2" id="props-h">
              All {report.results.length} properties
            </h2>
            <p className="sb-lede">
              In report order. Bit i is the bit the registry&apos;s passedBitmap and failedBitmap use for that property.
            </p>
            <div className="sb-table-scroll">
              <table className="sb-table sb-props">
                <thead>
                  <tr>
                    <th scope="col">Bit</th>
                    <th scope="col">Property</th>
                    <th scope="col">Result</th>
                    <th scope="col">What was found</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="sb-divider">
                    <td colSpan={4}>
                      a16z/erc4626-tests at <a href={`${report.upstream.repo}/tree/${report.upstream.commit}`}>{upstreamShort}</a>, {split} properties:{' '}
                      {split - upstreamShould} on EIP-4626 MUST sentences, {upstreamShould} on SHOULD guidance (the round trips and the allowance checks)
                    </td>
                  </tr>
                  {report.results.map((r, i) => (
                    <FragmentRow key={r.id} r={r} i={i} divider={i === split && split < report.results.length} traits={traits} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="sb-aside">
          <AttestationPanel a={row.attestation} detail={detail} />

          {subscribe}

          <section aria-labelledby="repro-h">
            <h2 className="sb-h3" id="repro-h">
              Replay this check
            </h2>
            <pre className="sb-cmd">{cmd}</pre>
            <CopyButton text={cmd} />
            <p className="soft" style={{ fontSize: 13, marginTop: 10 }}>
              {report.seed
                ? 'Same block, runs and seed. The CLI draws a fresh random sender each run; the seed also salts the 16-user pool.'
                : 'Forge did not run for this vault, so there is no seed: the check stops at its pre-checks.'}
            </p>
            <p style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <a className="sb-btn" href={row.reportPath}>
                Report JSON
              </a>
            </p>
            <p className="soft" style={{ fontSize: 13 }}>
              reportHash <span className="mono" title={detail.reportHash}>{shortHash(detail.reportHash)}</span> is keccak256 of the report&apos;s
              canonical JSON (RFC 8785), the value the registry stores.
            </p>
          </section>

          <BadgeAndApi chainId={row.chainId} address={row.address} />

          <section aria-labelledby="id-h">
            <h2 className="sb-h3" id="id-h">
              Implementation
            </h2>
            <dl className="sb-facts">
              <dt>Proxy</dt>
              <dd>{report.identity.proxy ? (report.identity.proxy.kind === 'unknown' ? 'Proxy-shaped, implementation not resolved' : report.identity.proxy.kind) : 'Not a proxy'}</dd>
              {report.identity.implementation && (
                <>
                  <dt>Implementation</dt>
                  <dd className="mono">{report.identity.implementation.address}</dd>
                </>
              )}
              <dt>Implementation key</dt>
              <dd className="mono">{report.identity.implementationKey}</dd>
              <dt>Key from</dt>
              <dd>{describeKeyKind(report.identity.implementationKeyKind)}</dd>
              <dt>Code hash</dt>
              <dd className="mono">{report.identity.codeHash}</dd>
              <dt>Code size</dt>
              <dd>{report.identity.codeSize.toLocaleString('en-US')} bytes</dd>
              <dt>Same key</dt>
              <dd>{row.groupSize > 1 ? `${row.groupSize - 1} other vaults on this board` : 'No other vault on this board'}</dd>
            </dl>
          </section>

          <section aria-labelledby="run-h">
            <h2 className="sb-h3" id="run-h">
              Run
            </h2>
            <dl className="sb-facts">
              <dt>Block</dt>
              <dd>
                {formatBlock(report.blockNumber)}, {chainName(report.chainId)}
              </dd>
              <dt>Seed</dt>
              <dd className="mono">{report.seed ?? 'none'}</dd>
              <dt>Sender</dt>
              <dd className="mono">{report.sender ?? 'none'}</dd>
              <dt>Runs</dt>
              <dd>{report.runs} per property</dd>
              <dt>Delta</dt>
              <dd>{report.delta} base units</dd>
              <dt>Forge</dt>
              <dd>{report.toolchain.forgeVersion ?? 'did not run'}</dd>
              <dt>forge-std</dt>
              <dd className="mono">{report.toolchain.forgeStd.commit.slice(0, 12)}</dd>
              <dt>Reject limit</dt>
              <dd>{report.toolchain.maxTestRejects}</dd>
              <dt>Harness</dt>
              <dd className="mono" title={report.harnessSha256}>
                {shortHash(report.harnessSha256)}
              </dd>
              <dt>sf properties</dt>
              <dd className="mono" title={report.sfPropertiesSha256}>
                {shortHash(report.sfPropertiesSha256)}
              </dd>
              <dt>suiteHash</dt>
              <dd className="mono" title={detail.suiteHash}>
                {shortHash(detail.suiteHash)}
              </dd>
              <dt>Started</dt>
              <dd>
                {report.startedAt.slice(0, 16).replace('T', ' ')} UTC, {Math.round(report.durationMs / 1000)} s
              </dd>
              <dt>Report</dt>
              <dd>schemaVersion {report.schemaVersion}</dd>
            </dl>
          </section>

          {detail.siblings.length > 0 && (
            <section aria-labelledby="sib-h">
              <h2 className="sb-h3" id="sib-h">
                Same implementation
              </h2>
              <p className="soft" style={{ fontSize: 13, margin: 0 }}>
                Same code, different vaults. Their results can still differ through parameters, caps and assets.
              </p>
              <ul className="sb-siblings">
                {detail.siblings.map((s) => (
                  <li key={s.id}>
                    <Glyph kind={s.status} />
                    <a href={`/v/${s.id}`}>{s.name ?? shortAddress(s.address)}</a>
                  </li>
                ))}
              </ul>
              {row.groupSize - 1 > detail.siblings.length && (
                <p className="soft" style={{ fontSize: 13 }}>
                  and {row.groupSize - 1 - detail.siblings.length} more
                </p>
              )}
            </section>
          )}
        </aside>
      </div>
    </main>
  );
}

function FragmentRow({ r, i, divider, traits }: { r: ReportResultView; i: number; divider: boolean; traits: VaultTraitView[] }) {
  const raw = rawText(r);
  return (
    <>
      {divider && (
        <tr className="sb-divider">
          <td colSpan={4}>Specfirst max-honored properties, MIT, each on one EIP-4626 MUST sentence about a max function</td>
        </tr>
      )}
      <tr id={`p-${r.id}`} data-s={r.status}>
        <td className="r soft">{i}</td>
        <td className="sb-prop-id">
          <code>{r.id}</code>
          <small>{r.test}</small>
          <LevelTag id={r.id} />
        </td>
        <td className="nowrap">
          <PropertyChip status={r.status} />
        </td>
        <td>
          <p>{explainResult(r)}</p>
          {asyncFailureNote(r, traits) && <p>{asyncFailureNote(r, traits)}</p>}
          <p className="desc">Checks: {r.description}</p>
          {raw && r.status !== 'pass' && (
            <details className="sb-raw">
              <summary>Raw result</summary>
              <pre>{raw}</pre>
            </details>
          )}
        </td>
      </tr>
    </>
  );
}

function BadgeAndApi({ chainId, address }: { chainId: number; address: string }) {
  const a = address.toLowerCase();
  const badge = `/badge/check/${chainId}/${a}.svg`;
  const api = `/api/v1/vaults/${chainId}/${a}`;
  return (
    <section aria-labelledby="embed-h">
      <h2 className="sb-h3" id="embed-h">
        Badge and API
      </h2>
      <p style={{ margin: '0 0 8px' }}>
        <img src={badge} alt="Specfirst ERC-4626 check badge" height={20} style={{ height: 20, width: 'auto' }} />
      </p>
      <p className="soft" style={{ fontSize: 13, margin: 0 }}>
        The badge and the JSON read the registry when they are loaded, so they follow new attestations without a rebuild.
      </p>
      <BadgeSnippet badgePath={badge} vaultPath={`/v/${chainId}/${a}`} />
      <p style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <a className="sb-btn" href={api}>
          JSON API
        </a>
        <a className="sb-btn" href={badge}>
          Badge SVG
        </a>
      </p>
    </section>
  );
}
