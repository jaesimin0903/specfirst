# Specfirst Demo Script (3 minutes)

## Timeline and Narration

### 0:00  -  Problem statement

**Screen: Terminal, black background**

```
$ cat PROBLEM.md

Audit costs 50K-300K USD and takes 2-8 weeks.
We cannot afford it.
Deploy unaudited?
```

**Narration:**

Our staking vault is 200 lines of Solidity. We need someone to check it. Formal audit costs from 50K to 300K dollars with a 2 to 8 week wait. Our team budget is 100K total. We have 2 weeks to launch.

---

### 0:15  -  Spec written in plain language

**Screen: Terminal, spec file**

```
$ cat spec/staking-vault.spec.yaml

name: StakingVault
projectId: "github.com/jaesimin/specfirst-example-vault#StakingVault"
contract:
  path: src/StakingVault.sol
  name: StakingVault
  constructorArgs: ["$DEPLOYER"]
  editable: ["src/"]
solc: "0.8.28"
actors:
  users: 3
  owner: "$DEPLOYER"
  attacker: true
invariants:
  - { id: INV-1, kind: invariant,     text: "total staked equals sum of all user balances" }
  - { id: INV-2, kind: invariant,     text: "vault balance exceeds sum of user balances" }
  - { id: INV-3, kind: postcondition, text: "withdrawal debits exactly the withdrawn amount" }
  - { id: INV-4, kind: access,        text: "user cannot withdraw more than own balance" }
  - { id: INV-5, kind: access,        text: "only owner can change reward rate" }
  - { id: INV-6, kind: invariant,     text: "deposits fail when paused" }
  - { id: INV-7, kind: access,        text: "only owner can pause and unpause" }
unverified:
  - "Oracle price manipulation"
  - "External token contract defects"
  - "Economic attacks"
  - "Owner state changes after deployment"
  - "Upgradeable proxy patterns"
```

**Narration:**

We write seven invariants in plain language. Only this step involves a person. Everything else is automated. We also list five things we are not checking. Honest from the start.

---

### 0:35  -  First fuzz run finds the bug and fixes it

**Screen: Terminal, run output (actual format from run-replay.txt)**

```
$ specfirst run spec/staking-vault.spec.yaml

spec     StakingVault  7 invariants  spec/staking-vault.spec.yaml
lock     ok  specHash 0xeef8d3d9  propertyHash 0x3d99a1ce

run      <PLACEHOLDER_RUN_ID>  impl: buggy legacy code

fuzz #1  forge runs=64 depth=64 seed=1
         4 fail, 3 pass  2.4s
  ✗ INV-1  total staked != sum(balances)
      counterexample:
        1. deposit(amount)  sender=0xca9964...7e  target=<PLACEHOLDER_VAULT>
        2. withdraw(amount) sender=0x00000a...7e  target=<PLACEHOLDER_VAULT>
  ✗ INV-2  vault MON < sum(balances)
      [same counterexample]
  ✗ INV-3  withdraw debit != withdrawn amount
      [same counterexample]
  ✗ INV-4  withdrew more than own balance
      [different counterexample]
  ✓ INV-5
  ✓ INV-6
  ✓ INV-7

fix #1   applying fix from agent
         changed src/StakingVault.sol
         diff: +nonReentrant, move state update before external call
         diff size: 9 lines

fuzz #2  forge runs=64 depth=64 seed=1
         7/7 pass  1.0s
  ✓ INV-1
  ✓ INV-2
  ✓ INV-3
  ✓ INV-4
  ✓ INV-5
  ✓ INV-6
  ✓ INV-7

done     passed in 2 iterations  exit 0
```

**Narration:**

We started with buggy legacy code. The attacker actor re-enters the withdrawal function and reads the old balance twice. Two calls debit the balance once. The fuzzer catches it in the first campaign. The agent reads the counterexample and applies a fix. Nine lines: add nonReentrant guard, move state update before the external call. The second campaign passes. All in 40 seconds of wall clock.

---

### 1:30  -  Deploy and on-chain rehearsal

**Screen: Terminal, deployment and rehearsal (sped up)**

