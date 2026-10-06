# @specfirst/contracts

Foundry project for `CertificateRegistry.sol`, the onchain certificate registry described in
`docs/plan.md` section 3.4 (tests follow section 6.1), `CheckAttestationRegistry.sol`, which records
`specfirst check` results for contracts on any chain (docs/adr/0004), and `CheckRequestDesk.sol`, where
anyone pays a fee for such a check and the worker is paid when it fulfills the request with a matching
attestation (docs/adr/0005), and the demo contracts of the watcher (docs/adr/0006, `src/demo/`).

## Layout

| Path | Content |
|---|---|
| `src/CertificateRegistry.sol` | Registry: issue, revoke, lineage per projectId, isCertified, isCertifiedWith, isLatest |
| `test/CertificateRegistry.t.sol` | Unit tests for every 6.1 case |
| `test/CertificateRegistry.invariant.t.sol` | Handler based invariant tests |
| `script/Deploy.s.sol` | Deploys the registry and allows the deployer as issuer |
| `src/CheckAttestationRegistry.sol` | Check attestations: attest, supersede per (subjectChainId, subject, standardId), revoke, isCompliant, isCompliantWith, suiteHashOf |
| `test/CheckAttestationRegistry.t.sol` | Unit and fuzz tests: permissions, validation, bitmaps, supersede, standards kept apart, block order after revoke, revoke, isCompliant, isCompliantWith, suiteHash vector, no external calls |
| `src/CheckRequestDesk.sol` | Paid check requests: requestCheck (exact fee, escrowed), fulfill against the registry, reject and expiry refunds, withdraw of earned fees only |
| `test/CheckRequestDesk.t.sol` | Unit and fuzz tests: fee, ids from 0 and UnknownRequest, permissions, fulfill checks against the registry, reject and expiry refunds with the timeout boundary, withdraw never reaching escrow, refused transfers, reentrancy |
| `test/CheckRequestDesk.invariant.t.sol` | Handler based invariants: balance == escrowed + earned - withdrawn, escrowed and earned equal the Pending and Fulfilled fees |
| `src/demo/DemoVaultFactory.sol` | Watcher demo (docs/adr/0006): DemoVaultFactory deploys DemoVaults and emits `VaultDeployed(vault, asset)`; DemoVault is a minimal ERC-4626 with the positive control's previewDeposit bug behind an operator switch (`setBroken`, `BrokenSet`) |
| `src/demo/DemoToken.sol` | ERC-20 anyone can mint, the asset of demo vaults |
| `test/DemoVaultFactory.t.sol` | Deploy event and operator, deposit and redeem with events, previewDeposit equal to deposit unless broken (and a fuzz of it), setBroken by the operator only, allowances |
| `lib/forge-std` | forge-std v1.16.2, vendored as plain files (no submodule) |

## Commands

```bash
forge build
forge test -vv
forge coverage --report summary
# deploy (not run yet)
forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PK --broadcast
```

`foundry.toml` pins solc 0.8.28 with the optimizer on, and sets `no_match_coverage` so coverage
counts `src/` only. Invariant runs use `fail_on_revert = true`: the handler never reverts except
through the expected `PartialCannotSupersede` path, which it catches and counts.

CheckAttestationRegistry is deployed with `specfirst attest-registry deploy`, not with a forge script: the
CLI sends from a guarded wallet that refuses mainnet and checks the RPC chain id before sending.
`packages/core/src/attest/artifact.ts` bundles its ABI and creation code; regenerate it with
`node packages/core/scripts/gen-attest-artifact.mjs` after `forge build` whenever the contract changes;
`packages/core/test/attest.test.ts` runs `forge build` and fails when the bundle differs.

The demo contracts are bundled the same way in `packages/core/src/watch/demoArtifact.ts` (`node packages/core/scripts/gen-demo-artifact.mjs` after `forge build`; `packages/core/test/watch.test.ts` compares). DemoVaultFactory's CREATE2 address follows from its creation code, so a change to `src/demo/DemoVaultFactory.sol` (comments included, through the metadata hash) moves it: update `examples/watch/sources-demo.json` with the new `DEMO_FACTORY_ADDRESS`; the same test fails until they agree.

## Results (2026-09-29, forge 1.5.1)

| Check | Result |
|---|---|
| `forge build` | success, no lint warnings |
| `forge test -vv` | 41 passed, 0 failed (38 unit, 3 invariant with 256 runs x 64 depth each) |
| `forge coverage --report summary` | `src/CertificateRegistry.sol` lines 100% (93/93), statements 100% (113/113), branches 100% (21/21), functions 100% (19/19) |

Invariants checked by the handler (issue complete, issue partial, revoke, `vm.etch` code swap
across 4 targets and 3 projectIds):

1. If the latest certificate of a target is Revoked, or its codeHash differs from the live
   `target.codehash`, then `isCertified` and `isCertifiedWith` are false.
