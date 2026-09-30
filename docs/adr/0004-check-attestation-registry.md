# ADR 0004: Check attestations for contracts on other chains (`CheckAttestationRegistry`)

Date: 2026-09-30. Status: accepted.

## Problem
`specfirst check` (ADR 0003) produces a report for a contract on Monad mainnet (chain 143). The decision is to record those results onchain on Monad testnet (chain 10143), where Specfirst already issues certificates, and never to write to mainnet. `CertificateRegistry` cannot hold them: `issue` reads `target.codehash` on its own chain and rejects a target without code, so it can only certify contracts that live next to it. Its model (a spec, an invariant set, a run, a deploy, a rehearsal) does not fit a third-party suite run on someone else's contract either.

## Decision
A separate contract, `packages/contracts/src/CheckAttestationRegistry.sol` (MIT), next to `CertificateRegistry`, which stays as it is, together with the spec, run, deploy and certificate flow.

- Roles: an immutable owner (the deployer) and issuers set by the owner, as in `CertificateRegistry`.
- One attestation records: subjectChainId (uint64), subject (address), blockNumber (uint64, subject chain), implementationKey, subjectCodeHash, suiteHash, reportHash (bytes32 each), passCount, failCount, inconclusiveCount, notApplicableCount (uint16 each), passedBitmap and failedBitmap (uint256, bit i is result i of the report), issuedAt, issuer, reportURI, and a status (Valid, Superseded, Revoked).
- `attest(params)` (issuers only) checks that counts add up to 1..256 results, that each bitmap has exactly its count of bits, no bit in both and none at or above the result count, that the code hash is neither zero nor the empty-code hash, and that the report hash is not zero. The subject's previous attestation becomes Superseded when it is Valid, and an attestation for an earlier block than the subject's latest is refused.
- `revoke(id, reasonHash)` (issuers only) for Valid or Superseded attestations; reasonHash is keccak256 of the evidence file.
- `latest(subjectChainId, subject)`, `attestationOf(id)`, `isCompliant(subjectChainId, subject)`, `suiteHashOf(suite)`.
- Events `Attested`, `Superseded`, `Revoked`, `IssuerSet`. The contract makes no external calls; a test walks its runtime code to show there is no CALL, CALLCODE, DELEGATECALL or STATICCALL, so it needs no reentrancy guard.

The CLI:

    specfirst attest-registry deploy [--network monad-testnet|anvil] [--rpc <url>] [--issuer <address>]
    specfirst cert attest <report.json> [--network monad-testnet|anvil] [--rpc <url>] [--registry-attest <address>] [--subject-rpc <url>] [--report-base-url <url>]
    specfirst cert attestation <subjectChainId> <address> [--network ...] [--registry-attest <address>]
    specfirst cert revoke-attestation <id> --evidence <file> [--network ...] [--registry-attest <address>]

The registry address defaults to `SPECFIRST_ATTEST_REGISTRY_<chainId>`. Deploy signs with `DEPLOYER_PRIVATE_KEY`, attest and revoke with `ISSUER_PRIVATE_KEY`. Deploy sends the creation code bundled in `packages/core/src/attest/artifact.ts` (generated from the forge build and checked against it by a test) from the same guarded wallet every other write uses, not through `forge script --broadcast`, which would bypass the guards.

## Trust model: a mainnet subject recorded on testnet
The registry cannot read chain 143, so `subjectCodeHash` is the issuer's statement. Two things keep it checkable:
1. Before sending, `cert attest` reads the subject chain itself (read only; monad-mainnet is allowed for reads): the RPC must report the report's chain id, and keccak256 of `eth_getCode(subject, blockNumber)` must equal the report's `identity.codeHash`. Otherwise nothing is sent (exit 14).
2. Anyone can repeat both steps later: read the code at `blockNumber` on the subject chain and compare it with `subjectCodeHash`, fetch the report at `reportURI`, recompute `reportHash` and `suiteHash`, and rerun `specfirst check <subject> --block <blockNumber> --runs <runs> --delta <delta> --seed <seed>` with the recorded seed (the CLI draws a new random sender; the seed also salts the user pool).

