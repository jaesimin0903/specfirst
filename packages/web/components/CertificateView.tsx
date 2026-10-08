import type { CertLookup, LineageHop } from '../lib/certStatus';
import { ZERO_ADDRESS } from '../lib/certStatus';
import type { Report } from '../lib/report';
import { CHAIN_ID, explorerAddressUrl, explorerTxUrl } from '../lib/chain';
import { statusMeta } from '../lib/statusMeta';
import { timeAgo, shortHash } from '../lib/format';
import { StatusPill } from './StatusPill';
import { InvariantLists } from './InvariantLists';
import { AuxiliaryBox } from './AuxiliaryBox';
import { ReportHashCheck } from './ReportHashCheck';

export interface CertificateViewProps {
  address: string;
  lookup: CertLookup;
  report: Report | null;
  reportUrl: string | null;
  /** True when the certificate names a reportURI whose host is not on the report host allowlist
   * (see lib/fetchReport.ts); reportUrl is null in that case and this explains why. */
  reportHostBlocked: boolean;
  forwardLineage: LineageHop[];
  backwardLineage: string[];
  issuanceTx: string | null;
  /** Fixed reference time so snapshot tests are deterministic; defaults to real "now" at request time. */
  now?: Date;
}

/**
 * Pure, synchronous rendering of the certificate page (docs/plan.md 3.10, 10/7 row: "상태 넷,
 * invariantSetHash와 propertyHash 표시, 불변식 원문, 미검증 목록 동급 크기, 보조 캠페인 칸 별도,
 * 계보 링크, 브라우저 reportHash 재계산"). Split out from app/c/[address]/page.tsx, which does the
 * async data fetching, so this component can be unit-tested directly with @testing-library/react
 * instead of through Next's async Server Component rendering pipeline.
 */
export function CertificateView({
  address,
  lookup,
  report,
  reportUrl,
  reportHostBlocked,
  forwardLineage,
  backwardLineage,
  issuanceTx,
  now,
}: CertificateViewProps) {
  if (!lookup.hasCertificate || !lookup.certificate) {
    return (
      <main className="page">
        <div className="bar">
          <span className="url">c/{address}</span>
        </div>
        <StatusPill status="none" />
        <p className="notice">No certificate has been issued for this address on Monad testnet.</p>
      </main>
    );
  }

  const cert = lookup.certificate;
  const issuedIso = new Date(Number(cert.issuedAt) * 1000).toISOString();

  return (
    <main className="page">
      <div className="bar">
        <span className="url">specfirst / c / {address}</span>
      </div>

      <div className="row header-row">
        <StatusPill status={lookup.status} />
        <span className="muted">issued {timeAgo(issuedIso, now)}</span>
      </div>

      <h1 className="h">{report?.name ?? cert.projectId}</h1>

      <dl className="meta-list">
        <div>
          <dt>address</dt>
          <dd>
            {address}, monad-testnet ({CHAIN_ID})
          </dd>
        </div>
        <div>
          <dt>spec</dt>
          <dd>{cert.specHash}</dd>
        </div>
        <div>
          <dt>invariant set</dt>
          <dd>{cert.invariantSetHash}</dd>
        </div>
        <div>
          <dt>property</dt>
          <dd>{cert.propertyHash}</dd>
        </div>
        <div>
          <dt>code</dt>
          <dd>{cert.codeHash}</dd>
        </div>
      </dl>

      {lookup.status === 'superseded' && cert.supersededBy !== ZERO_ADDRESS && (
        <p className="notice warn">
          A newer version of this project is certified at{' '}
          <a href={`/c/${cert.supersededBy}`}>{cert.supersededBy}</a>. This address remains certified: its code has not
          changed since it was verified.
        </p>
      )}
      {lookup.status === 'revoked' && <p className="notice bad">This certificate was revoked. It no longer counts as certified.</p>}
      {lookup.status === 'partial' && (
        <p className="notice warn">
          Partial certificate: only {cert.passedCount} of {cert.totalCount} invariants passed. A partial certificate never
          replaces a complete earlier one.
        </p>
      )}

      <InvariantLists invariants={report?.invariants ?? []} unverified={report?.unverified ?? []} />

      <div className="grid-2">
        <div className="box">
          <div className="box-label">Fuzzing</div>
          <div>
            {report?.fuzz ? `${report.fuzz.runs} runs, depth ${report.fuzz.depth}` : 'summary not available'}
            {report?.iterations !== undefined ? `, ${report.iterations} fix iteration${report.iterations === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        <div className="box">
          <div className="box-label">Post-deploy verification</div>
          <div>
            {cert.rehearsalTxCount} rehearsal tx, {cert.passedCount}/{cert.totalCount} invariants held
            {report?.verifyMethod ? ` (${report.verifyMethod})` : ''}
          </div>
        </div>
      </div>

      <AuxiliaryBox auxiliary={report?.auxiliary} />

      {(forwardLineage.length > 0 || backwardLineage.length > 0) && (
        <div className="box">
          <div className="box-label">Lineage</div>
          <ul className="plain-list">
            {backwardLineage.map((a) => (
              <li key={`back-${a}`}>
                <a href={`/c/${a}`}>{a}</a> (earlier version)
              </li>
            ))}
            <li>
              <strong>{address}</strong> (this page)
            </li>
            {forwardLineage.map((hop) => (
              <li key={`fwd-${hop.address}`}>
                <a href={`/c/${hop.address}`}>{hop.address}</a> ({statusMeta(hop.status).label.toLowerCase()})
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="row actions">
        <a className="btn" href={issuanceTx ? explorerTxUrl(issuanceTx) : explorerAddressUrl(address)} target="_blank" rel="noreferrer">
          {issuanceTx ? 'issuance transaction' : 'view on explorer'}
        </a>
        {reportUrl && (
          <a className="btn" href={reportUrl} target="_blank" rel="noreferrer" title={reportUrl !== cert.reportURI ? `reportURI on chain: ${cert.reportURI}` : undefined}>
            report.json
          </a>
        )}
        {reportHostBlocked ? <span className="hash-check bad">report host not allowed</span> : <ReportHashCheck reportUrl={reportUrl} onChainHash={cert.reportHash} />}
      </div>

      <p className="muted small">report hash {shortHash(cert.reportHash)}</p>
    </main>
  );
}
