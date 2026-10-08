# Specfirst

Specfirst checks ERC-4626 vaults on Monad mainnet against 30 third-party properties, records each result on chain and alerts the people who subscribed to a vault when its result changes. Built for Monad Metropolis, Track 4.

- The watcher (`specfirst watch`) reads Monad mainnet and finds vaults by itself: from factory events, from the first `Deposit` of an unknown address and from proxy upgrades. It checks each one with `specfirst check` on a fork at a fixed block: 26 properties from a16z/erc4626-tests and 4 of Specfirst's own that check `maxDeposit`, `maxMint`, `maxWithdraw` and `maxRedeem` are honored. A changed result is confirmed by a second check at a later block.
- Results are attested on Monad testnet in `CheckAttestationRegistry` (first checks of vaults a factory announced, confirmed fails and confirmed changes, within a daily budget), so a contract can read `isCompliant` in one call. Every report names its block, seed and senders, so anyone can rerun the check and compare.
- Subscribers to a vault (`CheckSubscriptions`, a fee per day in testnet MON) get a webhook when its result changes or its share value falls. `CheckRequestDesk` takes paid requests for an immediate check.
- `AllocationGate` is a demo integrator on Monad testnet: it deposits only into vaults whose latest attestation is compliant, and anyone can make it pull its money out once that changes.
- A failed property is a mismatch with a sentence of EIP-4626, shown by a concrete call on a fork. It is not a claim that funds are at risk.

Where to read more: `docs/submission.md` (what it does and what it found), `docs/board-results.md` (results and the vaults that fail, in Korean), `docs/adr/` (each design decision and its reviews), `docs/plan.md` (the original plan, with what changed at the top, in Korean), `packages/mcp/README.md` (the MCP server for AI agents). Running the live system on one server with Docker Compose: `docs/deploy.md`.

## Keys

Commands that send transactions read `DEPLOYER_PRIVATE_KEY` and `ISSUER_PRIVATE_KEY` (and `REQUESTER_PRIVATE_KEY` for `desk request` and the test subscriber of `subs`, `WATCH_ISSUER_PRIVATE_KEY` for `watch`, `KEEPER_PRIVATE_KEY` for `watch demo gate keep`) from the environment; they do not read `.env` on their own. Copy `.env.example` to `.env`, fill it in, and run with Node's env loader:

```
node --env-file=.env packages/cli/dist/index.js <command>
```

`.gitignore` ignores every name that starts with `.env` except `.env.example`, so a Finder copy such as `.env copy.example` is not committed by accident.

## Exit codes

| Code | Command | When |
|---|---|---|
| 2 | `init`, `lock`, `run` | the spec file is invalid |
| 3 | `lock` | a mutant does not break the property it targets |
| 10 | `run` | the fix loop ran out of iterations or stalled |
| 11 | `run` | the project no longer matches `.specfirst/lock.json` |
| 12, 13, 14 | `deploy`, `verify`, `cert`, `attest-registry`, and those stages of `run` | a deploy failed; a deployed contract violates an invariant; issue, revoke or attest failed |
| 15 | `run` | a run or the total spend passed its cap |
| 16, 17 | `check` | a property failed; nothing failed but the check is incomplete |
| 18 | `desk`, `worker` | a desk action failed or was refused |
| 19 | `watch` | the watcher cannot start, or a `--once` pass cannot read the subject chain; a `watch demo` or `watch demo gate` action failed or was refused |
| 20 | `subs` | a subscriptions action failed or was refused |

Each is a `*_EXIT_CODE` constant of `@specfirst/core`; `packages/core/test/exit-codes.test.ts` keeps them distinct. 1 is anything else.

## Check attestations

`specfirst check` results for contracts on any chain, Monad mainnet included, are recorded on testnet in `CheckAttestationRegistry` with `specfirst attest-registry deploy`, `specfirst cert attest <report.json>` and read back with `specfirst cert attestation <chainId> <address>`. See `docs/adr/0004-check-attestation-registry.md` for the trust model and what `isCompliant` does and does not mean.

`cert attest` copies the report to `certs/checks/<chainId>/<address>/<block>-<hash8>.json` before it sends anything, and records `reportURI = <--report-base-url>/<chainId>/<address>/<block>-<hash8>.json`. Off anvil `--report-base-url` is required, so that anyone can fetch the report. Our reports are published from this repository, github.com/jaesimin0903/specfirst (public once it is opened), so the value we use is:

