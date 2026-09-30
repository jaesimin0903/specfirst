# ADR 0004: Check attestations for contracts on other chains (`CheckAttestationRegistry`)

Date: 2026-09-30. Status: accepted. Revised the same day after code review, before the first deployment: attestations are kept per standard, the suite pins the forge version and the property table, the subject's implementation identity is checked before issuing, and the CLI keeps report copies, issuer roles and revocations safer.

## Problem
`specfirst check` (ADR 0003) produces a report for a contract on Monad mainnet (chain 143). The decision is to record those results onchain on Monad testnet (chain 10143), where Specfirst already issues certificates, and never to write to mainnet. `CertificateRegistry` cannot hold them: `issue` reads `target.codehash` on its own chain and rejects a target without code, so it can only certify contracts that live next to it. Its model (a spec, an invariant set, a run, a deploy, a rehearsal) does not fit a third-party suite run on someone else's contract either.

## Decision
A separate contract, `packages/contracts/src/CheckAttestationRegistry.sol` (MIT), next to `CertificateRegistry`, which stays as it is, together with the spec, run, deploy and certificate flow. The contract cannot be changed after it is deployed, so its interface below is final for the first deployment.

- Roles: an immutable owner (the deployer) and issuers set by the owner, as in `CertificateRegistry`. See "Roles" below.
- One attestation records: subjectChainId (uint64), subject (address), standardId (bytes32), blockNumber (uint64, subject chain), implementationKey, subjectCodeHash, suiteHash, reportHash (bytes32 each), passCount, failCount, inconclusiveCount, notApplicableCount (uint16 each), passedBitmap and failedBitmap (uint256, bit i is result i of the report), issuedAt, issuer, reportURI, and a status (Valid, Superseded, Revoked).
- `standardId = keccak256(bytes(standard))`, for example `keccak256("erc4626") = 0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab`. The latest attestation is kept per `(subjectChainId, subject, standardId)`, so a check of one standard never supersedes a check of another on the same contract.
- `attest(params)` (issuers only) checks that counts add up to 1..256 results, that each bitmap has exactly its count of bits, no bit in both and none at or above the result count, that standardId, implementationKey, suiteHash and reportHash are not zero, that the code hash is neither zero nor the empty-code hash, and that reportURI is at most 512 bytes (`MAX_REPORT_URI_LENGTH`). The previous latest attestation of the same key becomes Superseded when it is Valid.
- Block order: while the latest attestation is Valid, a new one for an earlier block is refused (`OlderThanLatest`). Once the latest is Revoked, any block is accepted. An attestation recorded with a wrong, too high block number is therefore repaired by revoking it and attesting the right block; without this rule the key would be stuck behind the wrong number forever.
- `revoke(id, reasonHash)` (issuers only) for Valid or Superseded attestations; reasonHash is keccak256 of the evidence file.
- Views: `latest(subjectChainId, subject, standardId)`, `isCompliant(subjectChainId, subject, standardId)`, `isCompliantWith(subjectChainId, subject, standardId, suiteHash)`, `attestationOf(id)`, `attestationCount()`, `suiteHashOf(suite)`, `isIssuer(address)`, `owner()`.
- Events: `Attested(uint256 indexed id, uint64 indexed subjectChainId, address indexed subject, address issuer, AttestParams params)`, `Superseded(id, byId)`, `Revoked(id, reasonHash)`, `IssuerSet(issuer, allowed)`. `Attested` carries every submitted field (standardId, blockNumber, implementationKey, subjectCodeHash, suiteHash, reportHash, the four counts, both bitmaps, reportURI) and the issuer, so an indexer rebuilds an attestation from the log alone; issuedAt is the block timestamp and the status starts Valid. The fields travel as the `AttestParams` tuple because 17 flat event arguments do not compile without via-IR (stack too deep, reproduced with solc 0.8.28 and the project's optimizer settings).
- The contract makes no external calls; a test walks its runtime code to show there is no CALL, CALLCODE, DELEGATECALL or STATICCALL, so it needs no reentrancy guard.

### Roles
- The owner is immutable: there is no transfer and no renounce (L8). Its only power is `setIssuer`. If the owner key is lost, the issuer set is frozen; the remedy is a new registry, not a recovery path inside this one.
- Removing an issuer does not touch what it attested (L4). Its attestations stay Valid, and `isCompliant` keeps returning true for them, until another issuer supersedes or revokes them. A reader who stops trusting an issuer must look at `issuer` in the attestation; the registry does not do that for them.
- Issuers are peers: any issuer can supersede or revoke any attestation, including another issuer's (L4). The registry is meant for one operator with one or a few keys, not for independent parties who distrust each other; those should use separate registries.

### CLI

    specfirst attest-registry deploy [--network monad-testnet|anvil] [--rpc <url>] [--issuer <address>]
    specfirst attest-registry set-issuer <address> [--remove] [--network ...] [--rpc <url>] [--registry-attest <address>]
    specfirst cert attest <report.json> [--network monad-testnet|anvil] [--rpc <url>] [--registry-attest <address>] [--subject-rpc <url>]
                                        [--report-base-url <url>] [--allow-unknown-proxy]
    specfirst cert attestation <subjectChainId> <address> [--standard erc4626] [--network ...] [--registry-attest <address>]
    specfirst cert revoke-attestation <id> --evidence <file> [--expect-subject <chainId>:<address>] [--network ...] [--registry-attest <address>]

The registry address defaults to `SPECFIRST_ATTEST_REGISTRY_<chainId>`. Deploy and set-issuer sign with `DEPLOYER_PRIVATE_KEY` (the owner), attest and revoke with `ISSUER_PRIVATE_KEY`.

- Deploy sends the creation code bundled in `packages/core/src/attest/artifact.ts` (generated from the forge build by `packages/core/scripts/gen-attest-artifact.mjs`; `packages/core/test/attest.test.ts` runs `forge build` and fails when the bundle differs, and is skipped only when forge is not installed) from the same guarded wallet every other write uses, not through `forge script --broadcast`, which would bypass the guards. It prints the keccak256 of that creation code.
- Deploy's issuer is `--issuer`, else the address of `ISSUER_PRIVATE_KEY` when it is set, else the deployer. When `--issuer` differs from the `ISSUER_PRIVATE_KEY` address it warns: `cert attest` would get NotIssuer until that address is allowed. The registry address is printed and emitted (`attest-registry-deployed`) as soon as the deploy receipt is in, before `setIssuer`; if `setIssuer` then fails, the error names the address and the `set-issuer` command that finishes the job.
- `cert attest` refuses a report for chain 31337 (anvil) unless the registry is on anvil too, and off anvil requires `--report-base-url` (see Encodings).
- `cert revoke-attestation` reads `attestationOf(id)` and prints its subject, standard, block and status before sending. With `--expect-subject <chainId>:<address>` it refuses when the attestation is about another subject; off anvil the option is required, so a mistyped id cannot revoke someone else's attestation.
- The id `cert attest` reports is taken from the mined receipt: the one `Attested` event whose log address is the registry (viem `parseEventLogs`). The return value of the pre-send simulation is not used, since another attestation can land in between.
- Once the attest transaction is mined, nothing after it turns into a failure exit: a failed `isCompliant` read is printed as a warning and listed in the event's `warnings`, and the exit code stays 0, so a retry does not record the report twice. Everything that can fail before the transaction (report validation, the identity check, the report copy) stops with exit 14 and sends nothing.

## Trust model: a mainnet subject recorded on testnet
The registry cannot read chain 143, so `subjectCodeHash` and `implementationKey` are the issuer's statement. Two things keep them checkable:
1. Before sending, `cert attest` reads the subject chain itself (read only; monad-mainnet is allowed for reads). The RPC must report the report's chain id, and `identifyImplementation(subject, blockNumber)` (ADR 0003, `packages/core/src/standards/identity.ts`) run there must give the report's `identity`: the same `codeHash`, `proxy`, `implementation`, `implementationKey` and `implementationKeyKind`, compared as canonical JSON with hex case ignored. Any difference (another implementation behind the same proxy, a forged key, a different proxy kind) refuses the report with exit 14 and names the differing fields. A subject whose proxy implementation could not be resolved (`proxy.kind` `unknown`, so its key comes from the proxy code) is refused as well unless `--allow-unknown-proxy` is passed; the CLI then prints that and records `proxyKind: "unknown"`, `unknownProxyAllowed: true` in its event.
2. Anyone can repeat the checks later: read the code at `blockNumber` on the subject chain, rerun the identification and compare it with `subjectCodeHash` and `implementationKey`, fetch the report at `reportURI`, recompute `reportHash` and `suiteHash`, and rerun `specfirst check <subject> --block <blockNumber> --runs <runs> --delta <delta> --seed <seed>` with the recorded seed (the CLI draws a new random sender; the seed also salts the user pool).

When the subject is a proxy, `subjectCodeHash` is the hash of the proxy's own runtime code and says nothing about the logic behind it. The implementation is identified by `implementationKey`, which comes from the implementation's code whenever it was resolved (`implementationKeyKind.of == "implementation"`). A proxy can be upgraded after `blockNumber`; the attestation is about the implementation at that block only.

What the registry adds is an issuer's signature over those values, a timestamp and a revocation path. It does not make the values true by itself.

Writes keep every guard of ADR 0003: `resolveNetwork` refuses monad-mainnet for `attest-registry deploy`, `attest-registry set-issuer`, `cert attest` and `cert revoke-attestation` before a key is read; the wallet refuses chain 143; the transport checks each RPC's `eth_chainId` before the first transaction on it.

## Encodings
`suiteHash` names what ran:

    suiteHash = keccak256(abi.encode(Suite))
    Suite = (string standard, string upstreamRepo, bytes20 upstreamCommit, bytes20 forgeStdCommit, string forgeVersion,
             bytes32 harnessSha256, bytes32 sfPropertiesSha256, bytes32 propertiesHash, bytes32 foundryTomlSha256,
             uint256 runs, uint256 maxTestRejects, uint256 delta)

encoded as one ABI tuple (the leading offset word of a dynamic tuple included). The values come from the report: `standard`, `upstream.repo`, `upstream.commit` and `toolchain.forgeStd.commit` (40 hex digits as bytes20), `toolchain.forgeVersion` (the first line of `forge --version`, for example `forge Version: 1.5.1-Homebrew`; the empty string when forge did not run), `harnessSha256`, `sfPropertiesSha256`, `propertiesHash`, `toolchain.foundryTomlSha256`, `runs`, `toolchain.maxTestRejects`, `delta`.

- `delta` is included because a large tolerance makes every property pass, and the foundry.toml hash covers the solc version and the reject limit. The forge version is included because the same harness under another forge can classify results differently.
- `propertiesHash = keccak256(utf8(canonicalJson([{id, test, description}, ...])))` over the report's results in order. `cert attest` refuses a report whose list is not exactly the standard's property table (`ERC4626_CHECK_PROPERTIES` for erc4626: the 26 upstream properties, then the four `sf-` ones), so for an accepted report the value is the table's hash, `0x33117c4fed6c8e64829e6397d577a69153a43774fddd609e952264514e270204` for erc4626, and bit i of the bitmaps always means the same property. A reordered, renamed, shortened or extended list changes suiteHash and is refused.
- The seed and the sender are not part of it: they change per run, while the suite stays the same.

`CheckAttestationRegistry.suiteHashOf` computes the same value onchain. For the Morpho report at block 109061472, viem, `abi.encode` in the forge test and `cast abi-encode` all give `0x49a246fc992c88a122f878579e0ee415f79ff4cf8c5f021b21a12d703e83023e`, a vector pinned in the forge test and the core test, and the CLI test compares `suiteHashOf` on anvil with the TypeScript value.

`reportHash = keccak256(utf8(canonicalJson(report)))` over the validated `StandardCheckReport`. The canonical form is RFC 8785, the JSON Canonicalization Scheme (JCS): object keys sorted by UTF-16 code units, no whitespace, strings escaped as ECMAScript `JSON.stringify` does (only `"`, `\` and control characters, with lowercase `\u00xx`; every other character, non-ASCII included, written as its UTF-8 bytes), numbers in ECMAScript form. `canonicalJson` (packages/core/src/spec/hash.ts) is exactly that for the values a report holds: integers within 2^53, no lone surrogates, no undefined values. Reformatting the file does not change the hash; changing any value does. It is the same rule `reportHash` follows for certificate reports.

Warning for independent verifiers: Python's `json.dumps(r, sort_keys=True, separators=(",", ":"))` is not JCS by default. It writes non-ASCII characters as `\uXXXX` escapes (`ensure_ascii=True`) and so gives another hash for any report that holds a non-ASCII character, which a revert string copied into a `reason` can contain. `ensure_ascii=False` matches for our reports (ASCII keys, integers only); sort order also differs from JCS for keys outside the Basic Multilingual Plane. The core test pins such a report (`nonascii-revert-143-109061472.json`, a Korean, French and Japanese revert string with U+2028 and a control character): the TypeScript hash equals Python with `ensure_ascii=False` and differs from Python's default.

Reports of schemaVersion 1 and 2 are both accepted. `vaultKind` (version 2, ADR 0003) is part of reportHash but not of suiteHash: it is what the pre-checks found on the subject, not how the suite ran. An `erc7535` or `erc7575` vault has every property not_applicable, so its attestation is never compliant.

The report's `blockNumber` is a decimal string without leading zeros (the schema rejects `"0109061472"`), so one block has one spelling and one report file name.

Bitmaps: bit i of `passedBitmap` is set when `results[i].status == "pass"`, of `failedBitmap` when it is `"fail"`, in the order of the report's `results` array. A report with more than 256 results cannot be attested.

Report copies and `reportURI`: before sending, `cert attest` copies the report to `certs/checks/<chainId>/<address lowercase>/<block>-<hash8>.json`, where hash8 is the first 8 bytes of reportHash in hex (16 digits), so two reports of one block never overwrite each other. `reportURI` is `<--report-base-url>/<chainId>/<address lowercase>/<block>-<hash8>.json`; the repository's own value is `https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks` (the README shows the command). Off anvil the option is required; on anvil the default is the repository-relative copy path.

## What `isCompliant` means, and what it does not
`isCompliant(subjectChainId, subject, standardId)` is true when the latest attestation of that subject and standard is Valid, has at least one pass, and no fail, inconclusive or not-applicable result. `isCompliantWith(subjectChainId, subject, standardId, suiteHash)` is the same with the latest attestation's suiteHash equal to the one given; integrators that rely on a specific suite (a forge version, a property table, a delta) should use it. Both mean only that this suite passed at this block for the code the issuer reported. They do not mean:
- that the contract is safe or audited, or conforms to properties the suite does not have;
- anything about another block: a proxy can be upgraded, state changes, and a later check can fail;
- that the reported code hash and implementation key are right, until someone repeats the checks above;
- anything when the latest attestation is Revoked: both are false and do not fall back to an older attestation. `isCompliantWith` does not fall back to an older attestation with the requested suite either;
- that the issuer is still an issuer: removing an issuer leaves its attestations Valid (see Roles).

## Consequences
- A contract on any chain can be attested on testnet without touching that chain.
- An attestation is only as good as the issuer's honesty and anyone's willingness to recheck it; the report, seed and suite hashes make the recheck possible.
- Checks of different standards on one contract live side by side; a future standard needs no new registry.
- The web page does not show attestations yet.

## Evidence
- `forge test --match-contract CheckAttestationRegistryTest`: 27 tests (permissions, input validation including zero standardId, implementationKey and suiteHash and the 512-byte reportURI limit, bitmaps up to 256 results including a fail bit only outside the results, supersede, standards kept apart, block order and the earlier block accepted after a revoked latest, revoke, isCompliant boundaries, isCompliantWith, isCompliant after an issuer is removed, a fuzz test of both definitions, the suiteHash vector, no external calls). `forge coverage`: 100% lines (98/98), statements (137/137), branches (24/24) and functions (18/18) of the contract.
- Core tests (`packages/core/test/attest.test.ts`): parameters from the Upshift and Morpho reports of Monad block 109061472 (16 pass, 2 fail, 12 inconclusive with the two fails at the `sf-maxWithdraw-honored` and `sf-maxRedeem-honored` bits; 30 of 30 pass), the suiteHash, propertiesHash and standardId vectors, refusal of reordered, renamed and shortened property lists and of a reportURI over 512 bytes, report file names, reportHash rules including the non-ASCII fixture, a schemaVersion 2 report with vaultKind, leading zeros in blockNumber, the identity check with a mock subject client (plain contract, EIP-1967 proxy, an upgraded implementation behind the same proxy code, a forged key, unknown proxy with and without the option), the attestation id taken from the registry's own `Attested` log and not from the simulation or a decoy contract, and the bundled bytecode against a fresh forge build.
- CLI test on a local anvil (`packages/cli/test/attest.e2e.test.ts`), deployer anvil account 0 and issuer anvil account 1: deploy with the issuer taken from `ISSUER_PRIVATE_KEY`, the warning for a different `--issuer`, the address emitted before a failing `setIssuer`, attest and read back, refused identity mismatches that send and copy nothing, unknown proxy refused and then allowed, supersede by a failing report, a refused earlier block, revoke with `--expect-subject` (a wrong subject refused), the earlier block accepted after the revoke, a failed isCompliant read after the transaction as a warning with exit 0, set-issuer by the owner only and a removed issuer refused while its attestation stays compliant, and refusals on monad-mainnet and off anvil (anvil reports, missing `--report-base-url`, missing `--expect-subject`).