What the registry adds is an issuer's signature over those values, a timestamp and a revocation path. It does not make the values true by itself.

Writes keep every guard of ADR 0003: `resolveNetwork` refuses monad-mainnet for `attest-registry deploy`, `cert attest` and `cert revoke-attestation` before a key is read; the wallet refuses chain 143; the transport checks each RPC's `eth_chainId` before the first transaction on it.

## Encodings
`suiteHash` names what ran:

    suiteHash = keccak256(abi.encode(Suite))
    Suite = (string standard, string upstreamRepo, bytes20 upstreamCommit, bytes20 forgeStdCommit,
             bytes32 harnessSha256, bytes32 sfPropertiesSha256, bytes32 foundryTomlSha256,
             uint256 runs, uint256 maxTestRejects, uint256 delta)

encoded as one ABI tuple (the leading offset word of a dynamic tuple included). The values come from the report: `standard`, `upstream.repo`, `upstream.commit` and `toolchain.forgeStd.commit` (40 hex digits as bytes20), `harnessSha256`, `sfPropertiesSha256`, `toolchain.foundryTomlSha256`, `runs`, `toolchain.maxTestRejects`, `delta`. `delta` is included because a large tolerance makes every property pass, and the foundry.toml hash covers the solc version and the reject limit. The seed and the sender are not part of it: they change per run, while the suite stays the same. `CheckAttestationRegistry.suiteHashOf` computes the same value onchain; for the Morpho report at block 109061472 both give `0x583b17e2ce455495cbdf0c337c1c9235b81aedaef8373e57521e36311cd11d50`, a vector pinned in the forge test and the core test.

`reportHash = keccak256(utf8(canonicalJson(report)))`, where canonicalJson (packages/core/src/spec/hash.ts) sorts object keys recursively, writes no whitespace and drops undefined values; the report is the validated `StandardCheckReport`. Reformatting the file does not change it; changing any value does. It is the same rule `reportHash` follows for certificate reports.

Bitmaps: bit i of `passedBitmap` is set when `results[i].status == "pass"`, of `failedBitmap` when it is `"fail"`, in the order of the report's `results` array (the 26 upstream properties, then the four `sf-` ones). A report with more than 256 results cannot be attested.

`reportURI` is `certs/checks/<chainId>/<address lowercase>/<block>.json` (the report is copied there) or `<--report-base-url>/checks/<chainId>/<address>/<block>.json`.

## What `isCompliant` means, and what it does not
`isCompliant(subjectChainId, subject)` is true when the subject's latest attestation is Valid, has at least one pass, and no fail, inconclusive or not-applicable result. It means only that this suite, as named by suiteHash, passed at this block for the code the issuer reported. It does not mean:
- that the contract is safe or audited, or conforms to properties the suite does not have;
- anything about another block: a proxy can be upgraded, state changes, and a later check can fail;
- that the reported code hash is right, until someone repeats the check above;
- anything when the latest attestation is Revoked: `isCompliant` is false and does not fall back to an older attestation.
Integrators that care which suite ran should compare `suiteHash` too, not only `isCompliant`.

## Consequences
- A contract on any chain can be attested on testnet without touching that chain.
- An attestation is only as good as the issuer's honesty and anyone's willingness to recheck it; the report, seed and suite hashes make the recheck possible.
- The web page does not show attestations yet.

## Evidence
- `forge test`: 21 tests for CheckAttestationRegistry (permissions, input validation, bitmaps up to 256 results, supersede, block order, revoke, isCompliant boundaries including one inconclusive result, a fuzz test of the isCompliant definition, the suiteHash vector, no external calls), 100% line, statement, branch and function coverage.
- Core tests: parameters from the Upshift and Morpho reports of Monad block 109061472 (16 pass, 2 fail, 12 inconclusive with the two fails at the `sf-maxWithdraw-honored` and `sf-maxRedeem-honored` bits; 30 of 30 pass), reportHash rules, and the code-hash check with a mock subject client.
- CLI test on a local anvil: deploy, attest, read back, a refused code-hash mismatch that sends nothing, supersede by a failing report, a refused earlier block, revoke, and refusals on monad-mainnet.
