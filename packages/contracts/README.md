# @specfirst/contracts

Foundry project for `CertificateRegistry.sol`, the onchain certificate registry described in
`docs/plan.md` section 3.4. Tests follow section 6.1.

## Layout

| Path | Content |
|---|---|
| `src/CertificateRegistry.sol` | Registry: issue, revoke, lineage per projectId, isCertified, isCertifiedWith, isLatest |
| `test/CertificateRegistry.t.sol` | Unit tests for every 6.1 case |
| `test/CertificateRegistry.invariant.t.sol` | Handler based invariant tests |
| `script/Deploy.s.sol` | Deploys the registry and allows the deployer as issuer |
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
