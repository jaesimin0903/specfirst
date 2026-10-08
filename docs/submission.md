# Specfirst: a recall service for ERC-4626 vaults on Monad

## One line

Specfirst watches Monad mainnet, checks every ERC-4626 vault the moment it is deployed or first funded against 30 public properties, records the result on chain, and alerts the people and contracts whose money sits in a vault when that vault gets worse.

Track 4, Trust, Identity and AI Infrastructure.

---

## The problem, in one vault

A curator's bot asks a vault how much it can take out right now.

| Who | Call | Answer |
|---|---|---|
| Bot | `maxWithdraw` | 801,365.61 AUSD |
| Bot | `withdraw` of 796,956.94 AUSD | reverts with `WithdrawalRequestRequired` |

That is Upshift earnAUSD `0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E` on Monad mainnet, measured on a fork of block 109,061,472 with a test user. EIP-4626 says `maxWithdraw` must return 0 when a withdrawal would revert. The vault answers with the whole balance, so anything that sizes its exits from the standard's answers gets stuck.

The callers that rely on these answers are the ones that move money into vaults without a person in the loop: curators and allocator vaults, yield bots and AI agents, and lending markets that take vault shares as collateral. Today the only way for them to know how a vault really behaves is to write and run tests against each vault themselves. Monad has more than 400 ERC-4626 vaults and new ones appear every day.

---

## What Specfirst does

1. **Finds vaults by itself.** Nobody registers anything. The watcher reads Monad mainnet for vault creation events of five factories, Euler EVK, Morpho Vault V2, MetaMorpho 1.1, Euler Earn and Neverland, for the first `Deposit` of any address, which catches vaults deployed without a factory, and for proxy upgrades of vaults it already knows.
2. **Checks each one against 30 properties.** 26 come from a16z/erc4626-tests, a public third-party suite, so the vault team does not write the test that grades it. 4 are Specfirst's own and ask whether `maxDeposit`, `maxMint`, `maxWithdraw` and `maxRedeem` are honored when called with exactly that amount. The check runs on a fork of the live state at a fixed block and takes a few seconds to about a minute.
3. **Records the result on chain.** `CheckAttestationRegistry` on Monad testnet stores the report hash, the suite hash, the vault's code hash and the block. A contract reads it with one call, `isCompliant`. The board shows every vault with the sentence of EIP-4626 it contradicts and the concrete call that shows it.
4. **Alerts when a vault gets worse.** A subscription costs 0.05 MON a day. Subscribers get a webhook and an inbox entry when a re-check changes the result, when an upgrade changes the code, and when the value of a share falls.
5. **Lets contracts and agents act on it.** `AllocationGate` is a demo integrator contract. It deposits only into vaults whose latest attestation is compliant, and once that changes anyone can make it pull the money out. For AI agents, an MCP server answers `check_before_moving_funds` with refuse, caution or proceed and the reasons, reading the report and the on-chain attestation itself.

Results stay free and public. The service sells delivery and freshness: alert subscriptions, and a request desk for an immediate re-check.

---

## What it found

### On mainnet

On October 8 the board covered 459 ERC-4626 vaults on Monad mainnet. 285 came from a hand-made list built from Morpho, Euler, Curvance, Neverland, DefiLlama and protocol docs. The other 174 were found on chain by the watcher; they were not on that list, and the number grows as it runs.

Each failure is labeled with its level in EIP-4626. A MUST failure contradicts a MUST sentence. A SHOULD failure only goes against guidance, for example rounding that favors the caller by a unit.