```
node --env-file=.env packages/cli/dist/index.js cert attest <report.json> \
  --report-base-url https://raw.githubusercontent.com/jaesimin0903/specfirst/main/certs/checks
```

Attestations recorded before 2026-10-08 name `https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks/...`, a GitHub account that is not ours. A reportURI cannot change on chain, but the same files are in this repository and still match each attestation's reportHash, so the web and the MCP server link that prefix here instead (`reportLinkOf`) and keep the on-chain string next to the link.

Commit and push the copy under `certs/checks/` so the URI resolves. `attest-registry deploy` makes the address of `ISSUER_PRIVATE_KEY` the issuer by default (the deployer when that key is unset); `attest-registry set-issuer <address> [--remove]` changes issuers later, signed by the owner (`DEPLOYER_PRIVATE_KEY`).

## Request desk and worker

`CheckRequestDesk` lets anyone pay a fee in testnet MON to have a vault checked; the worker checks it without anyone in the loop, attests the result in `CheckAttestationRegistry` and fulfills the request, and the fee is ours only once it is fulfilled. A request the worker cannot serve is rejected with a full refund, and anyone can refund a request that is still open after the timeout. See `docs/adr/0005-check-request-desk.md` for the escrow, the fulfill conditions and the worker's trust model.

```
# owner = DEPLOYER_PRIVATE_KEY, worker = address of ISSUER_PRIVATE_KEY, registry = $SPECFIRST_ATTEST_REGISTRY_10143
node --env-file=.env packages/cli/dist/index.js desk deploy --network monad-testnet --fee 0.1 --timeout 21600
export SPECFIRST_DESK_10143=0x...                       # printed by desk deploy

# a test request paid from REQUESTER_PRIVATE_KEY (users request from the web)
node --env-file=.env packages/cli/dist/index.js desk request 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E --subject-chain 143

# the unattended worker: signs with ISSUER_PRIVATE_KEY, reads Monad mainnet, NDJSON log
node --env-file=.env packages/cli/dist/index.js --json worker --network monad-testnet --subject-rpc "$MONAD_MAINNET_RPC" --runs 16 --poll 15

node --env-file=.env packages/cli/dist/index.js desk status                      # requests, earned, withdrawn, escrowed
node --env-file=.env packages/cli/dist/index.js desk withdraw --to 0x...          # owner: earned fees only
```

The worker keeps its cursor in `.specfirst/worker/state.json` and writes each request's progress to `.specfirst/worker/status.json` (schema `workerStatusSchema` in `@specfirst/core/desk`). Its report copies go to `certs/checks/` with `reportURI` under `--report-base-url` (default `$SPECFIRST_REPORT_BASE_URL`, else the raw GitHub URL above); commit and push them so the URIs resolve.

A subject RPC failure never refunds: the request waits and is tried again in a later pass while there is time for a check. A report with properties inconclusive on fork RPC errors is checked again, not attested. Each check has a budget (`--check-timeout`, 600 s); one that runs out is rejected without a retry and its vault is not checked again for a day. An attestation that already checked the vault as of the request, also one of the watcher, delivers it without a second check, and the attest transaction is recorded before its receipt so a crash never attests twice. ADR 0005 has the details.

## Watcher

`specfirst watch` turns chain events into checks without anyone asking (docs/adr/0006-chain-as-entry-point.md). It reads the subject chain's logs from a cursor (Monad mainnet by default, read only), finds new ERC-4626 vaults from factory events and from `Deposit`, `Upgraded` and `BeaconUpgraded` of unknown emitters, probes each with the desk worker's pre-check, queues one check per vault (subscribed, new candidate, upgrade or implementation change, first deposit, sweep), checks at `head - 10` and saves the report under `certs/checks/`. A change against the vault's last check (or a first check that fails a property) is confirmed by a second check at a later block before anything follows from it. Every check is a line in the feed; an attestation on testnet needs three things: the vault has no Valid attestation or the outcome (the four counts, the failed property ids, the implementation key) differs from its latest one; the check is in one of the classes below; and the budgets allow it.

Attestation classes (the `reason` of each `checked` event names the class, or why none applies): `subscribed`, a subject with an active subscription, at its first check after the subscription started and at a confirmed change; `factory`, a vault a factory announced, at its first check and its first-deposit re-check; `fail`, a confirmed check with a failed property; `attested-change`, a confirmed change of a vault that already has a Valid attestation. A Deposit candidate that passes, the first-deposit re-check of a vault no factory announced and an unchanged sweep are recorded, not attested.

