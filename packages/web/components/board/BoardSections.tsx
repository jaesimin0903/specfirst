import type { BoardData, VaultRow, VaultStatus } from '../../lib/board/types';
import { describeFailure, formatBlock, isNotApplicableCategory, REASON_DETAIL, REASON_LABEL, VAULT_STATUS_LABEL } from '../../lib/board/reasons';
import { shortAddress } from '../../lib/format';
import { Glyph } from './Glyph';
import { FilterLink } from './FilterLink';
import { LevelTag } from './StatusChip';
import { classifyFailure, failureLevelOf } from '../../lib/board/levels';

/** Vaults whose only failures are round trips: no MUST sentence failed, rounding favors the caller. */
function roundingOnly(rows: ReadonlyArray<Pick<VaultRow, 'status' | 'failed'>>): number {
  return rows.filter((r) => r.status === 'mismatch' && failureLevelOf(r.failed) === 'rounding').length;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function blockPhrase(board: BoardData): string {
  if (board.blocks.length === 0) return 'no block yet';
  if (board.blocks.length === 1) return `at Monad block ${formatBlock(board.blocks[0]!.blockNumber)}`;
  return `across ${board.blocks.length} blocks`;
}

export function Hero({ board }: { board: BoardData }) {
  const t = board.totals;
  const total = board.properties.length || 30;
  const upstream = board.properties.filter((p) => p.origin === 'upstream').length || 26;
  const runs = board.runs.length === 1 ? `${board.runs[0]} fuzz runs` : board.runs.length > 1 ? `${board.runs[0]} to ${board.runs[board.runs.length - 1]} fuzz runs` : 'fuzz runs';
  return (
    <header className="sb-hero">
      <h1 className="sb-claim">Every ERC-4626 vault on Monad, checked against public properties nobody wrote for themselves.</h1>
      {t.vaults === 0 ? (
        <p className="sb-sub">No check reports have been loaded into this board yet.</p>
      ) : (
      <p className="sb-sub">
        <strong>{plural(t.vaults, 'vault')}</strong> forked {blockPhrase(board)} and run through {upstream} properties from{' '}
        <a href="https://github.com/a16z/erc4626-tests">a16z/erc4626-tests</a> plus {total - upstream} of Specfirst&apos;s own, {runs} each. Results are
        attested on Monad testnet and anyone can replay them from the recorded block and seed. A pass means no counterexample was found, not that a
        vault is safe.
      </p>
      )}
    </header>
  );
}

export function MatrixLegend() {
  return (
    <>
      <ul className="sb-legend" aria-label="Legend">
        <li>
          <Glyph kind="pass" /> Pass
        </li>
        <li>
          <Glyph kind="fail" /> Fail
        </li>
        <li>
          <Glyph kind="inconclusive" /> Inconclusive
        </li>
        <li>
          <Glyph kind="not_applicable" /> Not applicable
        </li>
      </ul>
      <p className="sb-caption">
        Each column is one vault and each row one property, in the order the registry&apos;s bitmaps record them. Columns are grouped by implementation,
        so a factory&apos;s vaults sit side by side.
      </p>
    </>
  );
}

export function Figures({ board }: { board: BoardData }) {
  const t = board.totals;
  const total = board.properties.length || 30;
  return (
    <div className="sb-figures">
      <FilterLink filters={{}} className="sb-figure">
        <span className="sb-figure-n">{t.vaults}</span>
        <span className="sb-figure-label">vaults checked</span>
        <span className="sb-figure-note">
          {blockPhrase(board)}
          {t.unchecked > 0 ? `; ${t.unchecked} more known, not checked yet` : ''}
        </span>
      </FilterLink>
      <FilterLink filters={{}} view="implementations" className="sb-figure">
        <span className="sb-figure-n">{t.implementations}</span>
        <span className="sb-figure-label">distinct implementations</span>
        <span className="sb-figure-note">vaults on the same code count once</span>
      </FilterLink>
      <FilterLink filters={{ status: 'complete' }} className="sb-figure">
        <span className="sb-figure-n">{t.complete}</span>
        <span className="sb-figure-label">
          <Glyph kind="complete" /> passed all {total}
        </span>
        <span className="sb-figure-note">no counterexample, not a guarantee</span>
      </FilterLink>
      <FilterLink filters={{ status: 'mismatch' }} className="sb-figure" data-tone={t.mismatch > 0 ? 'fail' : undefined}>
        <span className="sb-figure-n">{t.mismatch}</span>
        <span className="sb-figure-label">
          <Glyph kind="mismatch" /> spec mismatches
        </span>
        <span className="sb-figure-note">
          in {plural(t.mismatchImplementations, 'implementation')}
          {roundingOnly(board.vaults) > 0 ? `; ${roundingOnly(board.vaults)} of them only round trips, a SHOULD` : ''}
        </span>
      </FilterLink>
      <FilterLink filters={{ status: 'partial' }} className="sb-figure">
        <span className="sb-figure-n">{t.partial}</span>
        <span className="sb-figure-label">
          <Glyph kind="partial" /> partly checked
        </span>
        <span className="sb-figure-note">no fail, some properties not exercised</span>
      </FilterLink>
      <FilterLink filters={{ status: 'not_applicable' }} className="sb-figure">
        <span className="sb-figure-n">{t.notApplicable}</span>
        <span className="sb-figure-label">
          <Glyph kind="not_applicable" /> not applicable
        </span>
        <span className="sb-figure-note">the suites cannot run on them</span>
      </FilterLink>
    </div>
  );
}

function vaultTitle(r: Pick<VaultRow, 'name' | 'address'>): string {
  return r.name ?? shortAddress(r.address);
}

export function Findings({ board }: { board: BoardData }) {
  const rows = board.vaults.filter((r) => r.status === 'mismatch');
  const groups = new Map(board.groups.map((g) => [g.key, g]));
  const sfOnly = rows.length > 0 && rows.every((r) => r.failed.every((f) => f.id.startsWith('sf-')));
  return (
    <section className="sb-section" aria-labelledby="findings-h">
      <h2 className="sb-h2" id="findings-h">
        Where vaults disagree with EIP-4626
      </h2>
      <p className="sb-lede">
        A spec mismatch means a property failed with a concrete counterexample.{' '}
        {sfOnly
          ? "Every failure below comes from Specfirst's max-honored properties: the vault's own maxDeposit, maxMint, maxWithdraw or maxRedeem promised an amount that the matching call then refused."
          : "Failures from Specfirst's max-honored properties mean the vault's own maxDeposit, maxMint, maxWithdraw or maxRedeem promised an amount that the matching call then refused."}{' '}
        Software that trusts those values, such as aggregators and routers, gets a revert where the standard promised success. Each failure names
        its level: a MUST sentence of EIP-4626, or SHOULD guidance such as the round trips, where rounding favors the caller instead of the vault and
        no MUST sentence failed. These are disagreements with the specification, not reports of lost funds.
      </p>
      {rows.length === 0 ? (
        <p className="sb-empty">No property failed on any vault in this data.</p>
      ) : (
        <ol className="sb-findings">
          {rows.map((r) => {
            const g = groups.get(r.implementationKey);
            const others = g ? g.vaultIds.length - 1 : 0;
            const othersMismatch = g ? g.statusCounts.mismatch - 1 : 0;
            return (
              <li key={r.id} className="sb-finding">
                <div className="sb-finding-vault">
                  <a href={`/v/${r.id}`}>{vaultTitle(r)}</a>
                  <p className="sb-finding-meta">
                    {[r.protocol, r.assetSymbol].filter(Boolean).join(', ')}
                    {r.protocol || r.assetSymbol ? ', ' : ''}
                    <span className="mono">{shortAddress(r.address)}</span>
                  </p>
                  {others > 0 && (
                    <p className="sb-finding-group">
                      Same implementation as {plural(others, 'other vault')} on this board;{' '}
                      {othersMismatch === 0 ? 'none of them fail' : `${othersMismatch} of them fail too`}.
                    </p>
                  )}
                </div>
                <ul className="sb-finding-lines">
                  {r.failed.map((f) => {
                    const { finding, rule } = describeFailure(f.reason, f);
                    return (
                      <li key={f.id}>
                        <Glyph kind="fail" />
                        <div>
                          <span className="sb-finding-prop">{f.id}</span>
                          <LevelTag level={classifyFailure(f).level} />
                          <p>{finding}</p>
                          {rule && <p className="sb-rule">{rule}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </li>
            );
          })}
        </ol>
      )}
      <p className="sb-note">
        Error names such as WithdrawalRequestRequired() are matched from the 4-byte revert selector against known signatures; the reports themselves
        record only the selector.
      </p>
    </section>
  );
}

export function ReasonBars({ board }: { board: BoardData }) {
  const total = Math.max(board.totals.vaults, 1);
  return (
    <div>
      <h2 className="sb-h2">Why some properties were not exercised</h2>
      <p className="sb-lede">
        Inconclusive and not applicable never count as a pass. Counted per vault; one vault can appear under more than one reason.
      </p>
      {board.reasons.length === 0 ? (
        <p className="sb-empty">Every property ran on every vault.</p>
      ) : (
        <ul className="sb-bars">
          {board.reasons.map((r) => (
            <li key={r.category}>
              <div className="sb-bars-head">
                <span>
                  <Glyph kind={isNotApplicableCategory(r.category) ? 'not_applicable' : 'inconclusive'} /> {REASON_LABEL[r.category]}
                </span>
                <span>
                  {plural(r.vaults, 'vault')}, {plural(r.properties, 'property', 'properties')}
                </span>
              </div>
              <span className="sb-bar" data-kind={isNotApplicableCategory(r.category) ? 'na' : 'open'} aria-hidden="true">
                <span style={{ width: `${(r.vaults / total) * 100}%` }} />
              </span>
              <p className="sb-note" style={{ marginTop: 6 }}>
                {REASON_DETAIL[r.category]}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DIST_ORDER: VaultStatus[] = ['mismatch', 'complete', 'partial', 'not_applicable'];

export function Distribution({ counts, total }: { counts: Record<VaultStatus, number>; total: number }) {
  const label = DIST_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${VAULT_STATUS_LABEL[s].toLowerCase()}`)
    .join(', ');
  return (
    <span className="sb-dist" role="img" aria-label={label}>
      {DIST_ORDER.map((s) => (counts[s] > 0 ? <span key={s} className={`d-${s}`} style={{ width: `${(counts[s] / Math.max(total, 1)) * 100}%` }} /> : null))}
    </span>
  );
}

export function ProtocolTable({ board }: { board: BoardData }) {
  return (
    <div>
      <h2 className="sb-h2">By protocol</h2>
      <p className="sb-lede">Implementations counts distinct code, so a protocol that deploys from one factory shows 1 however many vaults it has.</p>
      <div className="sb-table-scroll">
        <table className="sb-table">
          <thead>
            <tr>
              <th scope="col">Protocol</th>
              <th scope="col" className="r">
                Vaults
              </th>
              <th scope="col" className="r">
                Impl.
              </th>
              <th scope="col">Results</th>
              <th scope="col" className="r">
                Mismatch
              </th>
              <th scope="col" className="r">
                All passed
              </th>
              <th scope="col" className="r">
                Partly
              </th>
              <th scope="col" className="r">
                N/A
              </th>
            </tr>
          </thead>
          <tbody>
            {board.protocols.map((p) => (
              <tr key={p.protocol}>
                <td style={{ minWidth: 150 }}>
                  <FilterLink filters={{ protocol: p.protocol }}>{p.protocol}</FilterLink>
                </td>
                <td className="r">{p.vaults}</td>
                <td className="r">{p.implementations}</td>
                <td style={{ minWidth: 140 }}>
                  <Distribution counts={p.statusCounts} total={p.vaults} />
                </td>
                <td className={`r ${p.statusCounts.mismatch ? 'hot' : 'zero'}`}>{p.statusCounts.mismatch}</td>
                <td className={`r ${p.statusCounts.complete ? '' : 'zero'}`}>{p.statusCounts.complete}</td>
                <td className={`r ${p.statusCounts.partial ? '' : 'zero'}`}>{p.statusCounts.partial}</td>
                <td className={`r ${p.statusCounts.not_applicable ? '' : 'zero'}`}>{p.statusCounts.not_applicable}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function MethodSummary({ board }: { board: BoardData }) {
  const runs = board.runs.length ? board.runs.join(' or ') : 'the recorded number of';
  return (
    <section className="sb-section" aria-labelledby="method-h">
      <h2 className="sb-h2" id="method-h">
        How to read this board
      </h2>
      <div className="sb-method" style={{ marginTop: 20 }}>
        <div>
          <h3 className="sb-h3">Nobody&apos;s own spec</h3>
          <p>
            26 properties come from a16z/erc4626-tests at one pinned commit. Specfirst adds 4, each checking one EIP-4626 sentence: a max value must be
            an amount the call accepts. Nothing comes from the vaults&apos; authors.
          </p>
        </div>
        <div>
          <h3 className="sb-h3">Fixed and replayable</h3>
          <p>
            Each vault is forked at one recorded block. The seed, the sender and every tool version are in the report, and the report&apos;s hash is
            what the testnet registry stores. Every vault page has the command that replays it.
          </p>
        </div>
        <div>
          <h3 className="sb-h3">Tested against a broken vault</h3>
          <p>
            The same harness runs on BrokenVault, which promises 1% more shares than it mints. previewDeposit fails there and the other 25 pass. A
            harness that could not catch it would make every pass here meaningless.
          </p>
        </div>
      </div>
      <h3 className="sb-h3" style={{ marginTop: 28 }}>
        What a result does not say
      </h3>
      <ul className="sb-limits">
        <li>A pass means no counterexample in {runs} fuzz runs at one block. It is not an audit and not a safety guarantee.</li>
        <li>State, parameters and proxy implementations change after that block; a later check can come out differently.</li>
        <li>Amounts are capped at the smaller of maxDeposit and one million whole tokens, and each run uses 16 test users salted by the seed.</li>
        <li>ERC-7575 vaults with a separate share token and ERC-7535 native-asset vaults are not applicable: both suites assume a vault that is its own ERC-20 share.</li>
      </ul>
      <p style={{ marginTop: 16 }}>
        <a href="/about">Read the full method, limits and why these are called spec mismatches</a>
      </p>
    </section>
  );
}
