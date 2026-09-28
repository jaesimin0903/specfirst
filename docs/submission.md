# Specfirst: Verified Contracts via Automated Spec

## One-Line Summary

Specfirst issues on-chain verification certificates for smart contracts via automatic fuzzing and deployment verification, updating live as code changes and surfacing what was and was not checked.

---

## Problem

Audit costs USD 50,000 to 300,000 and takes 2 to 8 weeks. Most contracts never get audited. In September 2026, 0x analyzed 84,163 Uniswap v4 hooks across six chains and classified 54 percent as malicious, most of them quote spoofing that shows a good price at simulation time and settles worse. In May 2026 the Grok and Bankr agent wallet was drained through prompt injection with no key theft and no contract exploit. Together they show the gap between what needs review and what gets review.

Aggregators then face a choice. Manually check every pool and vault before listing, do not scale. List everything and get sued when pools collapse. Or find another signal. Right now they have none. Specfirst provides one.

---

## What We Built

| Number | Deliverable | Status | Link |
|---|---|---|---|
| D1 | CLI: init, lock, run, deploy, verify, cert, status | Complete | github.com/jaesimin/specfirst |
| D2 | CertificateRegistry smart contract with isCertified, isCertifiedWith, isLatest, version tracking | Complete | <PLACEHOLDER_REGISTRY_ADDRESS> |
| D3 | Web: certificate page, REST API /api/cert/[address], public links | Complete | <PLACEHOLDER_WEB_HOST>/c/[address] |
| D4 | GitHub Action for PR verification and badge widget | Complete | github.com/jaesimin/specfirst-example-vault |
| D5 | Demo video, 3 minutes | Complete | <PLACEHOLDER_VIDEO_LINK> |
| D6 | This submission page with links and reproduction steps | Complete | <PLACEHOLDER_WEB_HOST>/submit |
| D7 | Sample StakingVault spec and three issued certificates | Complete | tx <PLACEHOLDER_CERT_1_TX>, tx <PLACEHOLDER_CERT_2_TX>, tx <PLACEHOLDER_CERT_3_TX> |
| D8 | Aggregator integration demo, L0-L3 result by Oct 8 | <PLACEHOLDER_L_LEVEL> | See Section 6 |

---

## How It Works: Five-Step Pipeline

### Step 1: Write Spec in Plain Language

Developer writes seven to ten invariants as plain English in YAML. Only step that requires a person.

```yaml
invariants:
  - id: INV-1
    kind: invariant
    text: "Total staked equals sum of all user balances"
  - id: INV-2  
    kind: invariant
    text: "Vault balance exceeds sum of all user balances"
  - id: INV-4
    kind: access
    text: "User cannot withdraw more than own balance"
unverified:
  - "Oracle price manipulation"
  - "External token contract defects"
  - "Economic attacks"
  - "Owner state changes after deployment"
  - "Upgradeable proxy patterns"
```

### Step 2: Automatic Fuzzing with Counterexample Loop

CLI runs Foundry invariant fuzzer. If an invariant fails, the counterexample is sent to Claude Code agent, which reads the failing transaction sequence and applies a fix. Result loops back to fuzzing. Upper limit 5 iterations per invariant. If unresolved, the certificate marks that invariant as unverified.

### Step 3: Deploy and Live Rehearsal

CLI deploys contract to Monad testnet. Runs 30 normal transactions, 5 access control tests expected to revert. All transactions are real on-chain.

### Step 4: On-Chain Verification

CLI forks Monad testnet at latest block, runs the locked Solidity properties against the real state of the deployed contract, and cross-checks events. Access control invariants verified by receipt status and event absence over getLogs ranges.

### Step 5: Issue Certificate and Notify

Registry.issue() is called on-chain with spec hashes, code hash, verification results, and report hash. The certificate is immutable. Code hash ties verification to a specific bytecode. Subsequent changes require re-verification and re-issuance.

### Certificate Fields and State Machine

| Field | Meaning |
|---|---|
| projectId | Developer project identifier, keccak256 of spec projectId string |
| specHash | SHA256 of spec YAML, canonical form |
| invariantSetHash | Keccak256 of invariant IDs, kinds, text, and unverified list only, stable across name or schedule changes |
| propertyHash | Keccak256 of locked Solidity property files, developers can require this match for complete confidence |
| codeHash | target.codehash captured at deployment time, certificate reads it each time and compares |
| reportHash | Keccak256 of full verification report JSON stored on IPFS/Arweave, immutable |

| Status | Meaning | isCertified() | isLatest() |
|---|---|---|---|
| Valid | Passed, current version | true | true |
| Superseded | Passed, but newer code issued under same projectId | true | false |
| Revoked | Violation found after deployment | false | false |
| None | Never issued | false | false |

View isCertified(address) returns true only if most recent certificate is Valid or Superseded AND code hash matches AND all invariants passed. View isCertifiedWith(address, invariantSetHash) adds requirement that the certificate matches the requested invariant set, so aggregators can filter by their baseline invariant version.

---

## Honesty Section: What the Certificate Proves and What It Does Not

### The Certificate Guarantees

