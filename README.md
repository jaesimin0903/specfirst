# Specfirst

Spec-first verification certificates for Monad contracts. Built for Monad Metropolis, Track 4.

Plan of record: see docs/plan.md. Status: week 1, scaffolding.

## Keys

Commands that send transactions read `DEPLOYER_PRIVATE_KEY` and `ISSUER_PRIVATE_KEY` (and `REQUESTER_PRIVATE_KEY` for `desk request` and the test subscriber of `subs`) from the environment; they do not read `.env` on their own. Copy `.env.example` to `.env`, fill it in, and run with Node's env loader:

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

## Alert subscriptions

`CheckSubscriptions` sells delivery and freshness, not results: a subscriber prepays a fee per day in testnet MON for one vault and gets a webhook POST when its check result changes, plus a faster re-check cadence from the watcher. A day that has started counts as used; `settle` moves the fee of started days to earned, `cancel` refunds the days not started, and extending an expired subscription starts it again from now, so days without service are never charged. See `docs/adr/0006-chain-as-entry-point.md` (CheckSubscriptions, Alerts) for the accounting and the webhook rules.

```
# owner = DEPLOYER_PRIVATE_KEY, 0.05 MON per day unless --fee-per-day
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

A webhook is registered off chain: the subscriber signs `Specfirst alerts webhook\nsubscriber: <address>\nurl: <https url>\nissued: <unix seconds>` and the web API stores it in the watch directory's `webhooks.json` with `registerWebhook` from `@specfirst/core`. The watcher's sink (`createWebhookAlertSink`) POSTs `{ v: 1, subscriptionId, subject, chainId, change, check, attestation, reportURL }` to every active subscriber of a vault whose result changed, up to 3 attempts. The ABI, the day accounting, the client, `listActive` and the webhook message and verification are browser-safe in `@specfirst/core/subs`.

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

## License

MIT, see `LICENSE`. Exceptions: files whose first line is `SPDX-License-Identifier: AGPL-3.0` extend [a16z/erc4626-tests](https://github.com/a16z/erc4626-tests), which is AGPL-3.0, and carry that license:

- `packages/core/src/standards/erc4626/SpecfirstERC4626.t.sol`
- `packages/core/src/standards/erc4626/control/SpecfirstERC4626Control.t.sol`
- `packages/core/test/fixtures/standards/review/Exp.t.sol`

The upstream suite itself is not in this repository; it is fetched at a pinned commit at run time (see `docs/adr/0003-third-party-standard-properties.md`). The vendored `forge-std` keeps its own MIT OR Apache-2.0 license.