```
[DEPLOYMENT SPED UP 5x]

deploy   monad-testnet  <PLACEHOLDER_VAULT_ADDRESS>
         tx <PLACEHOLDER_TX_HASH>

rehearsal 38 transactions
  25 normal paths: deposit, withdraw, reward update, pause toggle
  5 access control reversions: unpermissioned owner calls, overdraft attempts
  
  receipt 1  deposit  sender=0x<USER_1>  gasUsed=45280 / gasLimit=60000
  receipt 2  deposit  sender=0x<USER_2>  gasUsed=45892 / gasLimit=60000
  ...
  receipt 30 withdraw sender=0x<USER_1>  status=1 gasUsed=52100 / gasLimit=60000
  receipt 31 withdraw sender=0x<ATTACKER> status=0 gasUsed=18700 / gasLimit=80000  
         ✓ access guard: overdraft reverted, gasUsed < gasLimit

done     all 38 txs confirmed
```

**Narration:**

On Monad testnet, we run 38 live transactions. 25 normal paths, 5 access control tests that must fail. For the failing calls, gas limit is fixed at 80K. They all fail with status 0, and gasUsed is much less than limit, proving it was access control rejection, not out of gas. Deployed at <PLACEHOLDER_VAULT_ADDRESS>.

---

### 1:55  -  On-chain verification and certificate issuance

**Screen: Terminal, verify and cert (sped up)**

```
[VERIFICATION SPED UP 8x]

verify   fork testnet at latest  
         running properties on real deployed state
  ✓ INV-1 checksum over all depositors
  ✓ INV-2 vault balance audit
  ✓ INV-3 withdrawal reconciliation
  ✓ INV-4 access control: sender cannot over-withdraw
  ✓ INV-5 access control: non-owner reward rate protected
  ✓ INV-6 pause state invariant
  ✓ INV-7 access control: non-owner pause protected

cert     issue
         projectId: 0x<PLACEHOLDER_PROJECT_ID>
         specHash: 0xeef8d3d9...
         invariantSetHash: 0x<PLACEHOLDER_INV_SET_HASH>
         propertyHash: 0x<PLACEHOLDER_PROP_HASH>
         codeHash: 0x2f8b...0d11
         reportHash: 0x<PLACEHOLDER_REPORT_HASH>
         
         tx issued: 0x<PLACEHOLDER_CERT_TX>
         certId: <PLACEHOLDER_CERT_ID>
         issuedAt: 2026-10-04T12:00:00Z
         status: Valid
         certificate link: <PLACEHOLDER_WEB_HOST>/c/<PLACEHOLDER_VAULT_ADDRESS>
```

**Narration:**

We fork Monad testnet at the latest block, deploy the spec properties into that fork, and run them against the real state of the vault we just deployed. All seven pass. The certificate is issued on-chain. The code hash is locked from deployment time. The report hash commits to the spec and verification results. This link lives on the blockchain.

---

### 2:15  -  Certificate page showing what passed and what did not

**Screen: Browser, certificate page at <PLACEHOLDER_WEB_HOST>/c/<address>**

```
CERTIFICATE DETAILS

Status:  Certified (Valid)   issued 3 days ago

Contract:  0x4a1f...c9e2, monad-testnet

Spec Hash:  sha256:71c0...e9a4
Code Hash:  keccak:2f8b...0d11

Verified Invariants (7/7 passed):

  ✓ Total staked equals sum of user balances
  ✓ Vault balance exceeds sum of user balances  
  ✓ Withdrawal debits exactly the withdrawn amount
  ✓ Only owner can change reward rate
  ✓ User balance cannot go negative
  ✓ Deposits fail when paused
  ✓ Only owner can pause and unpause

NOT VERIFIED (5 items at same prominence):

   -  Oracle price manipulation
   -  External token contract defects
   -  Economic attacks
   -  Owner state changes after deployment
   -  Upgradeable proxy patterns

Auxiliary Campaign Results (human-unreviewed):
  Ultrafuzz 600-second campaign  
  Runs: 12,000  
  Results: 3 candidates, 0 confirmed
  Status: Informational, no blockers reproduced
```

**Narration:**

Anyone can read the certificate. Seven invariants passed. Five things we did not check are shown at the same size and prominence. This is not a clean bill of health. It is a detailed record of what we verified and what we skipped. The unverified list is not buried. The Ultrafuzz auxiliary campaign adds depth. No findings blocked issuance because auxiliary results are human-unreviewed and do not gate deployment.

---

### 2:35  -  Aggregator integration: mock staking route card

**Screen: Browser, mock staking route selection (specfirst demo /demo/aggregator)**

**Text on screen: "Simulated aggregator screen   mock demonstration"**

