import type { FeedEventJson } from '../../lib/watch/types';
import { blockText, CHANGE_LABEL, clock, countsText, failedDiff, KIND_LABEL, priceDropSentence, secondsBetween, stamp } from '../../lib/watch/words';
import { formatDuration } from '../../lib/desk/format';
import { shortAddress, shortHash } from '../../lib/format';
import { VaultChip } from '../board/StatusChip';
import { failureLevelOf } from '../../lib/board/levels';
import { PropertyCells } from '../desk/Marks';

/**
 * One feed event. No hooks and no relative times, so the server and the browser render the same thing: the watch
 * page polls and prepends these, the vault page and the inbox list them.
 */
export function FeedItem({ e, showVault = true, fresh = false, note }: { e: FeedEventJson; showVault?: boolean; fresh?: boolean; note?: string }) {
  const name = e.label.name ?? shortAddress(e.subject);
  return (
    <li className="sw-item" data-kind={e.kind} data-ok={e.alert ? String(e.alert.ok) : undefined} data-fresh={fresh ? 'true' : undefined}>
      <time className="sw-item-time" dateTime={e.at} title={stamp(e.at)}>
        {clock(e.at)}
        <small>{e.at.slice(5, 10)}</small>
      </time>
      <span className="sw-kind" data-kind={e.kind} data-change={e.kind === 'changed' ? e.change?.kind : undefined}>
        <i aria-hidden="true" />
        {e.kind === 'changed' && e.change
          ? CHANGE_LABEL[e.change.kind]
          : e.kind === 'alerted' && e.alert
            ? e.alert.ok
              ? 'Alert sent'
              : 'Alert failed'
            : KIND_LABEL[e.kind]}
      </span>
      <div className="sw-item-body">
        {note && <p className="sw-item-note">{note}</p>}
        {showVault && (
          <p className="sw-item-vault">
            <a href={e.vaultPath} className={e.label.name ? undefined : 'mono'} title={e.subject}>
              {name}
            </a>
            {e.label.protocol && <span className="soft">{e.label.protocol}</span>}
            {!e.label.onList && (
              <span className="sw-tag" title="Not on the hand-made list the board started from">
                not on our list
              </span>
            )}
          </p>
        )}
        <Detail e={e} />
      </div>
    </li>
  );
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function TxLink({ url, hash, label = 'tx' }: { url: string | null; hash: string; label?: string }) {
  return url ? (
    <a href={url} className="mono" title={hash}>
      {label} {shortHash(hash)}
    </a>
  ) : (
    <span className="mono" title={hash}>
      {label} {shortHash(hash)}
    </span>
  );
}

function Detail({ e }: { e: FeedEventJson }) {
  switch (e.kind) {
    case 'detected':
      return (
        <p className="sw-line">
          {e.source === 'factory' ? `Created by ${e.factory?.name ?? 'a known factory'}` : capitalize(e.sourceText ?? 'a signal on chain')}
          {e.block ? ` in block ${blockText(e.block)}` : ''}
          {e.txHash && (
            <>
              {' '}
              <TxLink url={e.txUrl} hash={e.txHash} />
            </>
          )}
        </p>
      );
    case 'probe-rejected':
      return <p className="sw-line">Not checked: {e.reason ?? 'the ERC-4626 pre-check failed'}. Not retried until a new signal arrives.</p>;
    case 'queued':
      return <p className="sw-line soft">Waiting for a check: {e.sourceText ?? e.source ?? 'no reason given'}.</p>;
    case 'checked':
    case 'attested':
      return <CheckDetail e={e} />;
    case 'changed':
      return <ChangeDetail e={e} />;
    case 'alerted':
      return e.alert ? (
        <p className="sw-line">
          {e.alert.channel === 'webhook' ? 'Webhook' : 'Inbox'} delivery for subscription #{e.alert.subscriptionId}
          {e.alert.status !== null ? `, HTTP ${e.alert.status}` : ''}
          {e.alert.ok ? '.' : ', failed after the retries.'}
        </p>
      ) : null;
    case 'error':
      return <p className="sw-line sw-err">{e.reason ?? 'The watcher reported an error without a reason.'}</p>;
  }
}

function CheckDetail({ e }: { e: FeedEventJson }) {
  const c = e.check;
  return (
    <>
      {e.kind === 'attested' && e.attestation && (
        <p className="sw-line">
          <span className="sb-seal">Attestation #{e.attestation.id}</span> on Monad testnet
          {e.attestation.supersedes ? `, supersedes #${e.attestation.supersedes}` : ''} <TxLink url={e.attestation.txUrl} hash={e.attestation.txHash} />
        </p>
      )}
      {c && e.kind === 'checked' && (
        <>
          <div className="sw-result">
            <VaultChip status={c.status} failure={failureLevelOf(c.failed.map((id) => ({ id })))} />
            {c.cells ? <PropertyCells cells={c.cells} width={240} /> : null}
          </div>
          <p className="sw-line">
            {countsText(c.summary)} at block {blockText(c.block)}, {formatDuration(c.durationMs / 1000)}.{' '}
            {c.reportUrl ? <a href={c.reportUrl}>Report</a> : <span className="soft">Report file not on this server.</span>}
            {c.reportMatches === false && <span className="sw-err"> The report file does not hash to the feed&apos;s reportHash.</span>}
          </p>
          {e.sourceText && <p className="sw-line soft">Why: {e.sourceText}.</p>}
          <FoundTiming e={e} />
        </>
      )}
    </>
  );
}

/** For a vault a factory announced: its creation block against when the first check finished. */
function FoundTiming({ e }: { e: FeedEventJson }) {
  const f = e.found;
  if (!f || f.source !== 'factory' || e.source !== 'factory' || !e.check) return null;
  const created = f.deployBlock ?? f.block;
  const blocks = created ? Number(BigInt(e.check.block) - BigInt(created)) : null;
  const after = secondsBetween(f.at, e.at);
  return (
    <p className="sw-line sw-timing">
      Created in block {blockText(created)}
      {f.factory ? ` by ${f.factory.name}` : ''}. Seen at {clock(f.at)}, check finished at {clock(e.at)} UTC
      {after !== null ? `, ${formatDuration(after)} later` : ''}
      {blocks !== null && blocks >= 0 ? `, forked ${blocks.toLocaleString('en-US')} blocks after creation` : ''}.
    </p>
  );
}

function ChangeDetail({ e }: { e: FeedEventJson }) {
  const ch = e.change;
  if (!ch) return null;
  if (ch.kind === 'price-drop') {
    const units = (v: string) => BigInt(v).toLocaleString('en-US');
    return (
      <>
        <p className="sw-line">{priceDropSentence(ch)}</p>
        <p className="sw-line soft">
          convertToAssets of {ch.scale ? `${(10 ** ch.scale).toLocaleString('en-US')} shares` : 'one share'}, in the asset&apos;s base units: {units(ch.fromAssetsPerShare)} at block{' '}
          {blockText(ch.fromBlock)}, {units(ch.toAssetsPerShare)} at block {blockText(ch.toBlock)}. Seen at two blocks before it was recorded; the watcher re-checks
          the vault after a drop.
        </p>
      </>
    );
  }
  const diff = failedDiff(ch.from?.failed ?? [], ch.to.failed);
  return (
    <>
      <div className="sw-result">
        {ch.from ? (
          <>
            <VaultChip status={ch.from.status} failure={failureLevelOf(ch.from.failed.map((id) => ({ id })))} />
            <span aria-hidden="true" className="sw-arrow">
              to
            </span>
          </>
        ) : null}
        <VaultChip status={ch.to.status} failure={failureLevelOf(ch.to.failed.map((id) => ({ id })))} />
      </div>
      <p className="sw-line">{ch.from ? `${countsText(ch.from.summary)} before; ${countsText(ch.to.summary)} now.` : `${countsText(ch.to.summary)}.`}</p>
      {diff.added.length > 0 && <p className="sw-line sw-err">Now failing: {diff.added.join(', ')}</p>}
      {diff.removed.length > 0 && <p className="sw-line">No longer failing: {diff.removed.join(', ')}</p>}
    </>
  );
}
