# ADR 0007: Reading attestations on chain: an allocation gate (`AllocationGate`)

Date: 2026-10-07. Status: accepted for the demo; built and tested on anvil, not deployed yet. Testnet and anvil only.

## Problem
A judge or a curator asks: who reads these attestations? The web, the badge and the CLI do; no contract does, and we have no customer to point at. The answer we can show ourselves is a contract whose money follows the registry: it refuses to move money into a vault that is not compliant, and anyone can pull the money out of a vault the moment its latest attestation stops being compliant. On the testnet demo this pairs with the watcher (ADR 0006): the operator switches the DemoVault bug on, the watcher attests the mismatch, and the gate stops new deposits and lets the exit happen with nobody in the loop.

## Decision
`packages/contracts/src/demo/AllocationGate.sol` (MIT), next to the demo contracts of ADR 0006. It reads `CheckAttestationRegistry` (ADR 0004) and changes nothing in it.

    constructor(address registry, uint64 subjectChainId, bytes32 standardId, address asset, address owner, uint64 maxAttestationAge)
    allocate(vault, assets)        owner: deposit idle asset into a Compliant vault
    exit(vault) returns (bool)     anyone: pull the gate's shares out of a vault that is neither Compliant nor Stale
    withdraw(to, amount)           owner: idle asset only
    views: verdictOf(vault) returns (Verdict, attestationId), canExit(vault), positionOf(vault), vaults(), vaultCount(), idle(),
           registry(), subjectChainId(), standardId(), asset(), owner(), maxAttestationAge(), EXIT_GAS_RESERVE()
    events: Allocated, Exited, ExitFailed, IdleWithdrawn