```
# once: register the watcher's own issuer (the desk worker keeps ISSUER_PRIVATE_KEY, two processes on one key collide on nonces)
node --env-file=.env packages/cli/dist/index.js attest-registry set-issuer <address of WATCH_ISSUER_PRIVATE_KEY> --network monad-testnet

# the unattended loop: Monad mainnet in, attestations on testnet out, NDJSON log
node --env-file=.env packages/cli/dist/index.js --json watch --network monad-testnet

# read only: decide and record, send nothing (no key needed); backfill a range and stop
node --env-file=.env packages/cli/dist/index.js watch --no-attest --from-block 110930500 --to-block 110930700 --once --sweep-per-hour 0

# the signal sources (built in for 143, or --sources <file>); --verify decodes each fixture from the chain
node packages/cli/dist/index.js watch sources --verify
```

- Signer: `WATCH_ISSUER_PRIVATE_KEY`, an issuer of the registry next to the desk worker's key, or the variable `--issuer-key-env <NAME>` names (a second watcher, such as the testnet demo, signs with its own key). `--share-issuer-key` falls back to `ISSUER_PRIVATE_KEY` when the key is unset; never run the worker at the same time then. One watcher per key for the user: the lock is `issuer-<address>.lock` in `$SPECFIRST_LOCK_DIR` (default `<cache dir>/locks`), next to `watch.lock` in the watch directory. `--network monad-mainnet` is refused for attesting, and nothing is ever sent to the subject chain.
- Subject RPC: `--subject-rpc` (repeat it for fallbacks; forge forks from the first), else `$MONAD_MAINNET_RPC`, else `https://rpc1.monad.xyz` then `https://rpc.monad.xyz`. getLogs starts with `--log-window` blocks (10,000) and shrinks to what the node accepts (`rpc.monad.xyz` and the testnet RPC take 100); a node error on one RPC goes to the next.
- Budgets (about 0.052 testnet MON per attestation): `--max-attest-per-day` (15, every class), `--max-unsolicited-per-day` (10, the classes nobody subscribed to, of them at most 3 for fails of candidates no factory announced and nobody attested), `--max-attest-per-subject` (2 per vault per UTC day) and `--min-balance` (0.3 MON: below it nothing is sent). An attestation a budget holds back waits in the state and is tried again when the budget allows (a failed send after 1, 2, 4 minutes and so on up to an hour, with one error line an hour at most); `status.json` shows the budgets, the issuer's balance and, when nothing is sent, why. An attest transaction is recorded in the state before its receipt is awaited and looked up in the next pass when the receipt does not come, so a lost receipt or a restart never sends a second attestation; nothing is sent while one is open or the issuer has a pending transaction (`paused` in `status.json` says so), one pending for 10 minutes goes out again with its nonce and a 25% higher fee (at most three times), and budgets and `gasCostWei` count what was mined. Held-back attestations go by class when several are due: subscribed, a change of an attested vault, a fail, a factory's vault.
- Cadence: `--sweep-hours` (24) and `--sweep-per-hour` (6, 0 turns the sweep off), `--subscribed-minutes` (60), `--check-timeout` (600 s per check; a check that runs out is recorded, not attested and not retried, and the vault cools down for an hour, then two, four...; forge gives a test call at most 100 million gas). An Upgraded or BeaconUpgraded of a known vault re-checks it when it names an implementation the last check did not run or its code or an EIP-1967 slot changed (a fingerprint not read waits for a later pass), otherwise at most every 6 hours. A change is confirmed by a second check that agrees on what changed; four that never agree are recorded as unstable. Each sweep cycle checks with a new fuzz seed per vault; a confirmation reuses the seed of the check it confirms. `--once` reads up to the head (or `--to-block`) and runs every due check; `--to-block` alone stops once the queue is empty.
- Floods: each topic is read with its own getLogs, signals are taken once per emitter and pass, at most 20 probes run per pass (the rest wait for the next), an address the probe rejected is probed again only after a day unless its code changed, and a block the node refuses even alone is passed over with an error line.
- What is never attested: a report in which a property is inconclusive because the fork RPC failed (the vault is checked again later), a check older than the subject's latest Valid attestation from any issuer (checked again at a new block), a report the identity check refuses (checked again), and a check that timed out. An RPC failure or a rate limit during the probe is never "not a vault". Each check uses a fuzz seed of its own vault, so a result moves with the vault's state, and forge replays that vault's earlier counterexamples first.
- Files in `.specfirst/watch/<subjectChainId>/`: `feed.ndjson` (append only, one event per line), `status.json` and `vaults.json` (rewritten atomically), with zod schemas in `@specfirst/core/watch` (browser-safe, like `@specfirst/core/desk`), plus the watcher's own `state.json` (cursor, queue, rejected probes, budgets, pending confirmations, cooldowns, attest transactions awaiting a receipt), its `forge-failures/` and `watch.lock` (one watcher per directory). The state is written with fsync; on start a cut last feed line and temp files of an interrupted write are removed. The known set starts from `certs/checks/<chainId>/`; a report there newer than a vault's last check (a desk check) goes through the change decision on start. The web reads the directory from `SPECFIRST_WATCH_DIR` (default `<repo>/.specfirst/watch`).
- Share value: the watcher reads `convertToAssets(10 ** decimals())` of a vault at the block it reads (head minus lag): subscribed vaults every 30 s, vaults with a Valid attestation every `--price-minutes` (5; 0 turns the reads off), and with `--price-all` every other known vault too, at most `--price-reads-per-minute` (60) in all, a quarter of them kept for the attested ones. A read is one eth_call through Multicall3 where the chain has it (Monad mainnet and testnet do), else three. A fall of more than `--price-drop-bps` (10) basis points from the reference, seen again at least 10 blocks and 2 minutes later, is a `changed` event with `change.kind: 'price-drop'` and both values and blocks; it is saved, then delivered to the vault's subscribers (webhook `kind: 'price-drop'` with an idempotency `key`), and queues a re-check (source `price-drop`, at most one per vault every 6 hours, at the sweep's priority unless subscribed). At most `--max-price-drops-per-day` (4) drop events of one vault a day, unless a drop is larger than the day's largest or at least ten times the threshold; over the cap the reference stays, so the loss is announced once allowed. The drop itself is never attested. The reference rises only to a value seen at two blocks (a one-read spike is no reference), a fall within the threshold keeps it (small falls add up), a vault with no shares, a revert or an out-of-gas on every RPC records nothing, an RPC failure is never a drop, and a fall not confirmed within an hour or five reads without a value is forgotten. A share worth fewer than 10,000 base units is valued for up to 10 ** 6 shares. ADR 0006, "Share value", has the rules.
- Subscriptions and alerts: with a CheckSubscriptions address on the attest network (`--subs`, else `SPECFIRST_SUBS_<chainId>` of `--network`, so `SPECFIRST_SUBS_10143`), the watcher reads the active subscriptions there beside its passes (new and active ids each minute, expired ones every tenth read; a subscribed vault is checked first, then every `--subscribed-minutes`) and POSTs each change to the subscribers' webhooks in `.specfirst/watch/webhooks.json` (see Alert subscriptions). `--webhook-local-origin <origin>` (repeatable, exact origins such as `http://localhost:3418`) lets a local receiver like the web's demo hook through. Without an address it runs with no subscriptions and no alerts. The hooks are `SubscriptionSource` and `AlertSink` in `packages/core/src/watch/hooks.ts`.

