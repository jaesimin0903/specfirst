import { formatUnits } from 'viem';
import { GATE_VERDICT_TEXT, type GateVerdict } from '../../lib/gate/contract';
import type { GateEventJson, GatePageJson, GateVaultJson, GateViewJson } from '../../lib/gate/types';
import { formatDuration } from '../../lib/desk/format';
import { testnetAddressUrl, testnetTxUrl } from '../../lib/desk/config';
import { shortAddress, shortHash } from '../../lib/format';
import { Glyph } from '../board/Glyph';

/** "1,234.5": token units with at most 4 fraction digits; "<0.0001" for a dust amount that is not zero. */
export function formatTokens(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const [whole = '0', frac = ''] = formatUnits(v, decimals).split('.');
  const cut = frac.slice(0, 4).replace(/0+$/, '');
  if (v > 0n && whole === '0' && !cut) return '<0.0001';
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cut ? `.${cut}` : ''}`;
}

function Addr({ a }: { a: string }) {
  return (
    <a href={testnetAddressUrl(a)} className="mono" title={a}>
      {shortAddress(a)}
    </a>
  );
}

function Tx({ hash }: { hash: string }) {
  return (
    <a href={testnetTxUrl(hash)} className="mono">
      {shortHash(hash)}
    </a>
  );
}

const VERDICT_LABEL: Readonly<Record<GateVerdict, string>> = {
  Compliant: 'Compliant',
  Stale: 'Stale',
  NoAttestation: 'No attestation',
  NotCompliant: 'Not compliant',
  UntrustedIssuer: 'Issuer removed',
  CodeMismatch: 'Other code',
};

export function VerdictChip({ verdict }: { verdict: GateVerdict | null }) {
  if (!verdict) return <span className="soft">not read</span>;
  const s = verdict === 'Compliant' ? 'pass' : verdict === 'Stale' ? 'inconclusive' : 'fail';
  return (
    <span className="sb-chip" data-s={s} title={GATE_VERDICT_TEXT[verdict]}>
      <Glyph kind={s} />
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function AttestationCell({ v, now }: { v: GateVaultJson; now: bigint }) {
  const a = v.attestation;
  if (!a) return <span className="soft">none</span>;
  const age = Number(now - BigInt(a.issuedAt));
  return (
    <>
      #{a.id} {a.status.toLowerCase()}
      <span className="sb-vault-sub">
        {a.passCount} pass, {a.failCount} fail, {a.inconclusiveCount} inconclusive, {a.notApplicableCount} n/a; {formatDuration(age)} ago
      </span>
      <span className="sb-vault-sub">
        by <Addr a={a.issuer} />
        {a.issuerAllowed === false ? ', no longer an issuer' : ''}
        {v.compliant !== null ? `; isCompliant ${v.compliant}` : ''}
      </span>
    </>
  );
}

function eventLine(e: GateEventJson, d: number): string {
  switch (e.kind) {
    case 'Allocated':
      return `${formatTokens(e.assets, d)} allocated for ${formatTokens(e.shares, d)} shares, attestation #${e.attestationId}`;
    case 'Exited':
      return `${formatTokens(e.assets, d)} back by ${e.path.toLowerCase()} of ${formatTokens(e.shares, d)} shares; verdict ${VERDICT_LABEL[e.verdict].toLowerCase()}, attestation #${e.attestationId}`;
    case 'ExitFailed':
      return `the vault refused redeem (${e.redeemError}) and withdraw (${e.withdrawError}); ${formatTokens(e.shares, d)} shares stay`;
    case 'IdleWithdrawn':
      return `${formatTokens(e.amount, d)} idle withdrawn by the owner`;
  }
}

