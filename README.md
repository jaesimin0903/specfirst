# Specfirst

Spec-first verification certificates for Monad contracts. Built for Monad Metropolis, Track 4.

Plan of record: see docs/plan.md. Status: week 1, scaffolding.

## Keys

Commands that send transactions read `DEPLOYER_PRIVATE_KEY` and `ISSUER_PRIVATE_KEY` (and `REQUESTER_PRIVATE_KEY` for `desk request` and the test subscriber of `subs`, `WATCH_ISSUER_PRIVATE_KEY` for `watch`) from the environment; they do not read `.env` on their own. Copy `.env.example` to `.env`, fill it in, and run with Node's env loader:

```
node --env-file=.env packages/cli/dist/index.js <command>
```

`.gitignore` ignores every name that starts with `.env` except `.env.example`, so a Finder copy such as `.env copy.example` is not committed by accident.

## Check attestations

`specfirst check` results for contracts on any chain, Monad mainnet included, are recorded on testnet in `CheckAttestationRegistry` with `specfirst attest-registry deploy`, `specfirst cert attest <report.json>` and read back with `specfirst cert attestation <chainId> <address>`. See `docs/adr/0004-check-attestation-registry.md` for the trust model and what `isCompliant` does and does not mean.

`cert attest` copies the report to `certs/checks/<chainId>/<address>/<block>-<hash8>.json` before it sends anything, and records `reportURI = <--report-base-url>/<chainId>/<address>/<block>-<hash8>.json`. Off anvil `--report-base-url` is required, so that anyone can fetch the report. Our reports are published from this repository (public once it is opened), so the value we use is:

```
node --env-file=.env packages/cli/dist/index.js cert attest <report.json> \
  --report-base-url https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks
```

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

## Watcher

`specfirst watch` turns chain events into checks without anyone asking (docs/adr/0006-chain-as-entry-point.md). It reads the subject chain's logs from a cursor (Monad mainnet by default, read only), finds new ERC-4626 vaults from factory events and from `Deposit`, `Upgraded` and `BeaconUpgraded` of unknown emitters, probes each with the desk worker's pre-check, queues one check per vault (subscribed, new candidate, upgrade or implementation change, first deposit, sweep), checks at `head - 10`, saves the report under `certs/checks/`, and attests on testnet only when the vault has no Valid attestation or the outcome (the four counts, the failed property ids, the implementation key) differs from its latest one. An unchanged re-check is recorded in the feed with no transaction.

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

- Signer: `WATCH_ISSUER_PRIVATE_KEY`, an issuer of the registry next to the desk worker's key. `--share-issuer-key` falls back to `ISSUER_PRIVATE_KEY` when it is unset; never run the worker at the same time then. `--network monad-mainnet` is refused for attesting, and nothing is ever sent to the subject chain.
- Subject RPC: `--subject-rpc` (repeat it for fallbacks; forge forks from the first), else `$MONAD_MAINNET_RPC`, else `https://rpc1.monad.xyz` then `https://rpc.monad.xyz`. getLogs starts with `--log-window` blocks (10,000) and shrinks to what the node accepts (`rpc.monad.xyz` and the testnet RPC take 100); a node error on one RPC goes to the next.
- Budget and cadence: `--max-attest-per-day` (40; more wait for the next UTC day), `--sweep-hours` (24) and `--sweep-per-hour` (6, 0 turns the sweep off), `--subscribed-minutes` (60), `--check-timeout` (600 s per check; a check that runs out is recorded, not attested and not retried, and forge gives a test call at most 100 million gas). `--once` reads up to the head (or `--to-block`) and runs every due check; `--to-block` alone stops once the queue is empty.
- What is never attested: a report in which a property is inconclusive because the fork RPC failed (the vault is checked again later), a check older than the subject's latest Valid attestation from any issuer (checked again at a new block), and a check that timed out. An RPC failure or a rate limit during the probe is never "not a vault".
- Files in `.specfirst/watch/<subjectChainId>/`: `feed.ndjson` (append only, one event per line), `status.json` and `vaults.json` (rewritten atomically), with zod schemas in `@specfirst/core/watch` (browser-safe, like `@specfirst/core/desk`), plus the watcher's own `state.json` (cursor, queue, rejected probes, budget) and `watch.lock` (one watcher per directory). The known set starts from `certs/checks/<chainId>/`. The web reads the directory from `SPECFIRST_WATCH_DIR` (default `<repo>/.specfirst/watch`).
- Subscriptions and alerts plug in through `SubscriptionSource` and `AlertSink` (`packages/core/src/watch/hooks.ts`); without them the watcher runs with none.

