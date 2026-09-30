import type { PrecheckResult } from '../../lib/desk/precheck';
import { VAULT_STATUS_LABEL, formatBlock } from '../../lib/board/reasons';
import { Glyph } from '../board/Glyph';
import { Dot } from './Marks';

function assetsLine(p: PrecheckResult): string | null {
  const c = p.contract;
  if (!c?.totalAssets || c.assetDecimals === null) return null;
  const v = BigInt(c.totalAssets);
  const unit = 10n ** BigInt(c.assetDecimals);
  const whole = v / unit;
  return `${whole.toLocaleString('en-US')} ${c.assetSymbol ?? 'units'} held`;
}

/** What the pre-check found, before anyone pays. */
export function PrecheckCard({ p }: { p: PrecheckResult }) {
  const c = p.contract;
  const title = c?.name ?? c?.symbol ?? p.address ?? p.input;
  const held = assetsLine(p);
  return (
    <div className="sb-found" aria-live="polite">
      {c?.isContract ? (
        <>
          <p className="sb-found-name">{title}</p>
          <p className="sb-found-meta">
            {c.protocol && <span>{c.protocol}</span>}
            {c.symbol && c.symbol !== title && <span>{c.symbol}</span>}
            {c.assetSymbol && <span>Asset {c.assetSymbol}</span>}
            {held && <span>{held}</span>}
            <span className="mono break">{p.address}</span>
          </p>
        </>
      ) : null}
      <ul className="sb-found-list">
        {c?.isContract && (
          <li>
            {c.asset ? <Dot s="done" /> : <Dot s="failed" />}
            <span>{c.asset ? 'Answers asset() like an ERC-4626 vault on Monad mainnet.' : 'Does not answer asset().'}</span>
          </li>
        )}
        {p.latestReport ? (
          <li>
            <Glyph kind={p.latestReport.status} />
            <span>
              {p.latestReport.source === 'board' ? 'On the board: ' : 'Checked on request: '}
              <a href={`/v/${p.chainId}/${p.address!.toLowerCase()}`}>{VAULT_STATUS_LABEL[p.latestReport.status]}</a> at block {formatBlock(p.latestReport.blockNumber)},{' '}
              {p.latestReport.summary.pass} pass, {p.latestReport.summary.fail} fail.
            </span>
          </li>
        ) : (
          c?.isContract && (
            <li>
              <Dot s="waiting" />
              <span>Not checked by Specfirst yet. Your request adds it to the site.</span>
            </li>
          )
        )}
        {p.attestation?.kind === 'attested' && (
          <li>
            <Dot s="sealed" />
            <span>
              Attestation #{p.attestation.id} on Monad testnet, {p.attestation.status.toLowerCase()}
              {p.attestation.isCompliant === true ? ', compliant' : p.attestation.isCompliant === false ? ', not compliant' : ''}, block{' '}
              {formatBlock(p.attestation.blockNumber)}.
            </span>
          </li>
        )}
        {p.attestation?.kind === 'none' && c?.isContract && (
          <li>
            <Dot s="waiting" />
            <span>No attestation in the registry yet.</span>
          </li>
        )}
        {p.pending.length > 0 && (
          <li>
            <Dot s="active" />
            <span>
              Request <a href={`/check/${p.pending[0]!.id}`}>#{p.pending[0]!.id}</a> for this vault is in progress
              {p.pending[0]!.stage ? ` (${p.pending[0]!.stage})` : ''}.
            </span>
          </li>
        )}
      </ul>
      {p.notes.map((n) => (
        <p key={n} className="soft" style={{ fontSize: 13.5, margin: '10px 0 0' }}>
          {n}
        </p>
      ))}
      {p.blockers.map((b) => (
        <p key={b} className="sb-blocker" role="alert">
          {b}
        </p>
      ))}
    </div>
  );
}
