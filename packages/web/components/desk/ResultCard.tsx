import type { ResultJson } from '../../lib/desk/types';
import { verdictSentence } from '../../lib/board/reasons';
import { testnetTxUrl } from '../../lib/desk/config';
import { shortHash } from '../../lib/format';
import { VaultChip } from '../board/StatusChip';
import { Glyph } from '../board/Glyph';
import { CopyButton } from '../board/CopyButton';
import { PropertyCells } from './Marks';
import { apiCurl, badgeHtml, badgeMarkdown } from '../../lib/desk/snippets';

/** What a fulfilled request delivered: result, attestation, badge, API. */
export function ResultCard({ result, origin }: { result: ResultJson; origin: string }) {
  const badge = { markdown: badgeMarkdown(origin, result.badgePath, result.vaultPath), html: badgeHtml(origin, result.badgePath, result.vaultPath) };
  const api = apiCurl(origin, result.apiPath);
  const a = result.attestation;
  return (
    <article className="sb-result" data-status={result.status} aria-labelledby="result-h">
      <VaultChip status={result.status} />
      <h2 className="sb-h2" id="result-h">
        The result
      </h2>
      <p className="sb-verdict">{verdictSentence(result.status, result.summary, result.blockNumber)}</p>
      <PropertyCells cells={result.cells} split={result.split} width={420} />

      {result.failed.length > 0 && (
        <div className="sb-panel" style={{ marginTop: 16 }}>
          <h3>What failed</h3>
          <ul className="sb-finding-lines">
            {result.failed.map((f) => (
              <li key={f.id}>
                <Glyph kind="fail" />
                <div>
                  <span className="sb-finding-prop">{f.id}</span>
                  <p>{f.finding}</p>
                  {f.rule && <p className="sb-rule">{f.rule}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="sb-links">
        <a className="sb-action" href={result.vaultPath}>
          Open the vault page
        </a>
        {result.reportPath && (
          <a className="sb-action" data-kind="quiet" href={result.reportPath}>
            Report JSON
          </a>
        )}
      </p>

      <div className="sb-panel" style={{ marginTop: 20 }}>
        <h3>Onchain attestation</h3>
        {a ? (
          <>
            <p style={{ margin: 0 }}>
              <span className="sb-seal">Attestation #{a.id}</span> {a.status}
              {a.isCompliant === true ? ', isCompliant true' : a.isCompliant === false ? ', isCompliant false' : ''}.
            </p>
            <p className="soft" style={{ fontSize: 13.5, margin: '6px 0 0' }}>
              {a.matchesReport
                ? 'The reportHash stored onchain is the hash of the report above, so anyone can check the two match.'
                : 'The attestation records a different report than the one shown; the vault page has the details.'}
            </p>
            {a.txHash && (
              <p style={{ margin: '8px 0 0', fontSize: 13.5 }}>
                <a href={testnetTxUrl(a.txHash)} className="mono" title={a.txHash}>
                  Attest tx {shortHash(a.txHash)} on testnet.monadscan.com
                </a>
              </p>
            )}
          </>
        ) : (
          <p className="soft" style={{ margin: 0 }}>
            The attestation could not be read just now. The vault page reads it again.
          </p>
        )}
      </div>

      <div className="sb-panel">
        <h3>Badge</h3>
        <div className="sb-badge-preview">
          <img src={result.badgePath} alt="Specfirst ERC-4626 check badge for this vault" />
          <span className="soft" style={{ fontSize: 13 }}>
            Reads the registry each time it loads, so it changes when the vault is attested again.
          </span>
        </div>
        <pre className="sb-snippet">{badge.markdown}</pre>
        <CopyButton text={badge.markdown} label="Copy Markdown" />{' '}
        <CopyButton text={badge.html} label="Copy HTML" />
      </div>

      <div className="sb-panel">
        <h3>API</h3>
        <p className="soft" style={{ fontSize: 13.5, margin: 0 }}>
          The latest report summary, the four max-honored flags a router can gate on, and the attestation read live.
        </p>
        <pre className="sb-snippet">{api}</pre>
        <CopyButton text={api} label="Copy command" />
      </div>

      <div className="sb-panel">
        <h3>Replay it yourself</h3>
        <pre className="sb-snippet">{result.reproduce}</pre>
        <CopyButton text={result.reproduce} />
        <p className="soft" style={{ fontSize: 13, marginTop: 8 }}>
          Report hash <span className="mono" title={result.reportHash}>{shortHash(result.reportHash)}</span>, block {result.blockNumber}.
        </p>
      </div>
    </article>
  );
}