### Demo on Monad testnet

New mainnet factory deployments are rare, so the live demo watches Monad testnet with `examples/watch/sources-demo.json`: `DemoVaultFactory` (`packages/contracts/src/demo/`) lives at `0x27eFcf4d95B8AB853b31b65EFB3Adb1cAd93D432` on every chain it is deployed to through the deterministic CREATE2 deployer, so the file names it in advance; `Deposit`, `Upgraded` and `BeaconUpgraded` only re-check vaults the watcher already knows. A DemoVault can carry the harness's control bug (previewDeposit promises 1% more shares than deposit mints), switched by its operator; the demo sources count its `BrokenSet` event as an upgrade, so the switch is re-checked at once. `watch demo` signs with `DEPLOYER_PRIVATE_KEY`; it takes `--network monad-testnet|anvil` like `watch`.

```
node --env-file=.env packages/cli/dist/index.js watch demo deploy --token                      # factory (once) and a DemoToken
node --env-file=.env packages/cli/dist/index.js --json watch --subject-chain 10143 --sources examples/watch/sources-demo.json --network monad-testnet
node --env-file=.env packages/cli/dist/index.js watch demo vault --asset <DemoToken>              # detected, checked, attested
node --env-file=.env packages/cli/dist/index.js watch demo deposit <vault> --asset <DemoToken>   # first deposit: re-checked, unchanged, no transaction
node --env-file=.env packages/cli/dist/index.js watch demo set-broken <vault> on                 # BrokenSet: re-checked, changed (regressed), attested
```

## Alert subscriptions

`CheckSubscriptions` sells delivery and freshness, not results: a subscriber prepays a fee per day in testnet MON for one vault and gets a webhook POST when its check result changes, plus a faster re-check cadence from the watcher. A day that has started counts as used; `settle` moves the fee of started days to earned, `cancel` refunds the days not started, and extending an expired subscription starts it again from now, so days without service are never charged. See `docs/adr/0006-chain-as-entry-point.md` (CheckSubscriptions, Alerts) for the accounting and the webhook rules.

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

A webhook is registered off chain: the subscriber signs `Specfirst alerts webhook\nsubscriber: <address>\nurl: <https url>\nissued: <unix seconds>` (the URL in canonical form) and the web API verifies and stores it in the watch directory's `webhooks.json` with `registerWebhook` from `@specfirst/core`. The watcher's sink (`createWebhookAlertSink`) POSTs `{ v: 1, subscriptionId, subscriptionIds, subject, chainId, change, check, attestation, reportURL }` once to every subscriber with an active subscription on a vault whose result changed: up to 3 attempts, at most 25 subscribers and 20 s per event, and never to a host that resolves to an internal address. For a local demo receiver pass its exact origin in `allowedLocalOrigins`. The ABI, the day accounting, the client, `listActive` and the webhook message and verification are browser-safe in `@specfirst/core/subs`.

## Board

`packages/web` serves the Monad ERC-4626 board: `/` lists every checked vault, `/v/<chainId>/<address>` shows one vault's 30 properties, its onchain attestation and the command that replays the check, and `/about` covers method and limits. The pages are prerendered from files that one script builds:

```
pnpm --filter @specfirst/web board:meta -- <discovery.json>     # data/vault-meta.json: protocol, asset symbol, name per address
pnpm --filter @specfirst/web board:build                        # data/board.json, data/vaults/, public/reports/
pnpm --filter @specfirst/web dev
```

`board:build` reads `certs/checks/<chainId>/<address>/*.json` (or `SPECFIRST_BOARD_SOURCE`, e.g. `.specfirst/checks`), keeps each vault's latest report, and reads `CheckAttestationRegistry` on Monad testnet with view calls only. When the registry cannot be read the board still builds and says so on every vault. Transaction hashes of attestations come from `packages/web/data/attestation-txs.json`. `build` and `dev` build the data only when `data/board.json` is missing. The script needs Node 22.18 or later (built-in TypeScript type stripping).

## Request desk

`packages/web` also takes paid checks. A vault team or curator pastes a vault on `/check`, pays the desk's fee in testnet MON with a browser wallet (EIP-1193, the wallet is asked to add Monad testnet 10143 when it does not know it) or a testnet burner key kept in the browser, and follows the request on `/check/<id>`. The worker checks the vault, attests the report in CheckAttestationRegistry and fulfils the request; only then does the fee leave escrow and count as earned. A reject returns the fee in the same transaction, and anyone can call `refundExpired` once `requestedAt + timeout` has passed. `/desk` shows fee, requests, earned, withdrawn, escrowed, the worker's gas and the net.