1. The contract code matched the bytecode at issuance time, if code hash no longer matches, isCertified returns false.
2. A machine-checked specification in Solidity was compiled and run against the deployed contract's state fork.
3. All invariants in the certificate passed the verification campaign.
4. The specification and verification results are immutable on-chain.

### What the Certificate Does NOT Guarantee

1. Oracle price manipulation, does not check oracle inputs or price freshness.
2. External token contract defects, does not verify third-party contracts the vault calls.
3. Economic attacks, does not model incentive-based attacks or liquidity crunches.
4. Owner state changes after deployment, does not continuously watch for owner privilege abuse post-issuance.
5. Upgradeable proxy patterns, only supports non-upgradeable bytecode.

Ultrafuzz auxiliary campaign is human-unreviewed and provided only for depth of fuzz coverage. No findings from Ultrafuzz block issuance.

**Trust model:** The issuer is a single key held by Specfirst. The certificate claims Specfirst ran the verification and locked the code hash. Verification is reproducible, anyone can run the same Foundry properties and report against the locked code and compare hashes.

---

## Verification: How the Judges Can Verify Work Done in Six Weeks

1. **Repository history:** github.com/jaesimin/specfirst. Git log shows first commit September 27, 2026. All work committed before October 13, 2026 deadline.
2. **Live certificates on Monad testnet:**
   - Certificate 1 (sample v1): <PLACEHOLDER_CERT_1_TX>
   - Certificate 2 (sample v2): <PLACEHOLDER_CERT_2_TX>
   - Certificate 3 (Action-issued): <PLACEHOLDER_CERT_3_TX>
3. **Reproduction command:**
   ```bash
   git clone https://github.com/jaesimin/specfirst.git
   cd specfirst/examples/staking-vault
   pnpm install
   pnpm build
   specfirst run spec/staking-vault.spec.yaml
   specfirst status 0x<vault_address>
   ```
   Result will match the certificates linked above.

---

## Aggregator Integration Results (L0-L3 by October 8)

| Level | Definition | Status |
|---|---|---|
| L0 | No response | <PLACEHOLDER_L_LEVEL_DETAIL> |
| L1 | Reply with interest or feedback | <PLACEHOLDER_L_LEVEL_DETAIL> |
| L2 | Integrated on staging or testnet screen | <PLACEHOLDER_L_LEVEL_DETAIL> |
| L3 | Merged into production repository or live environment | <PLACEHOLDER_L_LEVEL_DETAIL> |

Contacts attempted: Moose (FastLane protocol), Kuru (Momentum program). Message sent via hackathon mentor channel and direct Discord. See docs/bd-log.md for full contact log and replies.

**Claim:** We will not claim 1 integration unless L2 or above is achieved. If L0 or L1, the demo card is explicitly labeled mock.

---

## Certificate Issuance: Target vs. Actual

| Milestone | Target | Actual | Notes |
|---|---|---|---|
| Sample v1 | Oct 4 | <PLACEHOLDER_DATE_1> | First end-to-end pass |
| Sample v2 | Oct 6 | <PLACEHOLDER_DATE_2> | Version supersession |
| GitHub Action v3 | Oct 9 | <PLACEHOLDER_DATE_3> | Automated CI/CD pipeline |
| External requests | Up to 5 teams | <PLACEHOLDER_EXTERNAL_COUNT> | Recorded in bd-log.md |

---

## Roadmap: Beyond Track 4

1. **External issuance service:** Today, only Specfirst issues certificates via CLI and Action. Future: a SaaS endpoint where aggregators send report JSON and receive certificates without holding issuer keys.
2. **ProjectId ownership binding:** First issuer of a projectId can claim it via signature. Prevents collisions and allows developer updates without new projectId.
3. **Category-based invariant sets:** Monad Foundation or aggregators define "Basic Vault v1" or "LST Collateral v1" as canonical invariant-set hashes. Developers target that hash. Aggregators whitelist by hash, not by individual certificate.
4. **Violation revoke with evidence:** Specfirst runs continuous on-chain monitoring post-issuance. If deployed code violates the certified invariants, the certificate auto-revokes via oracle and posts evidence.

---

## Team

Jaemin Lee, solo developer, full-stack implementation. Background: Web3 financial infrastructure, Despell DAO treasury protocols, multi-chain deployment and testing. Completed core logic, agent integration, contract, web frontend, and CLI in 6 weeks solo. Parallel ongoing full-time job search and interview commitments.

---

## Links for Judges

- **Live certificate (v1):** <PLACEHOLDER_WEB_HOST>/c/<PLACEHOLDER_VAULT_ADDRESS_V1>
- **Live certificate (v2):** <PLACEHOLDER_WEB_HOST>/c/<PLACEHOLDER_VAULT_ADDRESS_V2>
- **Certificate registry address:** <PLACEHOLDER_REGISTRY_ADDRESS> (Monad testnet, chain 10143)
- **REST endpoint test:** https://<PLACEHOLDER_WEB_HOST>/api/cert/<PLACEHOLDER_VAULT_ADDRESS>
- **Sample repository:** github.com/jaesimin/specfirst
- **Sample vault with Action:** github.com/jaesimin/specfirst-example-vault
- **Demo video:** <PLACEHOLDER_VIDEO_LINK>
- **Full contact log:** docs/bd-log.md

---

Submitted: October 13, 2026
