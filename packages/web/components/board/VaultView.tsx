import type { AttestationView, ReportResultView, VaultDetail } from '../../lib/board/types';
import {
  describeKeyKind,
  effectiveSkipReason,
  describeFailure,
  explainResult,
  explainSkip,
  formatBlock,
  verdictSentence,
} from '../../lib/board/reasons';
import { addressUrl, txUrl } from '../../lib/board/attestations';
import { shortAddress, shortHash } from '../../lib/format';
import { PropertyChip, VaultChip } from './StatusChip';
import { Glyph } from './Glyph';
import { CopyButton } from './CopyButton';

const CHAIN_NAME: Record<number, string> = { 143: 'Monad mainnet', 10143: 'Monad testnet', 31337: 'anvil' };
const NETWORK_FLAG: Record<number, string> = { 10143: ' --network monad-testnet', 31337: ' --network anvil' };

export function chainName(chainId: number): string {
  return CHAIN_NAME[chainId] ?? `chain ${chainId}`;
}

/** The arguments of `specfirst check` that replay a report: recorded block, runs, seed and (when not 0) delta. */
export function reproduceArgs(r: VaultDetail['report']): string[] {
  const args = [`specfirst check ${r.address}`, `--standard ${r.standard}`, `--block ${r.blockNumber}`, `--runs ${r.runs}`];
  if (r.seed) args.push(`--seed ${r.seed}`);
  if (r.delta !== '0') args.push(`--delta ${r.delta}`);
  const net = NETWORK_FLAG[r.chainId];
  if (net) args.push(net.trim());
  return args;
}

/** One line, as the README and ADR 0004 write it. */
export function reproduceCommand(r: VaultDetail['report']): string {
  return reproduceArgs(r).join(' ');
}

/** The same command over several lines with shell continuations, for the page and the copy button. */
export function reproduceCommandMultiline(r: VaultDetail['report']): string {
  return reproduceArgs(r).join(' \\\n  ');
}

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

export function VaultView({ detail }: { detail: VaultDetail }) {
  const { row, report } = detail;
  const split = report.results.filter((r) => !r.id.startsWith('sf-')).length;
  const skip = effectiveSkipReason(report);
  const failed = report.results.filter((r) => r.status === 'fail');
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
        <VaultChip status={row.status} />
        <h1 className="sb-vault-name">{title}</h1>
        <p className="sb-vault-meta">
          {row.protocol && <span>{row.protocol}</span>}
          {row.assetSymbol && <span>Asset {row.assetSymbol}</span>}
          <span className="mono break">{row.address}</span>
          <span>{chainName(row.chainId)}</span>
        </p>
        <p className="sb-verdict">{verdictSentence(row.status, report.summary, report.blockNumber)}</p>
        {skip && <p className="sb-skip">{explainSkip(skip)}</p>}
        <StripBig results={report.results} split={split} />
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
                      <p>{describeFailure(r.reason).finding}</p>
                      {describeFailure(r.reason).rule && <p className="sb-rule">{describeFailure(r.reason).rule}</p>}
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
                A spec mismatch is a disagreement with an EIP-4626 MUST sentence, shown by a concrete call. It is not a claim that funds are at risk.
              </p>
            </section>
          )}

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
                      a16z/erc4626-tests at <a href={`${report.upstream.repo}/tree/${report.upstream.commit}`}>{upstreamShort}</a>, {split} properties
                    </td>
                  </tr>
                  {report.results.map((r, i) => (
                    <FragmentRow key={r.id} r={r} i={i} divider={i === split && split < report.results.length} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <aside className="sb-aside">
          <AttestationPanel a={row.attestation} detail={detail} />

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

function FragmentRow({ r, i, divider }: { r: ReportResultView; i: number; divider: boolean }) {
  const raw = rawText(r);
  return (
    <>
      {divider && (
        <tr className="sb-divider">
          <td colSpan={4}>Specfirst max-honored properties, MIT, one EIP-4626 MUST sentence each</td>
        </tr>
      )}
      <tr id={`p-${r.id}`} data-s={r.status}>
        <td className="r soft">{i}</td>
        <td className="sb-prop-id">
          <code>{r.id}</code>
          <small>{r.test}</small>
        </td>
        <td className="nowrap">
          <PropertyChip status={r.status} />
        </td>
        <td>
          <p>{explainResult(r)}</p>
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