A report the worker writes under `certs/checks/<chainId>/<address>/` is shown at once: vault pages render per request and prefer a report newer than the board build, a vault the board never had gets a page from its report alone, and the board opens with a "Recently requested" line read when the page loads. For integrators, `GET /api/v1/vaults/<chainId>/<address>` returns the latest report summary, the four max-honored flags, the attestation read live from the registry and the replay command; `/badge/check/<chainId>/<address>.svg` shows Compliant, Mismatch, Partly checked or Not attested. The certificate badge at `/badge/<address>` is unrelated and unchanged.

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

The desk ABI and the status.json schema live in `packages/web/lib/desk/contract.ts` until `@specfirst/core/desk` exports them; that file says how to swap.

## Watch pages

`/watch` is a window on the watcher (ADR 0006): it reads `feed.ndjson`, `status.json` and `vaults.json` under `SPECFIRST_WATCH_DIR/<chainId>/` per request and then every three seconds, and shows what the watcher is doing, how far behind the head it is, its queue and sources, and its feed with each check's 30 results read from the report the feed names. Nothing there needs a person; a missing directory reads as "not running". Vaults the watcher found that the board build does not have join the board's table (`GET /api/v1/watch/overlay`) and get a vault page with their history and a "Watch this vault" box that pays `CheckSubscriptions` per day. `/watch/inbox` lists the paying address's subscriptions and alerts, cancels with the days not started refunded, and registers a webhook by signing the ADR text; the URL is stored in `<watch dir>/webhooks.json` only for a subscriber holding an active subscription (at most 1000 subscribers), and only its origin is ever shown. `/watch/demo-hook` is a demo receiver for a webhook delivery. `/desk` adds subscription revenue and the watcher's gas when its status reports it.

JSON: `GET /api/v1/watch/status`, `/api/v1/watch/feed?after=<seq>|before=<seq>`, `/api/v1/watch/vaults/<chainId>/<address>`, `/api/v1/watch/subs`, `/api/v1/watch/subs/<subscriber>`, `/api/v1/watch/inbox?subscriber=`, `POST /api/v1/watch/webhooks`. For local rendering without a watcher: `node packages/web/test/fixtures/watch/generate.mjs --now --out /tmp/w`, then `SPECFIRST_WATCH_DIR=/tmp/w SPECFIRST_CHECKS_DIR=/tmp/w/checks` (synthetic data).

| Variable | Default | Meaning |
|---|---|---|
| `SPECFIRST_WATCH_DIR` | `<repo>/.specfirst/watch` | The watcher's files, and where the web writes `webhooks.json` and `demo-hook.json`. |
| `NEXT_PUBLIC_SPECFIRST_SUBS_10143` | unset | CheckSubscriptions on Monad testnet. Unset: the subscribe box and the inbox say "not deployed yet". |
| `SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS` | unset | `1` lets a webhook at this site's own origin register even when it is local (`http://localhost:3418/api/v1/watch/demo-hook`), for demos on one machine. Other local URLs stay refused. |
| `SPECFIRST_DEMO_HOOK` | on | `off` turns the demo receiver off. |

Until the watcher and subscriptions branches are merged, the web carries stand-ins with core's names and behavior: `packages/web/lib/watch/core.ts` for `@specfirst/core/watch` (file schemas), `packages/web/lib/subs/core.ts` for `@specfirst/core/subs` (ABI, day accounting, webhook message, URL rules, verification) and the first part of `packages/web/lib/watch/webhooks.ts` for the root's `readWebhooks`, `saveWebhookRegistration` and `registerWebhook`. Each becomes an import.

## License

MIT, see `LICENSE`. Exceptions: files whose first line is `SPDX-License-Identifier: AGPL-3.0` extend [a16z/erc4626-tests](https://github.com/a16z/erc4626-tests), which is AGPL-3.0, and carry that license:

- `packages/core/src/standards/erc4626/SpecfirstERC4626.t.sol`
- `packages/core/src/standards/erc4626/control/SpecfirstERC4626Control.t.sol`
- `packages/core/test/fixtures/standards/review/Exp.t.sol`

The upstream suite itself is not in this repository; it is fetched at a pinned commit at run time (see `docs/adr/0003-third-party-standard-properties.md`). The vendored `forge-std` keeps its own MIT OR Apache-2.0 license.
