/** A vault with no report here yet: the way in is a request. */
export default function VaultNotFound() {
  return (
    <main className="sb-wrap">
      <p className="sb-crumbs">
        <a href="/">All vaults</a>
      </p>
      <header className="sb-vault-head">
        <h1 className="sb-vault-name">Not checked yet</h1>
        <p className="sb-verdict">
          This site has no check report for this vault. If it is an ERC-4626 vault on Monad mainnet, you can have it checked at the latest block and
          the result attested onchain.
        </p>
        <p className="sb-links">
          <a className="sb-action" href="/check">
            Request a check
          </a>
          <a className="sb-action" data-kind="quiet" href="/">
            Back to the board
          </a>
        </p>
      </header>
    </main>
  );
}
