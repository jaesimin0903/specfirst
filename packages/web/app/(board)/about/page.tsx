import type { Metadata } from 'next';
import { loadBoard } from '../../../lib/board/load';
import { formatBlock } from '../../../lib/board/reasons';
import { addressUrl, ERC4626_STANDARD_ID } from '../../../lib/board/attestations';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Method and limits | Monad ERC-4626 board | Specfirst',
  description: 'How Specfirst checks ERC-4626 vaults on Monad against third-party properties, what a result means and what it does not.',
};

export default function AboutPage() {
  const board = loadBoard();
  const block = board.blocks[0] ? formatBlock(board.blocks[0].blockNumber) : null;
  const reg = board.registry;
  return (
    <main className="sb-wrap">
      <header className="sb-hero">
        <h1 className="sb-claim" style={{ maxWidth: '14em' }}>
          Method, limits, and why we say spec mismatch
        </h1>
        <p className="sb-sub">
          What ran against each vault, what a pass, fail, inconclusive or not applicable result means, and what none of them promise.
        </p>
      </header>

      <div className="sb-section">
        <div className="sb-prose">
        <h2 style={{ marginTop: 0 }}>Properties nobody wrote for themselves</h2>
        <p>
          A certificate built on the deployer&apos;s own spec proves only that the code agrees with its author. This board uses properties that neither
          the vault teams nor Specfirst chose for the occasion. 26 come from{' '}
          <a href="https://github.com/a16z/erc4626-tests">a16z/erc4626-tests</a>, pinned to one commit and fetched at run time. They cover the view
          functions, the preview functions against the real calls, allowances and round trips such as redeem after deposit.
        </p>
        <p>
          Specfirst adds 4 properties of its own, one EIP-4626 sentence each. For maxDeposit, maxMint, maxWithdraw and maxRedeem the standard says the
          value MUST be the most the matching call accepts without reverting, and MUST be 0 while the action is disabled. The upstream suite discards
          any input whose call reverts, so a vault whose withdraw always reverts never fails there; it only runs out of inputs. The max-honored
          properties call deposit, mint, withdraw or redeem directly with an amount at or below the advertised max, then at the bound itself (the max, or
          one million whole tokens for deposit and mint when the max is larger). They fail when the call at the bound reverts; refusals of smaller
          amounts are counted beside the verdict.
          Their source is in the Specfirst repository and its hash is in every report.
        </p>

        <h2>How a check runs</h2>
        <ul>
          <li>
            Each vault is forked at one block{block ? `, ${block} for this board` : ''}. forge runs with a recorded seed and a fresh random sender, so a
            vault cannot recognise forge&apos;s default address.
          </li>
          <li>
            Test users come from a pool of 16 addresses derived from the seed. The seed changes per run, so a vault cannot special-case them in
            advance.
          </li>
          <li>
            Amounts are bounded by the smaller of the vault&apos;s maxDeposit and one million whole tokens. No synthetic yield is added: the vault&apos;s
            own share price at the block is what gets tested.
          </li>
          <li>
            Balances are written with forge-std&apos;s deal, with a packed-slot fallback for tokens such as Monad&apos;s AUSD. When no slot can be
            written, the property is inconclusive.
          </li>
          <li>
            forge gives up on a property after 4,096 rejected inputs. A property that never got a usable input is inconclusive, never a pass.
          </li>
          <li>
            Positive control: the same harness runs against BrokenVault, whose previewDeposit promises 1% more shares than deposit mints.
            previewDeposit fails there and the other 25 upstream properties pass. A harness that could not catch it would make every pass on this board
            meaningless.
          </li>
          <li>
            Vaults that share an implementation key ran the same code: the implementation behind a proxy when there is one, compared with compiler
            metadata and with immutables masked. They count once in the implementation total.
          </li>
        </ul>

        <h2>What each result means</h2>
        <ul>
          <li>
            <strong>Pass</strong>: no counterexample in the recorded number of fuzz runs, at that block, for that suite.
          </li>
          <li>
            <strong>Fail</strong>: forge found a concrete input that breaks the property. The report keeps the failing call.
          </li>
          <li>
            <strong>Inconclusive</strong>: the property could not be exercised, because the vault rejected the amounts, test users could not be funded,
            the RPC failed, or every input needed a Monad precompile the fork does not have. Only a pass counts as verified, so imitating one of these
            messages gains a vault nothing.
          </li>
          <li>
            <strong>Not applicable</strong>: the suite cannot run on this contract. ERC-7575 vaults keep shares in a separate token, ERC-7535 vaults hold
            the native coin, some assets only move between allowlisted parties, and a max of 0 for every user leaves nothing to honor.
          </li>
        </ul>

        <h2>Limits</h2>
        <ul>
          <li>One point in time. State, parameters and proxy implementations change after the block; a later check can come out differently.</li>
          <li>
            A pass is not an audit and not a safety guarantee. Bugs that need larger amounts, more users, a price change or a specific address are out
            of reach.
          </li>
          <li>
            Masking every PUSH32 immediate also masks real constants, so two contracts that differ only in such a constant are grouped as one
            implementation.
          </li>
          <li>
            forge pranks test users, which changes msg.sender but not tx.origin. A vault that branches on tx.origin can behave differently under the
            harness.
          </li>
          <li>Public RPCs rate-limit. Properties that ended on an RPC error say nothing about the vault and should be rerun.</li>
          <li>
            forge has none of Monad&apos;s own precompiles (staking at 0x1000, the reserve balance check at 0x1001, P256 at 0x0100). An input whose
            vault call reaches one of them and reverts, such as a deposit into a liquid staking vault that stakes it, is not judged, since the fork
            cannot tell whether the revert needed the precompile&apos;s answer. A property with such an input never passes: it fails when another
            input failed, otherwise it is inconclusive. Calls that reach a precompile and go through are judged as usual.
          </li>
        </ul>

        <h2>Why we call them spec mismatches</h2>
        <p>
          A failed max-honored property shows a vault whose own numbers disagree with its own behavior: maxWithdraw reports a balance and withdraw
          reverts, or withdrawals are paused while the max is not 0. EIP-4626 is explicit that this is not allowed. That is what the board reports, and
          it stops there.
        </p>
        <p>
          It is not a vulnerability claim. The vault may be working exactly as its authors intend, for example with exits that go through a request
          queue instead of withdraw. No loss of funds follows from the mismatch itself. What breaks is the promise other software relies on:
          aggregators, routers and wallets that read maxWithdraw before building a transaction get a revert the standard says cannot happen.
        </p>

        <h2>Onchain attestations</h2>
        <p>
          Results are recorded on Monad testnet in CheckAttestationRegistry{' '}
          <a href={addressUrl(reg.address)} className="mono">
            {reg.address}
          </a>
          , keyed by chain, vault and standard (standardId <span className="mono break">{ERC4626_STANDARD_ID}</span>, keccak256 of
          &quot;erc4626&quot;). An attestation stores the block, the implementation key, the code hash, the suite hash, the report hash, the four
          counts and one bitmap each for passes and fails.
        </p>
        <p>
          isCompliant is true only when the latest attestation is valid, has at least one pass and no fail, inconclusive or not applicable result.
          It repeats the check result; it does not make the vault safe, it says nothing about another block, and the registry cannot read Monad
          mainnet, so the code hash and implementation key are the issuer&apos;s statement until someone repeats the check.
        </p>

        <h2>Check it yourself</h2>
        <p>
          Every vault page lists the exact command with the recorded block, runs and seed, and links the report file. Its reportHash is keccak256 of
          the report&apos;s RFC 8785 canonical JSON; recompute it and compare with the attestation. Python&apos;s json.dumps needs ensure_ascii=False
          to match.
        </p>
        </div>
      </div>
    </main>
  );
}