| Vault | Found by | What fails | Level |
|---|---|---|---|
| Upshift earnAUSD `0xD793..dA5E` | first sweep | `maxWithdraw` and `maxRedeem` report the whole balance while every withdraw and redeem reverts. The board labels it as an asynchronous vault, which ERC-7540 still asks to report 0 here | MUST |
| Aarna atvYieldMax `0x4C09..d6C6` | first sweep | withdrawals are paused but the max functions are not 0 | MUST |
| Euler EVK eeUSD-4 `0xf26d..95Bf` | first sweep | a hook refuses deposits from unlisted users while `maxDeposit` says nearly unlimited | MUST |
| Curvance hyAUSD `0xaD66..00Bf` | watcher, first deposit | the four preview functions disagree with what deposit, mint, withdraw and redeem then do | MUST |
| LeverUp sLVMON `0x61b2..2b9c` | watcher, first deposit | `maxWithdraw` ignores a 5 basis point exit fee, so withdrawing the reported maximum reverts | MUST |
| locked.aprMON `0x79b0..76c5` | watcher, first deposit | during a 15 day lock the max functions report the whole balance | MUST |
| tyYIELD `0xB464..1408` | watcher, first deposit | round trips favor the caller by a rounding sized amount | SHOULD |

The watcher found and checked the last four with nobody asking, and attested three of them on chain. locked.aprMON has no attestation yet, because that day's budget for attesting failures of newly found vaults was already used. These are disagreements with sentences of the standard, each shown by a concrete call on a fork. None of them is a claim that funds are at risk, and we did not contact the teams.

### On testnet, end to end, October 7

The whole loop ran on Monad testnet with real transactions and no person between the steps. All times are UTC.

| Time | What happened |
|---|---|
| 08:26:54 | A new vault is deployed through `DemoVaultFactory`, block 68,922,607 |
| 08:27:12 | The watcher found it, ran 30 properties, all passed, and wrote attestation #26. 18 seconds after deployment |
| 08:27:33 | `AllocationGate` deposits 60 tokens. Allowed because #26 is compliant |
| 08:29:12 | The vault operator sends 3% of the vault's assets away |
| 08:32:14 | The watcher confirms the fall at a second block and sends the subscriber's webhook: share value fell 3.00% |
| 08:32:26 | The operator switches on a bug in `previewDeposit` |
| 08:33:23 | A subscriber re-check fails, 57 seconds later |
| 08:35:40 | A second check at a later block confirms it. Attestation #27, not compliant, and a webhook |
| 08:35:50 | A keeper whose key is not the owner's calls `exit`. The gate gets 58.2 tokens back for its 60 shares, the 3% loss included |

From the bug to the money being out took 3 minutes 24 seconds, and no one with the owner's key acted.

### An AI agent asking first, October 8

Claude Code was given the Specfirst MCP server and asked to put 50,000 into one of two vaults, Upshift earnAUSD or Steakhouse High Yield USDC, and to check first. It called `check_before_moving_funds` four times and got refuse for both deposit and withdraw on Upshift, because `withdraw` reverts below what `maxWithdraw` reports and attestation #15 is not compliant, and proceed for both on Steakhouse, which passed all 30 properties with attestation #17 compliant. It chose Steakhouse and noted that a pass is not a safety guarantee.

---

## Who pays, and the numbers so far

| | MON |
|---|---|
| Earned, request desk fees | 0.20 |
| Earned, subscription days started | 0.05 |
| Desk worker gas | 0.1243 |
| Watcher gas, both chains | 0.3521 |
| **Net** | **-0.2265** |

The service loses money today, and we show it that way on the desk page. The watcher only spends gas on attestations. They are capped at 15 a day at about 0.05 MON each, so the worst case is about 0.75 MON a day, which 15 subscription days cover. Every check result is free; what a subscriber pays for is being told first.

---

## How to check our work

- **Every result reproduces.** Each report under `certs/checks/<chainId>/<address>/` names its block, seed and senders. `specfirst check <address> --standard erc4626 --block <block> --runs 16 --seed <seed>` runs the same check. The keccak256 of the report in canonical JSON, keys sorted and no whitespace, equals the `reportHash` on chain, and each vault page recomputes it in the browser. Attestations recorded before October 8 name raw.githubusercontent.com/jaesimin/specfirst, a path we do not control; the same files are in this repository and match the on-chain reportHash.
- **Contracts on Monad testnet, chain 10143.**