### Demo on Monad testnet

New mainnet factory deployments are rare, so the live demo watches Monad testnet with `examples/watch/sources-demo.json`: `DemoVaultFactory` (`packages/contracts/src/demo/`) lives at `0xE1FC8fa26Cb7496A68DD4e0ba896Ed8CAE2238FB` on every chain it is deployed to through the deterministic CREATE2 deployer, so the file names it in advance; `Deposit`, `Upgraded` and `BeaconUpgraded` only re-check vaults the watcher already knows. The factory from before DemoVault had `setLoss` stays at `0x27eFcf4d95B8AB853b31b65EFB3Adb1cAd93D432` (its bytecode embeds DemoVault's, so the change moved the address); the file lists it too, so its vaults stay known, but they have no `setLoss`. A DemoVault can carry the harness's control bug (previewDeposit promises 1% more shares than deposit mints), switched by its operator. Switching it changes no code and no EIP-1967 slot, so it shows up through a subscription: the subscribed re-check finds the regression and the next one, at a later block, confirms it. Its operator can also send a share of its assets away (`watch demo loss <vault> <bps>`): the subscribed vault's share value falls, the next read sees it, the one after at a later block confirms it, and the watcher alerts and re-checks without attesting. The demo watcher runs next to the mainnet one, so it signs with its own key (`WATCH_DEMO_ISSUER_PRIVATE_KEY`, made an issuer once) and keeps its own watch directory per subject chain. `watch demo` signs with `DEPLOYER_PRIVATE_KEY`; it takes `--network monad-testnet|anvil` like `watch`.

```
node --env-file=.env packages/cli/dist/index.js attest-registry set-issuer <address of WATCH_DEMO_ISSUER_PRIVATE_KEY> --network monad-testnet   # once
node --env-file=.env packages/cli/dist/index.js watch demo deploy --token                      # factory (once) and a DemoToken
node --env-file=.env packages/cli/dist/index.js --json watch --subject-chain 10143 --sources examples/watch/sources-demo.json --network monad-testnet --issuer-key-env WATCH_DEMO_ISSUER_PRIVATE_KEY --subscribed-minutes 1
node --env-file=.env packages/cli/dist/index.js watch demo vault --asset <DemoToken>              # detected, checked, attested (factory)
node --env-file=.env packages/cli/dist/index.js watch demo deposit <vault> --asset <DemoToken>   # first deposit: re-checked, unchanged, no transaction
node --env-file=.env packages/cli/dist/index.js subs subscribe <vault> --days 1 --subject-chain 10143   # its first check reaches the subscriber
node --env-file=.env packages/cli/dist/index.js watch demo set-broken <vault> on                 # next re-check: regressed, pending; the one after: confirmed, attested, alerted
node --env-file=.env packages/cli/dist/index.js watch demo loss <vault> 42                        # 0.42% of its assets away: price-drop seen, confirmed, alerted, re-checked
```

### Allocation gate: a contract that reads the attestations

`AllocationGate` (`packages/contracts/src/demo/`, ADR 0007) answers "who reads these attestations?" on chain. Its owner can move the gate's idle asset into a vault only while the registry's latest attestation of that vault is compliant (with the gate's suite when it pins one, `--suite-hash`), fresh (`--max-age`, default a day), from a current issuer, about the code at the vault's address and of a block that exists, and only for at least `--min-shares` (default: the vault's previewDeposit less 1%). Once the latest attestation fails, is revoked, or its issuer is removed, anyone can call `exit` and the gate redeems its shares; the owner can exit on any verdict (`--as-owner` in the CLI). A stale but compliant attestation stops new money and opens no exit to others. The watcher does not attest unchanged re-checks, so a day after a vault's last attested change allocate needs a new attestation: a desk request, or `specfirst check` and `specfirst cert attest`. A vault that moves nothing on exit ends in an `ExitFailed` event instead of a revert; each vault call gets a fixed gas stipend set at deployment (`--vault-call-gas` 2,000,000 and `--vault-view-gas` 300,000 by default, sized for Monad's cold access prices), so an exit needs a gas limit of about 2.2M, and Monad charges the limit. Exit counts only assets that arrive; `watch demo gate resync <vault>` lets the owner set the books to the vault's balance after a vault misreported. The keeper signs with its own key (`--key-env`, default `KEEPER_PRIVATE_KEY`, else `REQUESTER_PRIVATE_KEY`), never the owner's, since exit is open to anyone; it backs off a vault whose exit would move nothing, took back only dust or failed on chain, from a minute doubling to an hour. Removing an issuer opens exit on every vault it attested: rotate a key by attesting with the new one first. The gate trusts the registry's issuers, nothing more (ADR 0005). `watch demo gate` signs with `DEPLOYER_PRIVATE_KEY` (the owner) and takes `--network monad-testnet|anvil`, `--registry-attest` and, for `keep`, `--once` and `--poll` of `watch`; the gate address comes from `--gate` or `SPECFIRST_GATE_<chainId>`.

```
node --env-file=.env packages/cli/dist/index.js watch demo gate deploy --asset <DemoToken> --fund 100   # owner = deployer; prints SPECFIRST_GATE_10143
node --env-file=.env packages/cli/dist/index.js watch demo gate allocate <vault> 10                     # refused unless the vault is attested compliant and fresh
node --env-file=.env packages/cli/dist/index.js --json watch demo gate keep                             # keeper (KEEPER_PRIVATE_KEY): exits every vault whose exit is open, every 15 s
node --env-file=.env packages/cli/dist/index.js watch demo set-broken <vault> on                         # the demo watcher attests the failing report, the keeper exits
node --env-file=.env packages/cli/dist/index.js watch demo gate status                                   # positions, verdicts, latest attestations
```

`watch demo gate exit <vault>` is the same exit by hand (`--as-owner` to leave a healthy vault). The web shows the gate at `/watch/gate` when `NEXT_PUBLIC_SPECFIRST_GATE_10143` is set.

## Alert subscriptions

`CheckSubscriptions` sells delivery and freshness, not results: a subscriber prepays a fee per day in testnet MON for one vault and gets a webhook POST when its check result changes (and one for the first check after it subscribes), plus a faster re-check cadence from the watcher. A day that has started counts as used; `settle` moves the fee of started days to earned, `cancel` refunds the days not started, and extending an expired subscription starts it again from now, so days without service are never charged. See `docs/adr/0006-chain-as-entry-point.md` (CheckSubscriptions, Alerts) for the accounting and the webhook rules.

```
# owner = DEPLOYER_PRIVATE_KEY, 0.05 MON per day unless --fee-per-day (above 0)
node --env-file=.env packages/cli/dist/index.js subs deploy --network monad-testnet
export SPECFIRST_SUBS_10143=0x...                       # printed by subs deploy

# a test subscription paid from REQUESTER_PRIVATE_KEY (users subscribe from the web)
node --env-file=.env packages/cli/dist/index.js subs subscribe 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E --days 7 --subject-chain 143
node --env-file=.env packages/cli/dist/index.js subs extend 0 --days 7
node --env-file=.env packages/cli/dist/index.js subs cancel 0                   # refunds the days not started

node --env-file=.env packages/cli/dist/index.js subs status                     # books, settleable now, latest subscriptions
node --env-file=.env packages/cli/dist/index.js subs settle                     # every subscription with something due
node --env-file=.env packages/cli/dist/index.js subs withdraw                   # owner: earned fees only, to the owner
```

A webhook is registered off chain: the subscriber signs `Specfirst alerts webhook\nsubscriber: <address>\nurl: <https url>\nissued: <unix seconds>` (the URL in canonical form, `new URL(url).href`) on `/watch/inbox`, and the web API verifies and stores it in `.specfirst/watch/webhooks.json` (the web's `SPECFIRST_WATCH_DIR`) with `registerWebhook` from `@specfirst/core/webhooks` (Node only). `specfirst watch` with `SPECFIRST_SUBS_10143` set POSTs `{ v: 1, kind, key, subscriptionId, subscriptionIds, subject, chainId, change, check, attestation, reportURL }` (`createWebhookAlertSink`) once to every subscriber with an active subscription on a vault whose result changed (`kind: 'change'`) or whose share value fell (`kind: 'price-drop'`, the numbers in `change`, `check`, `attestation` and `reportURL` null), and once for the first check after a subscription started (`kind: 'first-check'`). `v` stays 1 and grows by adding: a receiver dispatches on `kind`, ignores kinds and fields it does not know, and can drop repeats by `key` (`<kind>:<chainId>:<subject>:<block>`). Deliveries take up to 3 attempts, at most 25 subscribers and 20 s per event, and never to a host that resolves to an internal address. Each delivery is an `alerted` event in the feed. A local demo receiver needs its exact origin on both sides: `SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1` on the web (its own origin) and `--webhook-local-origin` on the watcher:

```
PORT=3418 SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1 NEXT_PUBLIC_SPECFIRST_SUBS_10143=$SPECFIRST_SUBS_10143 pnpm --filter @specfirst/web dev
node --env-file=.env packages/cli/dist/index.js --json watch --subject-chain 10143 --sources examples/watch/sources-demo.json --network monad-testnet --webhook-local-origin http://localhost:3418
```

Subscriptions failures exit 20. The ABI, the day accounting, the client, `listActive` and the webhook message and verification are browser-safe in `@specfirst/core/subs`.

## Board

`packages/web` serves the Monad ERC-4626 board: `/` lists every checked vault, `/v/<chainId>/<address>` shows one vault's 30 properties, its onchain attestation and the command that replays the check, and `/about` covers method and limits. The pages are prerendered from files that one script builds:

```
pnpm --filter @specfirst/web board:meta -- <discovery.json>     # data/vault-meta.json: protocol, asset symbol, name per address
pnpm --filter @specfirst/web board:build                        # data/board.json, data/vaults/, public/reports/
pnpm --filter @specfirst/web dev
```

`board:build` reads `certs/checks/<chainId>/<address>/*.json` (or `SPECFIRST_BOARD_SOURCE`, e.g. `.specfirst/checks`) for Monad mainnet only (`SPECFIRST_BOARD_CHAINS`, a comma separated list, default `143`; the watcher's testnet demo reports stay off the board), keeps each vault's latest report, and reads `CheckAttestationRegistry` on Monad testnet with view calls only. When the registry cannot be read the board still builds and says so on every vault. Transaction hashes of attestations come from `packages/web/data/attestation-txs.json`. `build` and `dev` build the data only when `data/board.json` is missing. The script needs Node 22.18 or later (built-in TypeScript type stripping).

## Request desk

`packages/web` also takes paid checks. A vault team or curator pastes a vault on `/check`, pays the desk's fee in testnet MON with a browser wallet (EIP-1193, the wallet is asked to add Monad testnet 10143 when it does not know it) or a testnet burner key kept in the browser, and follows the request on `/check/<id>`. The worker checks the vault, attests the report in CheckAttestationRegistry and fulfils the request; only then does the fee leave escrow and count as earned. A reject returns the fee in the same transaction, and anyone can call `refundExpired` once `requestedAt + timeout` has passed. `/desk` shows fee, requests, earned, withdrawn, escrowed, the worker's gas and the net.

A report the worker writes under `certs/checks/<chainId>/<address>/` is shown at once: vault pages render per request and prefer a report newer than the board build, a vault the board never had gets a page from its report alone, and the board opens with a "Recently requested" line read when the page loads. For integrators, `GET /api/v1/vaults/<chainId>/<address>` returns the latest report summary, the four max-honored flags, the attestation read live from the registry and the replay command; `/badge/check/<chainId>/<address>.svg` shows Compliant, Mismatch, Partly checked or Not attested. In the API, `badge.state` keeps those values (`mismatch` for any failed property) and `badge.level` says, for a mismatch, whether only EIP-4626 SHOULD properties failed (`should`, read from the attestation's failedBitmap, which then also adds "SHOULD only" to the badge text) or a MUST did (`must`); `report.failed[].level` gives each failure's level from the report (`ERC4626_PROPERTY_LEVELS` in `@specfirst/core` has the EIP sentence of each property; withdraw and redeem failures are MUSTs whatever their reason says, since a vault can write that text). The board shows "Rounding favors caller" only when every failure is a round trip and every pair of values in its logs is within max(2 base units, 1 bp of the amount). The certificate badge at `/badge/<address>` is unrelated and unchanged.

Environment of the web server (all optional; nothing here is a key):

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_SPECFIRST_DESK_10143` | unset | CheckRequestDesk on Monad testnet. Unset: the pages say "desk not deployed" and paying is closed. Read at request time, so a restart is enough. |
| `NEXT_PUBLIC_MONAD_RPC` | `https://testnet-rpc.monad.xyz` | Testnet RPC for the server and the browser (burner, receipts). Server reads are cached a few seconds and batched with Multicall3 to stay under the public limit. |
| `SPECFIRST_MAINNET_RPC` | `https://rpc.monad.xyz` | Monad mainnet RPC for the pre-check (code, `asset()`, name, symbol). |
| `SPECFIRST_WORKER_STATUS` | `<repo>/.specfirst/worker/status.json` | The worker's progress file. Missing: progress follows the chain only. |
| `SPECFIRST_CHECKS_DIR` | `<repo>/certs/checks` | Where requested reports are read from. |
| `NEXT_PUBLIC_MONAD_FAUCET_URL` | `https://faucet.monad.xyz` | Linked from the burner card. |
| `SPECFIRST_REPO_ROOT` | two directories above `packages/web` | Base for the relative paths above. |
| `SPECFIRST_PUBLIC_ORIGIN` | the request's origin | Origin of the absolute links in `/api/v1/vaults` answers. Behind a proxy `next start` names its own host and port (`https://localhost:3000` behind an https proxy), so a deployment sets the site's origin (`deploy/docker-compose.yml` does). |

The desk ABI comes from `@specfirst/core/desk`; `packages/web/lib/desk/contract.ts` re-exports it next to the web's lenient status.json readers.

## Watch pages

`/watch` is a window on the watcher (ADR 0006): it reads `feed.ndjson`, `status.json` and `vaults.json` under `SPECFIRST_WATCH_DIR/<chainId>/` per request and then every three seconds, and shows what the watcher is doing, how far behind the head it is, its queue and sources, and its feed with each check's 30 results read from the report the feed names, and with each confirmed fall of a vault's share value ("Share value fell 0.42% between block X and block Y"). Nothing there needs a person; a missing directory reads as "not running". Vaults the watcher found that the board build does not have join the board's table (`GET /api/v1/watch/overlay`) and get a vault page with their history and a "Watch this vault" box that pays `CheckSubscriptions` per day. `/watch/inbox` lists the paying address's subscriptions and alerts, cancels with the days not started refunded, and registers a webhook by signing the ADR text; the URL is stored in `<watch dir>/webhooks.json` only for a subscriber holding an active subscription (at most 1000 subscribers), and only its origin is ever shown. `/watch/demo-hook` is a demo receiver for a webhook delivery. `/desk` adds subscription revenue and the watcher's gas when its status reports it. `/watch/gate` shows the allocation gate of ADR 0007: its positions, each vault's verdict and latest attestation, and its recent events, read from Monad testnet per request.

JSON: `GET /api/v1/watch/status`, `/api/v1/watch/feed?after=<seq>|before=<seq>`, `/api/v1/watch/vaults/<chainId>/<address>`, `/api/v1/watch/subs`, `/api/v1/watch/subs/<subscriber>`, `/api/v1/watch/inbox?subscriber=`, `POST /api/v1/watch/webhooks`. For local rendering without a watcher: `node packages/web/test/fixtures/watch/generate.mjs --now --out /tmp/w`, then `SPECFIRST_WATCH_DIR=/tmp/w SPECFIRST_CHECKS_DIR=/tmp/w/checks` (synthetic data).

| Variable | Default | Meaning |
|---|---|---|
| `SPECFIRST_WATCH_DIR` | `<repo>/.specfirst/watch` | The watcher's files (`<dir>/<chainId>/`), so `.specfirst/watch` of the watcher's `--project`; the web writes `webhooks.json` there, which the watcher's alert sink reads, and `demo-hook.json`. |
| `NEXT_PUBLIC_SPECFIRST_SUBS_10143` | unset | CheckSubscriptions on Monad testnet. Unset: the subscribe box and the inbox say "not deployed yet". |
| `SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS` | unset | `1` lets a webhook at this site's own origin register even when it is local (`http://localhost:3418/api/v1/watch/demo-hook`), for demos on one machine. Other local URLs stay refused. The watcher delivers to it only when started with `--webhook-local-origin` set to the same origin. |
| `SPECFIRST_DEMO_HOOK` | on | `off` turns the demo receiver off. |
| `NEXT_PUBLIC_SPECFIRST_GATE_10143` | unset | AllocationGate on Monad testnet, shown at `/watch/gate` (ADR 0007). Unset: the page says no gate is deployed. |

The web takes the file schemas from `@specfirst/core/watch` and the CheckSubscriptions ABI, day accounting and webhook verification from `@specfirst/core/subs` (`packages/web/lib/watch/core.ts` and `lib/subs/core.ts` re-export them; both are browser-safe), and the `webhooks.json` store from the Node-only `@specfirst/core/webhooks` in server code (`lib/watch/webhooks.ts`), so the web and the watcher's alert sink write and read one file the same way. It never imports the package root.

## MCP server for agents

`packages/mcp` (`@specfirst/mcp`, bin `specfirst-mcp`) lets an AI agent ask Specfirst about a vault before it moves money, over stdio for Claude Code, Claude Desktop and other MCP hosts. `check_before_moving_funds` answers refuse, caution or proceed for a deposit, mint, withdraw or redeem, with reasons and which max function not to size from; `vault_verdict`, `recent_findings` and `how_to_watch` give the details, the watcher's findings and the way to subscribe. It reads the web API (`SPECFIRST_API_BASE`) and the registry on Monad testnet itself (`MONAD_TESTNET_RPC`), and holds no key. Setup, the tools and the decision rules are in `packages/mcp/README.md`, the reasoning in `docs/adr/0008-mcp-server.md`.

```
pnpm --filter @specfirst/mcp build
claude mcp add specfirst -e SPECFIRST_API_BASE=http://localhost:3417 -- node "$PWD/packages/mcp/dist/index.js"
```

## License

MIT, see `LICENSE`. Exceptions: files whose first line is `SPDX-License-Identifier: AGPL-3.0` extend [a16z/erc4626-tests](https://github.com/a16z/erc4626-tests), which is AGPL-3.0, and carry that license:

- `packages/core/src/standards/erc4626/SpecfirstERC4626.t.sol`
- `packages/core/src/standards/erc4626/control/SpecfirstERC4626Control.t.sol`
- `packages/core/test/fixtures/standards/review/Exp.t.sol`

The upstream suite itself is not in this repository; it is fetched at a pinned commit at run time (see `docs/adr/0003-third-party-standard-properties.md`). The vendored `forge-std` keeps its own MIT OR Apache-2.0 license.