- `subjectChainId` must be `block.chainid` (`WrongSubjectChain`): the gate deposits into contracts on its own chain, and an attestation of the same address on another chain is about another contract. The CLI passes the chain of `--network`.
- `standardId` is `keccak256("erc4626")`; `maxAttestationAge` is in seconds, above 0 (CLI default one day, the watcher's sweep period). The owner is immutable, as in the registry and the desk.
- A position per vault: `shares` (the gate's own count), `assetsIn` and `assetsOut` (summed, measured on the asset's balance, never taken from the vault's return value), and the blocks of the last allocation and the last exit attempt.

### The rules
`verdictOf` reads the registry's latest attestation of `(subjectChainId, vault, standardId)` and applies these in order; the first that holds is the verdict.

| Verdict | When | allocate | exit |
|---|---|---|---|
| NoAttestation | `latest` reverts with the registry's `NoAttestation` | refused | open |
| NotCompliant | `isCompliant` is false: Revoked, or any fail, inconclusive or not-applicable result | refused | open |
| UntrustedIssuer | its issuer is no longer `isIssuer` | refused | open |
| CodeMismatch | its `subjectCodeHash` is not `vault.codehash` | refused | open |
| Stale | issued more than `maxAttestationAge` seconds ago | refused | closed |
| Compliant | none of the above | allowed | closed |

allocate also needs the vault's `asset()` to be the gate's (`AssetMismatch`), enough idle asset, and at least one share minted (`NoSharesMinted`). Each refusal is a custom error named after the verdict (`NoAttestation`, `NotCompliant`, `UntrustedIssuer`, `CodeMismatch`, `StaleAttestation`).

- Why exit stays closed on Stale: the watcher records an unchanged re-check without a transaction (ADR 0006, attestation policy), so an old attestation of a healthy vault is the normal case. Opening exit on age would let anyone pull money out of healthy vaults whenever the watcher is quiet. Age only stops new money.
- Why a removed issuer and another code hash open exit: the attestation that let the money in is no longer one the gate would accept. The registry keeps calling it compliant (ADR 0004, Roles: removal does not touch past attestations); the gate does not.
- Why the code hash and not the implementation: the vault is on the gate's chain, so `vault.codehash` can be compared with the attested `subjectCodeHash`. For a proxy that hash is the proxy's own code, and an upgrade behind it changes nothing the gate can see; `implementationKey` has no generic on-chain recomputation. DemoVaults are not proxies.
- Only the registry's `NoAttestation` selector means "none". Any other failure of the read, an out-of-gas included, is passed on: a caller who starves the read must not make a compliant vault look unattested.

### Exit against a hostile vault
Vault calls are external and untrusted. allocate, exit and withdraw share one reentrancy lock (a storage flag, as in the desk), and exit clears the position before it calls the vault.
- exit tries `redeem(shares)`, then `withdraw(maxWithdraw(gate))`. A partial withdraw keeps the rest of the position; the next exit tries again.
- A vault that refuses (reverts, with any amount of data) ends in `ExitFailed` with the first 4 bytes of each revert: the position is restored and exit returns false instead of reverting, so the attempt is on record. At most 32 bytes of what a vault returns are copied, so a 1 MB revert costs the vault, not the gate.
- A vault call that fails after using up its gas cannot be told from a caller that sent too little gas, so that one reverts the whole exit (`VaultOutOfGas`; a failed call that left no more than `EXIT_GAS_RESERVE`, 60,000 gas, and a 63rd of the gas there was). Recording an `ExitFailed` there would let `eth_estimateGas`, which looks for the lowest gas that does not revert, settle on a limit at which every honest exit fails. A vault that burns any gas it gets can therefore never be exited, which is no worse than one that refuses: its shares stay, the keeper's estimate fails, nothing is sent, and the keeper goes on with the next vault.
- A vault re-entering exit, allocate or withdraw gets `Reentrancy`; from inside `redeem` that is just one more refusal.

### Reading it without an indexer
The web reads state, not history: `vaults()`, `positionOf`, `verdictOf` and the registry's `latest`, `isCompliant` and `isIssuer` go out as multicalls. Events come from `eth_getLogs` of the blocks each position points at (its last allocation and last exit attempt) plus one 100-block window at the head: a few requests, within the testnet RPC's 15 requests a second and the 100-block `getLogs` limit of some endpoints, never a scan from the deployment.

## What it does not guarantee
- The issuer trust model of ADR 0005 still applies. Any current issuer can attest anything for any subject, and the registry cannot tell a true attestation from a false one. A gate that trusts the registry's issuers trusts each of them; a gate that trusts a single issuer trusts that issuer. A real integrator would pin its own issuers and the suite (`isCompliantWith`), which this demo does not.
- Compliant means only what `isCompliant` means (ADR 0004): this suite passed at this block for the code the issuer reported. Not an audit, not safety.
- Freshness is measured from `issuedAt`, when the attestation was sent, not from the block that was checked; an issuer can attest an old block late.
- Exit is not instant. Between the bug and the exit lie the watcher's confirmation (a second check at a later block, ADR 0006) and the keeper's poll. Money that the vault loses in that window is lost.
- The gate cannot force a vault: one that refuses or burns gas keeps the shares.
- Demo scope: one asset, one standard, an immutable owner, no fees, idle funds minted from DemoToken.

## CLI and web
`specfirst watch demo gate <deploy|allocate|exit|keep|status>` on monad-testnet or anvil (monad-mainnet is refused before a key is read), signed with `DEPLOYER_PRIVATE_KEY` through the guarded wallet; `--network`, `--rpc`, `--registry-attest`, `--once` and `--poll` are the ones of `watch`. `deploy --asset <DemoToken> [--max-age <sec>] [--fund <tokens>]` makes the signer the owner and mints `--fund` (default 100) DemoToken to the gate; the gate address comes from `--gate` or `SPECFIRST_GATE_<chainId>`. `exit` and `keep` need no role: any key pays the gas. `keep` runs a pass every `--poll` seconds (default 15) and exits every vault whose exit is open, one transaction each; a vault whose exit cannot be sent is reported and the pass goes on. Failures and refusals exit with 19, like the rest of `watch demo`. The ABI and bytecode are generated into `@specfirst/core/gate` (`packages/core/scripts/gen-gate-artifact.mjs`, browser-safe) like the desk's.

`/watch/gate` (linked from `/watch`) reads the gate named by `NEXT_PUBLIC_SPECFIRST_GATE_10143` per request and every 15 seconds: the gate's settings and idle balance, each vault's position, verdict, `isCompliant` and latest attestation, whether anyone can exit it now, and the recent `Allocated`, `Exited`, `ExitFailed` and `IdleWithdrawn` events. Unset, it says the gate is not deployed.

## Evidence
- `forge test --match-contract AllocationGate`: 30 unit and fuzz tests and 3 invariants. Every verdict refused by allocate (none, a failed report, inconclusive, not applicable, revoked, stale with the exact boundary, a removed issuer, another code hash) and the asset, owner, amount and idle checks; the demo scenario with the real registry and a DemoVault whose bug is switched on and re-attested, another depositor and yield, exited by an account with no role; exit refused while Compliant and while Stale; exit after a revoke, a removed issuer and another code hash; hostile vaults: redeem refused with the withdraw fallback, a partial withdraw, both refused (`ExitFailed`, position kept, a later retry succeeds), re-entry into exit, re-entry from deposit, a gas burner (`VaultOutOfGas`), a 1 MB revert under a 6M gas limit; exit tried at gas limits from 40,000 to 400,000 in steps of 1,000 with cold storage never ends an honest vault in `ExitFailed`; `verdictOf` starved of gas never answers `NoAttestation` for a compliant vault; a token that returns nothing and one that returns false; a fuzz of the books over two vaults. The invariants (256 runs, depth 64) drive random allocations, bugs switched and attested, revocations, keeper exits, yield, other depositors, idle withdrawals and time: the idle balance equals funded minus allocated plus exited minus withdrawn, each position's shares equal the vault's balance of the gate, no approval is left, a refused verdict never allocates. `forge coverage`: 100% of lines (131), statements (177), branches (37) and functions (20) of the contract. Mutations of the out-of-gas rule, the 32-byte copy and the `NoAttestation` selector check each fail a test.
- `packages/core/test/gate.test.ts`: the enum names against the Solidity source, the verdict helpers, and the bundled artifact against a fresh forge build.
- `packages/cli/test/gate.e2e.test.ts` on anvil, through the CLI: deploy the registry, a DemoToken, the factory, two DemoVaults and the gate; allocation refused without an attestation; both vaults attested compliant with `cert attest` (the Morpho fixture re-pointed at them); allocate; exit refused while compliant; the bug switched on in both and the failing reports attested; allocation refused (`NotCompliant`); one vault exited with `gate exit`, the other by `gate keep --once` signed by a key that is neither owner nor issuer; `gate status` in JSON and as text; mainnet refused before any key or RPC.
- `packages/web/test/gate-view.test.tsx`: the reader against a mock chain (which blocks it asks logs for, decoding, other emitters dropped, a failed read listed and not guessed), "not deployed" without the variable, and the rendered page.