2. For each projectId at most one target reports `isLatest` for it, that target equals
   `currentTargetOf(projectId)`, and it holds a complete certificate for the projectId.
3. A Valid complete certificate is always the latest certificate of its target.

## Behavior notes beyond the plan text

- `certId` is the zero based index in the target's certificate list.
- `issue` also rejects `totalCount == 0` and `passedCount > totalCount` with `InvalidCounts`.
- A partial certificate reverts with `PartialCannotSupersede` when either the current certificate
  of its projectId, or the target's own latest certificate, is Valid and complete. The second
  case stops a partial issued under another projectId from shadowing a complete one, since
  `isCertified` reads only the latest certificate.
- The registry records which certificate anchors each projectId lineage. On a lineage move that
  certificate is superseded only if it is still Valid. A Revoked one stays Revoked with
  `supersededBy` unset, and `CertificateSuperseded` is emitted either way.
- `latest` reverts with `NoCertificate` for a target without certificates. `isCertified`,
  `isCertifiedWith` and `isLatest` return false in that case.
- `setIssuer` rejects the zero address. The owner is the deployer and is immutable; the owner is
  not an issuer until `setIssuer` is called, which the deploy script does.

## CheckAttestationRegistry results (2026-09-30, forge 1.5.1)

| Check | Result |
|---|---|
| `forge test --match-contract CheckAttestationRegistryTest` | 27 passed, 0 failed (26 unit, 1 fuzz with 256 runs) |
| `forge coverage --report summary` | `src/CheckAttestationRegistry.sol` lines 100% (98/98), statements 100% (137/137), branches 100% (24/24), functions 100% (18/18) |

- An attestation id is the zero based index of a global list; `latest` resolves the newest id of a
  (subjectChainId, subject, standardId) key, standardId = keccak256(bytes(standard)). A new attestation
  supersedes the previous one of the same key when it is Valid, and may not be for an earlier block than a
  Valid latest one. After the latest is revoked any block is accepted, so a wrong block number can be repaired.
- The subject is not required to have code on the registry's chain; its code hash is reported by the issuer.
  For a proxy it is the proxy's own code; the implementation is identified by `implementationKey`.
- `isCompliant` is true only for a Valid latest attestation with pass > 0 and no fail, inconclusive or
  not applicable result; `isCompliantWith` also requires the latest attestation's suiteHash. A revoked
  latest attestation does not fall back to an older one.
- `Attested` carries the submitted `AttestParams` tuple and the issuer (flat event arguments hit stack too
  deep without via-IR). reportURI is at most 512 bytes; zero standardId, implementationKey, suiteHash and
  reportHash are refused.
- The owner is immutable. Removing an issuer leaves its attestations Valid; any issuer can supersede or revoke
  any attestation (ADR 0004, Roles).
- The runtime code holds no CALL, CALLCODE, DELEGATECALL or STATICCALL (a test walks the bytecode), so the
  registry needs no reentrancy guard.

## CheckRequestDesk results (2026-09-30, forge 1.5.1)

| Check | Result |
|---|---|
| `forge test --match-contract CheckRequestDesk` | 34 passed, 0 failed (30 unit, 2 fuzz with 256 runs, 2 invariant with 256 runs x 64 depth) |
| `forge coverage --report summary` | `src/CheckRequestDesk.sol` lines 100% (95/95), statements 100% (114/114), branches 100% (23/23), functions 100% (19/19) |

- Request ids are the zero based index of a global list; `requestOf(id)` reverts with `UnknownRequest(id)` for
  `id >= requestCount()`. `requestCheck` takes exactly `fee` (`WrongFee` otherwise) and refuses a zero subject,
  chain id or standardId. The request keeps the fee it paid; `setFee` only changes new requests.
- `fulfill(id, attestationId)` (worker only, Pending only) reads `registry.attestationOf(attestationId)` and
  requires the same subjectChainId, subject and standardId, `issuedAt >= requestedAt` and a status other than
  Revoked. A Superseded attestation is accepted, and one attestation can close several requests made before it.
- `reject(id, reasonCode)` (worker only) refunds the whole fee in the same transaction; `refundExpired(id)` is
  open to anyone once `block.timestamp >= requestedAt + timeout` and pays the requester, not the caller.
- `withdraw(to)` (owner only) pays `earned - withdrawn`; escrowed fees of Pending requests are never reachable.
  Coins leave through `call` after every state change under a reentrancy lock; a refused transfer reverts
  (`TransferFailed`), so a requester contract that refuses coins keeps its fee escrowed until fulfilled.
- Owner, registry and timeout are immutable; the owner sets the fee and the worker. The desk is deployed with
  `specfirst desk deploy`, from the bytecode bundled in `packages/core/src/desk/artifact.ts`
  (`node packages/core/scripts/gen-desk-artifact.mjs` after `forge build`; `packages/core/test/desk.test.ts`
  compares it with a fresh build).