| Contract | Address |
|---|---|
| CheckAttestationRegistry | `0x3754918bBB8481D046D80718a9efe434e353daF7` |
| CheckSubscriptions | `0xA1A205C1eF2Ecd2354DE900276C74Fb34b7119a4` |
| CheckRequestDesk | `0x4de46c70cB77C5Fcbe083C436bb42F097CBFafeb` |
| AllocationGate | `0xEE966282544FF5e0429e754856197A13b8340C8A` |
| DemoVaultFactory | `0xE1FC8fa26Cb7496A68DD4e0ba896Ed8CAE2238FB` |

- **Tests.** forge 195, core 569, cli 115, web 323, mcp 117, all passing. `scripts/check-chars.sh` runs with them.
- **Decisions.** `docs/adr/` records each design decision and what changed after review: third-party properties in 0003, the registry in 0004, the desk in 0005, the watcher and subscriptions in 0006, the gate in 0007, the MCP server in 0008.

---

## What a result means and what it does not

- **Pass** means no counterexample to these 30 properties was found at that block, with 16 runs a property. It does not mean the vault is safe.
- **Mismatch** means a disagreement with an EIP-4626 sentence, shown by a concrete call. It is not a claim that funds are at risk.
- **Inconclusive** is never turned into a pass. Some Monad vaults call staking precompiles that the forge fork does not have. A call that touched one is left unjudged, and a property with an unjudged input cannot pass.
- **A vault cannot talk its way down.** The level of a failure never depends on revert text or logs the vault controls, and a withdraw or redeem failure is always a MUST.
- **Trust.** Attestations about mainnet vaults live on testnet. The issuer reports the mainnet code hash, and anyone can rerun the check at the recorded block and compare. A contract that reads the registry trusts its issuers, nothing more.
- **Known limits.** A result is about one block. A vault that detects it is running on a fork can behave differently there. Asynchronous vaults are labeled, not excused.

---

## Built during the hackathon

| Part | What it is |
|---|---|
| `specfirst check` | runs the 30 properties on a fork of any chain at a fixed block and writes a report |
| `specfirst watch` | the unattended watcher: factory, first deposit and upgrade signals, scheduled re-checks, share value reads, attestation budget, alerts |
| Contracts | CheckAttestationRegistry, CheckRequestDesk, CheckSubscriptions, AllocationGate, demo vault factory and token |
| `specfirst worker` | fulfils paid desk requests without a person |
| Web | the board, a page per vault, the watcher's live feed, the alerts inbox, the desk with revenue and gas, the gate |
| API and badge | JSON per vault and an SVG badge for integrators |
| `@specfirst/mcp` | an MCP server for AI agents: `check_before_moving_funds`, `vault_verdict`, `recent_findings`, `how_to_watch`. It holds no keys, only reads |
| Deploy bundle | Docker Compose for one server running the web and every worker, with HTTPS through Caddy |

---

## Next

1. **Talk to curators.** The first users we want are allocators that already move money between Monad vaults.
2. **Asynchronous vaults.** Add ERC-7540 properties so request based vaults are graded on the flow they actually offer.
3. **More issuers.** Let integrators pin the issuers they trust, so the registry does not depend on one key.
4. **More signals.** Oracle and parameter changes of known vaults, next to upgrades and share value.

---

## Team

Jaemin Lee, solo. Background in Web3 financial infrastructure, DAO treasury protocols and multi-chain deployment.

---

## Links

- **Board:** https://specfirst.jaesimin.xyz
- **Watcher feed:** https://specfirst.jaesimin.xyz/watch
- **Allocation gate:** https://specfirst.jaesimin.xyz/watch/gate
- **Repository:** github.com/jaesimin0903/specfirst
- **Demo video:** <PLACEHOLDER_VIDEO_LINK>

Submitted October 13, 2026.