function Events({ view }: { view: GateViewJson }) {
  if (view.events.length === 0) return <p className="sb-empty">No gate events in the latest 100 blocks or in the blocks of each vault's last allocation and exit.</p>;
  return (
    <div className="sb-table-scroll">
      <table className="sb-table">
        <thead>
          <tr>
            <th scope="col">Block</th>
            <th scope="col">Event</th>
            <th scope="col">Vault</th>
            <th scope="col">What happened</th>
            <th scope="col">Tx</th>
          </tr>
        </thead>
        <tbody>
          {view.events.map((e) => (
            <tr key={`${e.txHash}:${e.logIndex}`}>
              <td className="nowrap">{Number(e.blockNumber).toLocaleString('en-US')}</td>
              <td>{e.kind}</td>
              <td>{'vault' in e ? <Addr a={e.vault} /> : <span className="soft">none</span>}</td>
              <td>
                {eventLine(e, view.assetDecimals)}
                {'caller' in e && e.caller.toLowerCase() !== view.owner.toLowerCase() ? (
                  <span className="sb-vault-sub">
                    called by <Addr a={e.caller} />, not the owner
                  </span>
                ) : null}
              </td>
              <td>
                <Tx hash={e.txHash} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Positions({ view }: { view: GateViewJson }) {
  const d = view.assetDecimals;
  const now = BigInt(view.now);
  if (view.vaults.length === 0) return <p className="sb-empty">The gate has not allocated to any vault yet.</p>;
  return (
    <div className="sb-table-scroll">
      <table className="sb-table">
        <thead>
          <tr>
            <th scope="col">Vault</th>
            <th scope="col">Verdict</th>
            <th scope="col">Latest attestation</th>
            <th scope="col" className="r">
              Shares held
            </th>
            <th scope="col" className="r">
              In
            </th>
            <th scope="col" className="r">
              Out
            </th>
            <th scope="col">Exit</th>
          </tr>
        </thead>
        <tbody>
          {view.vaults.map((v) => (
            <tr key={v.vault}>
              <td>
                <Addr a={v.vault} />
              </td>
              <td>
                <VerdictChip verdict={v.verdict} />
              </td>
              <td>
                <AttestationCell v={v} now={now} />
              </td>
              <td className="r">{formatTokens(v.shares, d)}</td>
              <td className="r">{formatTokens(v.assetsIn, d)}</td>
              <td className="r">{formatTokens(v.assetsOut, d)}</td>
              <td>{v.canExit ? <strong>open to anyone</strong> : BigInt(v.shares) === 0n ? <span className="soft">nothing held</span> : <span className="soft">closed</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** /watch/gate: the demo AllocationGate, read from Monad testnet at request time. */
export function GateView({ data }: { data: GatePageJson }) {
  if (!data.deployed) {
    return (
      <section className="sb-section">
        <p className="sb-empty">
          No allocation gate is deployed on Monad testnet yet (NEXT_PUBLIC_SPECFIRST_GATE_10143 is not set). The contract and the commands that deploy it are in the
          repository: <span className="mono">specfirst watch demo gate deploy</span>.
        </p>
      </section>
    );
  }
  if (!data.view) {
    return (
      <section className="sb-section">
        <p className="sb-empty">
          Could not read the gate at <Addr a={data.address} />: {data.error}
        </p>
      </section>
    );
  }
  const v = data.view;
  const unit = v.assetSymbol ?? 'tokens';
  return (
    <>
      <section className="sb-section" aria-labelledby="gate-h">
        <h2 className="sb-h2" id="gate-h">
          The gate
        </h2>
        <dl className="sb-facts">
          <dt>Gate</dt>
          <dd>
            <Addr a={v.address} />
          </dd>
          <dt>Reads</dt>
          <dd>
            <Addr a={v.registry} /> (CheckAttestationRegistry), erc4626 attestations of chain {v.subjectChainId}
          </dd>
          <dt>Asset</dt>
          <dd>
            <Addr a={v.asset} /> {unit}
          </dd>
          <dt>Owner</dt>
          <dd>
            <Addr a={v.owner} />
          </dd>
          <dt>Fresh for</dt>
          <dd>{formatDuration(Number(v.maxAttestationAge))} after an attestation is issued</dd>
          <dt>Idle</dt>
          <dd>
            {formatTokens(v.idle, v.assetDecimals)} {unit}
          </dd>
          <dt>Read at</dt>
          <dd>block {Number(v.head).toLocaleString('en-US')}</dd>
        </dl>
      </section>
      <section className="sb-section" aria-labelledby="pos-h">
        <h2 className="sb-h2" id="pos-h">
          Positions
        </h2>
        <p className="sb-lede">
          The owner can allocate only into a vault whose verdict is Compliant. Once a vault is anything but Compliant or Stale, anyone can call exit and the
          gate redeems its shares; amounts are in {unit}.
        </p>
        <Positions view={v} />
      </section>
      <section className="sb-section" aria-labelledby="ev-h">
        <h2 className="sb-h2" id="ev-h">
          Recent events
        </h2>
        <Events view={v} />
      </section>
      {v.errors.length > 0 && (
        <section className="sb-section">
          <p className="sb-note">Some reads failed, so parts of this page are missing:</p>
          <ul className="sb-note">
            {v.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