```
CHOOSE STAKING DESTINATION

Route A: StakingVault v2  0x4a1f...c9e2
  ✓ Certified     7 invariants     3 days ago  
  Monad Standard Vault - Deployed with automated verification
  APY: 8.2%  
  [Default exposure - certificate read via isCertifiedWith]

Route B: LegacyVault v0   0x1d2e...9f4c
  ○ No certificate
  Unverified pool - Not reviewed by Specfirst  
  APY: 8.5%
  [Warning exposure - no certificate found]

Deposit Amount:  [_________] MON  [CONFIRM DEPOSIT]
```

**Narration:**

This is a simulated screen. We are showing what an aggregator can do with a one-line check. The certified vault gets a badge and default routing. The uncertified vault is not blocked, just shown without a badge and marked as warning. The contract call is two lines of code: registry.isCertifiedWith, vault, BASIC_VAULT_INVARIANTS_V1. In the real track 4 judging, one aggregator will integrate by October 8, or this stays mock.

---

### 2:50  -  Code change and versioning without invalidation

**Screen: Terminal**

```
$ # Code change: increase reward limit from 1000 bps to 1100 bps
$ vim src/StakingVault.sol
$ git diff
- uint256 constant REWARD_RATE_MAX = 1000;
+ uint256 constant REWARD_RATE_MAX = 1100;

$ specfirst run spec/staking-vault.spec.yaml --new-version
  [CAMPAIGN SPED UP]
  
deploy   monad-testnet  0x88c0...9f4c (new address)
cert     issue v2
         projectId: <same>
         supersededBy: 0x88c0...9f4c
         
         tx issued: 0x<PLACEHOLDER_CERT_V2_TX>

$ curl https://<PLACEHOLDER_WEB_HOST>/api/cert/0x4a1f...c9e2
{
  "address": "0x4a1f...c9e2",
  "certified": true,
  "status": "superseded",
  "isLatest": false,
  "supersededBy": "0x88c0...9f4c",
  "passed": 7,
  "total": 7,
  "issuedAt": "2026-10-04T12:00:00Z"
}
```

**Narration:**

Code changes break the old certificate. Not because it is automatically invalidated, but because the code hash no longer matches. We deploy at a new address and issue v2 under the same projectId. The v1 address is marked Superseded and points to v2. But v1's isCertified still returns true. That code WAS verified. Just not the latest version. The certificate is fixed in bytecode. Any state changes after deployment are not verified and are not retroactively checked. We do not say automatically revoked. We say the certificate is immutable.

---

### 2:55  -  Summary: entry path and next steps

**Screen: Browser, text slide**

```
SPECFIRST ENTRY PATH

Stage 1 (Track 4, 6 weeks):
  One aggregator integrates the check into their routing UI.
  Target: 1 integration, 10 issued certificates.

Stage 2 (Residency):
  Monad Foundation incentive programs require certificates.
  Entry shifts from sales to policy.

Stage 3 (Next 3 months):
  Wallets show badges on swap screens.
  Escrow verifiers stay orthogonal to us via Blockaid integration.

Stage 4 (Longtail):
  GitHub Actions automate re-issuance per PR.
  Freemium until 3 aggregators adopt.
```

**Narration:**

We do not sell certificates directly to developers. We sell the promise that aggregators will require them. The first win is one routing UI that reads isCertified and hides unverified pools. If aggregators adopt, developers follow. If no one requires certificates, they stay a novelty. That is the bet.

---

## Production Notes

- **Total time:** 3:00 exact.
- **Sped-up sections:** deployment (5x), rehearsal implicit in 38 txs, verification (8x), campaigns (visible label).
- **Placeholders to replace before submission:**
  - <PLACEHOLDER_RUN_ID>
  - <PLACEHOLDER_VAULT_ADDRESS>
  - <PLACEHOLDER_TX_HASH>
  - <PLACEHOLDER_PROJECT_ID>
  - <PLACEHOLDER_INV_SET_HASH>
  - <PLACEHOLDER_PROP_HASH>
  - <PLACEHOLDER_REPORT_HASH>
  - <PLACEHOLDER_CERT_TX>
  - <PLACEHOLDER_CERT_ID>
  - <PLACEHOLDER_CERT_V2_TX>
- **Honesty statements included:**
  1. "We started with buggy legacy code" (0:35).
  2. "This is a simulated screen" (2:15, text on mock card).
  3. "The certificate is fixed in bytecode. Any state changes after deployment are not verified." (2:50).
- **Forbidden characters:** No em-dashes, bullets, underscores, or parentheses in narration.
