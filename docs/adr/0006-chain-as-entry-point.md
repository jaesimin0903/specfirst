# ADR 0006: The chain as the entry point: automatic detection, re-checks and paid alert subscriptions

Date: 2026-10-06. Status: proposed. The files under "Interfaces" are fixed so the watcher, the subscription contract and the web can be built in parallel; implementation details may be added, the shapes may not change without updating this ADR. All three are built: the details they settled are under each interface and in "Implementation notes"; the changes to fixed shapes are the webhook payload's `kind` and `subscriptionIds` with a POST for a subscription's first check (Alerts), and an optional `gasCostWei` in `status.json`.

## Problem
- Every check so far starts with a person: we picked 285 vaults by hand for the board, and the desk (ADR 0005) waits for someone to open the web, paste an address and pay. That is a platform people have to come to.
- The hand-picked list is already incomplete. On 2026-10-06 a scan of the ERC-4626 `Deposit` event over the last 220,000 blocks of Monad mainnet (about 24 hours, blocks 110757301 to 110977300, `rpc1.monad.xyz`) found 64 emitting addresses. 25 of them are not on the board, and all 25 answer `asset()`, `totalAssets()` and `convertToShares()`. The busiest, steakMUSD 0xbeef067c9d2591accab7d1c336a41ca3bd45b8f5, a Morpho Vault V2, took 1,333 deposits in that day.
- Results go stale. Neverland wnCBBTC failed at block 109061472 and passed at 109195820; Aarna's withdrawals are paused at one block and may not be at another. A check is a statement about one block.

## Decision
1. `specfirst watch`: an unattended loop that reads the subject chain (Monad mainnet, read only) and turns chain events into checks and attestations. Nobody has to ask.
2. `CheckSubscriptions` on Monad testnet: a subscriber prepays per day for one vault and gets push alerts when its result changes, plus a faster re-check cadence. Every result stays public; a subscription buys delivery and freshness.
3. The web becomes a window on the watcher (`/watch`, an inbox, a subscribe button), not the entry point.

The desk stays as "check this vault now, at the latest block".

## Signals on Monad mainnet (chain 143)
Factories were found on chain, not from documentation: for one vault per protocol, binary search on `eth_getCode` gave the creation block, and the creation transaction's logs gave the contract that announced it. The vault field position in each event must be decoded with the event ABI and verified against these fixtures before use.

| Source | Emitter | Event | topic0 | Fixtures, vault at creation block |
|---|---|---|---|---|
| Euler EVK GenericFactory | 0xba4Dd672062dE8FeeDb665DD4410658864483f1E | `ProxyCreated(address indexed proxy, bool upgradeable, address implementation, bytes trailingData)` | 0x04e664079117e113faa9684bc14aecb41651cbf098b14eda271248c6d0cda57c | 0x69b4A7829F6BAE4e0c3C281aA7026D897fEC199F at 38331148 |
| Morpho VaultV2Factory | 0x8b2f922162fbb60a6a072cc784a2e4168fb0bb0c | `CreateVaultV2(address indexed owner, address indexed asset, bytes32 salt, address indexed newVaultV2)` | 0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e | 0x91643f54C4F5F7559BD43a082eFF97594d16708C at 108743758; steakMUSD 0xbeef067c9d2591accab7d1c336a41ca3bd45b8f5 at 73672212; 0xde16452c1f8cc209d8e9b104b7f240d9a251768b at 110391543; roxIFI 0xbd6d56b5b1b535b92d4a0a8c0a9e6cfd9b545167 at 110930586 |
| MetaMorpho V1.1 factory | 0x33f20973275b2f574488b18929cd7dcbf1abf275 | `CreateMetaMorpho(address indexed metaMorpho, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)` | 0xed8c95d05909b0f217f3e68171ef917df4b278d5addfe4dda888e90279be7d1d | 0xA35189d1a1d1d42BB7BA56E6d979D6Bb34fFeED7 at 62600546 |
| Euler Earn factory | 0xf463d4acb650cc6c4e1d6cd4d0d1b0cb224094cf | `CreateEulerEarn(address,address,address,uint256,address,string,string,bytes32)` | 0x2ecfce4fdb2055c9639b56f59c2a14eeafce06a51d93d898155bc11b6141896f | 0x9D42b0D57e88771B365e30c0A589Fcdbeca8828c at 36248205 |
| Neverland static wrapper factory | 0x81148e8e1d9910080317e11c9f178559ba23bc80 | `StaticTokenCreated(address,address)` | 0x7397831292236fdc8043acf7b9d21183e46fd54f9b06bd34210068f95dd378d6 | 0xD45D54ad7Ae6D5dEdb0De7B283Fe0b4e2ba40217 at 54765321 |

steakMUSD and the V2 fixture were created through intermediaries (a deployer emitting `VaultCreated(address,address,string,string)` at 0xf120dea2abbbb9b502ecb20d3f4038e5732d906c, and a Safe), but the factory event is emitted in the same transaction, so filtering on the factory is enough.

In the three days before 2026-10-06 these five factories created two vaults, both Morpho V2. New deployments are rare; a live mainnet deployment during a demo recording cannot be counted on.

Generic signals from any emitter:
- ERC-4626 `Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)`, topic0 0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7. An unknown emitter is a candidate (catch-all for vaults no factory announced, e.g. Curvance cTokens, which are deployed directly from an account). A known vault whose checks all predate its first observed deposit is re-checked once (`first-deposit`): vaults found at their deploy block are often not configured yet.
- EIP-1967 `Upgraded(address indexed implementation)`, 0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b, and `BeaconUpgraded(address indexed beacon)`, 0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e. On a known vault: re-check (`upgrade`). From an unknown emitter: a candidate.
- Beacon implementation changes (EVK vaults resolve their implementation through the GenericFactory): the factory's implementation-change event re-checks every known vault whose implementation resolves through that factory (`implementation`). Identified from euler-vault-kit `src/GenericFactory/GenericFactory.sol`: `SetImplementation(address indexed newImplementation)`, topic0 0xddebe6de740fe0dd01cc33ffa314d11c6ac6acbbe50b80513c4c360ae7aa4f04; on chain the factory emitted it at block 30858657 with 0xef17750D3a162E28a302E266c474ff8989d60ECD, the implementation EVK vaults resolve to today.

Not covered: contracts deployed directly from an account are found only at their first deposit. Scanning every receipt for `contractAddress` does not fit the public RPC budget.

## RPC facts (2026-10-06)
- `eth_getLogs` block range: `rpc.monad.xyz` 100, `rpc1.monad.xyz` 10,000, `rpc3.monad.xyz` and `rpc-mainnet.monadinfra.com` refuse 1,000.
- `rpc1.monad.xyz` answers 403 to Python's default User-Agent; curl works. Check what Node's fetch gets before relying on it.
- Blocks are about 0.4 s, so 100 blocks is about 40 s: tailing with 100-block windows keeps up; backfill uses the larger window where available.
- Archive `eth_getCode` at old blocks works on `rpc1` (used for the fixtures above).

## Pipeline
detect, probe, queue, check, save, decide, attest, alert.
- Probe: the desk worker's ERC-4626 pre-check. A probe rejection is recorded and the address is not retried unless a new signal arrives.
- Queue: one entry per subject, highest priority wins: subscribed subject, new candidate, upgrade or implementation, first-deposit, sweep.
- Check: the same check the desk worker runs (16 runs by default), at `head - lag` (lag 10, as the worker).
- Attest when the subject has no Valid attestation for the standard, or the outcome differs from its latest Valid attestation: the four counts, the set of failed property ids, or the implementation key. An unchanged re-check is recorded in the feed with no transaction. `--max-attest-per-day` (default 40) caps spending, about 0.052 testnet MON per attestation.
- Sweep: every known vault at most once per `--sweep-hours` (default 24), at most `--sweep-per-hour` checks (default 6). Subscribed subjects every `--subscribed-minutes` (default 60).
- Known set at start: `certs/checks/<chainId>/` plus the watcher's own `vaults.json`.
- Signer: `WATCH_ISSUER_PRIVATE_KEY`, a second issuer of the registry, because the desk worker signs with `ISSUER_PRIVATE_KEY` and two processes on one key collide on nonces. Writes go through the existing guarded wallet; nothing is ever written to chain 143.
- The subject chain is configurable: the same watcher runs against Monad testnet (10143) with a demo factory for the live demo. Sources are data (a per-chain list of emitter, topic0, vault field), with the table above as the built-in list for 143.

## Interfaces

### Watcher files: `.specfirst/watch/<subjectChainId>/`
Zod schemas live in `packages/core/src/watch/schema.ts`, exported as `@specfirst/core/watch`. Addresses are checksummed, block numbers and wei are decimal strings, times are ISO 8601.

`feed.ndjson`, append only, one event per line:

    { v: 1, seq: number, at: string, kind: FeedKind, chainId: number, subject: Address,
      source?: 'factory' | 'deposit' | 'upgrade' | 'beacon-upgrade' | 'implementation' | 'first-deposit' | 'sweep' | 'subscribed' | 'backfill',
      block?: string,                       // block of the signal
      txHash?: Hex,                         // transaction of the signal
      factory?: { address: Address, name: string },
      check?: { block: string, summary: { pass: number, fail: number, inconclusive: number, notApplicable: number },
                failed: string[], implementationKey: Hex | null, reportPath: string, reportHash: Hex, durationMs: number },
      attestation?: { id: string, txHash: Hex, supersedes: string | null },
      change?: { kind: 'new' | 'regressed' | 'recovered' | 'changed' | 'implementation',
                 from: { summary: Summary, failed: string[] } | null, to: { summary: Summary, failed: string[] } },
      alert?: { subscriptionId: string, subscriber: Address, channel: 'webhook' | 'inbox', ok: boolean, status?: number },
      reason?: string }
    FeedKind = 'detected' | 'probe-rejected' | 'queued' | 'checked' | 'attested' | 'changed' | 'alerted' | 'error'

`status.json`, rewritten atomically after every step:

    { v: 1, chainId: number, head: string, cursor: string, lagBlocks: number, startedAt: string, updatedAt: string,
      running: { subject: Address, source: string, stage: 'probing' | 'checking' | 'attesting', startedAt: string } | null,
      queue: Array<{ subject: Address, source: string, enqueuedAt: string }>,
      counts: { known: number, detected24h: number, checked24h: number, attested24h: number, changed24h: number },
      sources: Array<{ name: string, address: Address | null, topic0: Hex, seen: number }>,
      attestBudget: { perDay: number, usedToday: number },
      gasCostWei?: string }                 // added 2026-10-06 for the web: gas of the watcher's attestations, summed

`vaults.json`: `{ v: 1, vaults: Record<lowercase address, { firstSeen: { source, block, at }, deployBlock: string | null, lastCheck: { block, at, reportPath, summary, failed, implementationKey } | null, lastAttestationId: string | null, firstDepositBlock: string | null }> }`

The web reads these files from `SPECFIRST_WATCH_DIR` (default `<repo>/.specfirst/watch`) at request time, so a vault the watcher finds appears without a board rebuild. The watcher writes them under `.specfirst/watch/` of its `--project`, so `SPECFIRST_WATCH_DIR` names that directory when the web runs elsewhere. The same directory, not a chain directory, holds `webhooks.json` (Alerts): one registration serves every subject chain.

### `CheckSubscriptions` (MIT, Monad testnet)

    struct Subscription { address subscriber; uint64 subjectChainId; address subject; bytes32 standardId;
                          uint96 feePerDay; uint64 startsAt; uint64 endsAt; uint96 paid; uint96 settled; bool cancelled; }
    constructor(address owner, uint96 feePerDay)
    subscribe(uint64 subjectChainId, address subject, bytes32 standardId, uint32 days_) payable returns (uint256 id)
                                         anyone; msg.value == feePerDay * days_; 1 <= days_ <= 365; starts now
    extend(uint256 id, uint32 days_) payable          anyone may pay; uses the subscription's own feePerDay; not when cancelled
    cancel(uint256 id)                                subscriber only; settles, then refunds the days not started
    settle(uint256[] ids)                             anyone; moves the fee of elapsed days (a started day counts) to earned
    withdraw(address payable to)                      owner; earned - withdrawn
    setFeePerDay(uint96)                              owner; new subscriptions only
    views: subscriptionOf(id), subscriptionCount(), isActive(id), feePerDay(), owner(), earned(), withdrawn(), escrowed()
    events: Subscribed(uint256 indexed id, address indexed subscriber, uint64 subjectChainId, address indexed subject, bytes32 standardId, uint32 days_, uint96 paid, uint64 endsAt)
            Extended(uint256 indexed id, uint32 days_, uint96 paid, uint64 endsAt)
            Cancelled(uint256 indexed id, uint96 refund)
            Settled(uint256 indexed id, uint96 amount)
            FeesWithdrawn(address indexed to, uint96 amount)
            FeePerDaySet(uint96 feePerDay)

Ids are a zero based index, as in the registry and the desk. Owner immutable, reentrancy lock, pushes with `call` after state changes, as in the desk. `isActive(id)` is `!cancelled && block.timestamp < endsAt`.

Accounting, as implemented in `packages/contracts/src/CheckSubscriptions.sol` (the ABI is exactly the one above; `DAY` = 86400 s and `MAX_DAYS` = 365 are internal constants):
- A subscription is a run of whole days `[startsAt, endsAt)`. Day k of the run starts at `startsAt + k * DAY`, and a day that has started counts as used: at time t the run has `min(runDays, (t - startsAt) / DAY + 1)` started days. The first day is used as soon as the subscription is made, and exactly at a day boundary the next day has started.
- `paid` is the sum of the fees paid (subscribe and every extend, each `days_ * feePerDay` of the subscription). The fee not used yet is `unstarted(t) = (runDays - startedDays(t)) * feePerDay`, 0 once the run has ended.
- `settle(ids)` (anyone) moves `due - settled` into `earned` with `due = paid - unstarted(t)`, which is `min(paid, startedDays * feePerDay)` when the days of earlier runs (all started) are counted too. `settled <= paid` always and `settled` only grows. Cancelled subscriptions and subscriptions with nothing due are skipped (no event); an unknown id reverts the whole call.
- `cancel(id)` (subscriber only, `NotSubscriber` otherwise) settles, then refunds `paid - settled` (the fee of the days not started) to the subscriber and sets `cancelled`. It ends the subscription at once: the day in progress is paid and not refunded. A refund of 0 (after the end, or a free subscription) sends nothing. A subscriber that refuses coins cannot cancel (`TransferFailed`); its subscription runs to its end.
- `extend(id, days_)` (anyone; the refund still goes to the subscriber) charges the subscription's own `feePerDay` and is refused once cancelled (`AlreadyCancelled`). While active it appends the days at `endsAt`. Once expired (`block.timestamp >= endsAt`) it starts a new run now: `startsAt = now`, `endsAt = now + days_ * DAY`, so the days between the old `endsAt` and now, when nothing was delivered, are never charged; restarting from `endsAt` would charge them. Exactly at `endsAt` both rules agree.
- `subscribe` and `extend` take exactly `feePerDay * days_` (`WrongValue(sent, expected)`), `1 <= days_ <= 365` per call (`BadDays`), and `paid` must stay within uint96 (`PaidOverflow`). `subscribe` refuses a zero subject, chain id or standardId like the desk.
- `feePerDay` is never 0: the constructor and `setFeePerDay` refuse it with `ZeroFee`. `extend` charges the subscription's own fee, so a subscription made at a fee of 0 could be extended by anyone for free, 365 days per call, forever.
- `escrowed` is the sum of `paid - settled` over the subscriptions that are not cancelled and `earned` the sum of `settled` over all of them. Without forced transfers `balance == escrowed + earned - withdrawn`; there is no receive or fallback function. `withdraw` pays `earned - withdrawn`, at most 2^96 - 1 wei per call so that the `FeesWithdrawn` amount fits its uint96 (`NothingToWithdraw` at 0).
- `subscriptionOf(id)` and `isActive(id)` revert with `UnknownSubscription(id)` for `id >= subscriptionCount()`, as `requestOf` in the desk; `extend`, `cancel` and `settle` refuse unknown ids the same way. Other errors: `NotOwner`, `ZeroAddress`, `ZeroFee`, `ZeroChainId`, `EmptyStandardId`, `NothingToWithdraw`, `TransferFailed(to, amount)`, `Reentrancy`.
- Nothing settles on its own: `earned` grows when someone calls `settle` (the CLI `subs settle` with no ids settles every subscription that has something due) or when a subscriber cancels.

Code: `@specfirst/core/subs` (browser-safe: viem and zod only) exports the bundled ABI and bytecode (`checkSubscriptionsAbi`, regenerated with `packages/core/scripts/gen-subs-artifact.mjs`), the same day accounting offchain (`startedDaysAt`, `settleableAt`, `refundAt`, `isActiveAt`), `SubscriptionsClient` and `listActive(subjectChainId)`. listActive reads `subscriptionCount()`, the latest block's timestamp and `subscriptionOf(id)` for every id, never getLogs: 10 reads at a time through a token bucket of 10 reads per second (the testnet public RPC allows 15), so n subscriptions cost n + 2 requests. `createSubscriptionSource(client)` is the watcher's `SubscriptionSource`; it does not read again an id it has seen cancelled (expired ones are read every time, an extend can start them again).

CLI, monad-testnet or anvil (`--network monad-mainnet` is refused for every command that sends; `status` only reads), address from `--subs` or `SPECFIRST_SUBS_<chainId>`, failures exit 20 (19 is `specfirst watch`'s; both were built at once and took 19, the next free code after the desk's 18):

    specfirst subs deploy [--fee-per-day 0.05]          DEPLOYER_PRIVATE_KEY is the owner; refuses a fee of 0
    specfirst subs subscribe <address> --days <n> [--subject-chain 143] [--standard erc4626]
    specfirst subs extend <id> --days <n>                both pay from REQUESTER_PRIVATE_KEY (the test subscriber, no anvil fallback)
    specfirst subs cancel <id>                           REQUESTER_PRIVATE_KEY, refused before sending unless it is the subscriber
    specfirst subs status [id] [--limit 20]              books, settleable now, and the latest subscriptions
    specfirst subs settle [ids...]                       DEPLOYER_PRIVATE_KEY; no ids: every subscription with something due, 100 per tx
    specfirst subs withdraw [--to <address>]             owner only; to the owner by default

### Alerts
- Inbox: the web lists the feed's `changed` events (and the first check after a subscription starts) for the subjects a subscriber holds active subscriptions on, and the `alerted` events of its deliveries.
- Webhook: a subscriber registers a URL off chain by signing (EIP-191) exactly `Specfirst alerts webhook\nsubscriber: <checksummed address>\nurl: <url>\nissued: <unix seconds>`; the web API verifies it and stores `{ subscriber, url, issued, signature }` in `<watch dir>/webhooks.json` (latest per subscriber wins). The watcher POSTs `{ v: 1, kind, subscriptionId, subscriptionIds, subject, chainId, change, check, attestation, reportURL }` as JSON for each `changed` event (`kind: 'change'`) once to every subscriber with an active subscription on that subject, and once for the first check after a subscription started (`kind: 'first-check'`, `change` null unless that check also changed the result, which is then a `change` for everyone), up to 3 attempts, and appends one `alerted` event per subscriber. Added when it was built: `subscriptionIds`, since there is one POST per subscriber, not per subscription; `kind` and the first-check POST, so a new subscriber learns the current result and that the webhook works without waiting for a change.

Webhook details, as implemented in `packages/core/src/subs/alerts.ts` (browser-safe, in `@specfirst/core/subs`) and `webhooks.ts` (Node only, `@specfirst/core/webhooks`, also from the package root):
- `webhookMessage({ subscriber, url, issued })` builds the text above (the address checksummed, the url as given; the format does not change). `verifyWebhookRegistration(input, { now, allowedLocalOrigins })` accepts `{ subscriber, url, issued, signature }` and refuses, with a reason code: a bad shape (`invalid`); a URL that breaks a rule below (`url`); `issued` more than 600 s in the past (`stale`) or more than 60 s in the future (`future`); a signature that viem `verifyMessage` does not recover to the subscriber (`signature`; EOA signatures only, contract wallets cannot register).
- URL rules (`webhookUrlProblem`): at most 2048 characters, printable ASCII only (so NEL, bidi and zero-width characters are refused), canonical (`new URL(url).href === url`, so the signed text is the URL that is called; e.g. `https://hooks.example.org/` with its slash), no credentials, https, and a host that is not `localhost` or `*.localhost` (a trailing dot is ignored) and not an internal IP literal: IPv4 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 198.18/15, 224/3; IPv6 ::/96 (unspecified, loopback, IPv4-compatible), ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, fec0::/10, ff00::/8. `allowedLocalOrigins` (default none) lists exact http(s) origins such as `http://localhost:3418` for a demo receiver; a URL on one of them skips the https, private host and DNS rules, nothing else.
- `webhooks.json`: `{ v: 1, webhooks: { "<lowercase subscriber>": { subscriber, url, issued, signature } } }`, `issued` the signed unix seconds as a number. `registerWebhook(file, input, { now, allowedLocalOrigins })` is the only way in: it verifies in full (the issued window included) and stores, replacing the subscriber's registration only when its `issued` is the same or later, so an older registration replayed within its window cannot undo a newer one. The file is written mode 0600 through a temp file that is fsynced and renamed, one write at a time per file within a process. It holds URLs that can be secrets (chat webhook URLs are), so it is never served and no feed event carries a URL.
- `createWebhookAlertSink({ webhooksFile, fetch, reportBaseUrl, allowedLocalOrigins })` is the watcher's `AlertSink`. For a `changed` event, or the `checked` event the watcher hands it for a first check after a subscription started (with just the subscriptions it is the first check of), it reads `webhooks.json` again (a missing file means no webhooks; a broken one throws), groups the given subscriptions on the event's subject and chain by subscriber, and delivers once per subscriber that has a registration: the URL rules and the signature are checked again (not the age), the host name is resolved (`dns.lookup`, all addresses) and refused when it has no address, the lookup fails or any address is internal, and the payload is POSTed with `content-type: application/json` and `user-agent: specfirst-alerts/1`, redirects not followed (a 3xx fails), 10 s per attempt, 3 attempts 1 s and 4 s apart, retried on network errors, timeouts, 408, 425, 429 and 5xx; any 2xx is delivered. Up to 4 subscribers at once, at most 25 per event (the rest get a failed `alerted` event, `over the cap of 25 webhooks per event`), and 20 s for the whole event: then the POSTs in flight are aborted and the subscribers not reached are recorded as failed, so one event holds the watcher at most about 20 s. Events of other kinds deliver nothing (`isWebhookEvent`).
- Payload: `kind` is `change` for a `changed` event and `first-check` for a `checked` one; `subscriptionId` is the subscriber's lowest subscription id among those the event is delivered for and `subscriptionIds` lists all of them (decimal strings); `change`, `check` and `attestation` are the event's, `null` when absent; `reportURL` is `reportBaseUrl` (the public URL of `certs/checks`, the worker's `--report-base-url`) followed by the part of `check.reportPath` below `certs/checks/`, as the worker's reportURI, and `null` for a report outside `certs/checks`.
- Each subscriber gets one event `{ v: 1, seq, at, kind: 'alerted', chainId, subject, alert: { subscriptionId, subscriber, channel: 'webhook', ok, status? }, reason? }` with its lowest subscription id, a valid `feed.ndjson` line (`feedEventSchema`). The sink sets `seq` to that of the event it answers; the watcher drops it and the feed store numbers the event as it appends it, right after that event, so every seq stays unique. `reason` (failures only) is e.g. `HTTP 503 after 3 attempts` or `delivery deadline of 20000 ms passed before delivery`, never the URL.
- Not covered: the payload is not signed, so a receiver cannot tell the watcher from anyone who learns its URL. The DNS check and the connection resolve the name separately, so a name that changes its answer in between (DNS rebinding) can still reach an internal address.

How the pieces are wired:
- `specfirst watch` builds its hooks when a CheckSubscriptions address is configured on its attest network: `--subs`, else `SPECFIRST_SUBS_<chainId>` of `--network` (`SPECFIRST_SUBS_10143` for the testnet deployment, whatever the subject chain). Then `createSubscriptionSource` over a read-only client on that network (the watcher reads it every 60 s) and `createWebhookAlertSink` over `<project>/.specfirst/watch/webhooks.json` with `--report-base-url` as `reportBaseUrl`. The address must have code. `--webhook-local-origin <origin>` (repeatable) is the sink's `allowedLocalOrigins`, for a demo receiver such as the web's `/api/v1/watch/demo-hook`; it is refused without a subscriptions contract. Without an address the watcher runs with no hooks: no subscriptions, no alerts.
- The web's `POST /api/v1/watch/webhooks` stores through `registerWebhook` only, and only for a subscriber holding an active subscription (at most 1000 subscribers). With `SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS=1` its own origin is its `allowedLocalOrigins`; such a registration is delivered only when the watcher was started with the same origin in `--webhook-local-origin`, else the sink records a failed `alerted` event (`webhook registration refused: url`). The inbox signs `new URL(input).href`, the canonical form the URL rules require.
- The web takes the schemas from `@specfirst/core/watch`, the ABI, day accounting and webhook verification from `@specfirst/core/subs`, and the `webhooks.json` store from `@specfirst/core/webhooks` (server code only). It never imports the package root, whose forge and process code would land in its route bundles. A local URL refused because its origin is not the site's keeps core's reason code `url` with a message that names the origin it may use.

## Implementation notes: the watcher (2026-10-06)
`specfirst watch` (`packages/core/src/watch/`, `packages/cli/src/commands/watch.ts`) follows the sections above. Details the ADR left open, or that the chain forced (those of CheckSubscriptions and the webhooks are under their interfaces):
- Event layouts. The table gives types; the indexed flags and the vault argument come from the recorded creation logs (`packages/core/test/fixtures/watch/signals-143.json`, checked offline in `watch.test.ts` and live with `SPECFIRST_LIVE=1`): EVK `proxy` (topic 1), Morpho V2 `newVaultV2` (topic 3), MetaMorpho `metaMorpho` and Euler Earn `eulerEarn` (topic 1; `CreateEulerEarn(address indexed eulerEarn, address indexed caller, address initialOwner, uint256 initialTimelock, address indexed asset, string name, string symbol, bytes32 salt)` per euler-earn `EventsLib`), Neverland `StaticTokenCreated(address indexed staticToken, address indexed underlying)` (topic 1; the factory created ten wrappers in the fixture block).
- RPC, measured again: Node's fetch (and viem) get 200 from `rpc1.monad.xyz`; it accepted a 20,000-block getLogs window, the default stays 10,000. `rpc1` answers some archive getLogs with -32603 "Error getting block by number" (block 108743758, the V2 fixture) where `rpc.monad.xyz` answers, so the watcher's subject transport also fails over on node errors (`failoverIf: isNodeError`, opt in; the desk's transport is unchanged). The testnet RPC limits getLogs to 100 blocks with HTTP 413 and -32614, like `rpc.monad.xyz`. A window of n blocks spans n - 1, inside a limit of n.
- `status.json`: `cursor` is the first block whose logs are not read yet, `head` the latest block seen, `lagBlocks` the configured lag; `sources[].seen` counts signals since the state was created. `vaults.json`: `firstSeen.source` is `backfill` for the vaults known from `certs/checks/<chainId>/` at start (block and time of the oldest report). A newer report there (a desk check) becomes `lastCheck` at the next start.
- Change kinds: `new` without a previous check, `regressed` when a property fails that did not, `recovered` when none newly fails and one stopped failing, `changed` for other count changes, `implementation` when only the implementation key moved. The comparison is with the previous check; the attest rule compares with the latest Valid attestation, so a check deferred by the budget is still attested later.
- Probes: only an answer of the contract (a revert, no data, data that does not decode) is "not a vault". An RPC failure, a rate limit or a node error is a "try again later": the candidate is probed again from a later pass, the wait doubling from 5 minutes up to an hour, as long as it takes. A Deposit from an address the probe rejected probes it again only after 24 hours, other signals at once: a busy contract that emits the ERC-4626 Deposit without being a vault would otherwise be probed at every deposit.
- Identity: reading a beacon's `implementation()` on the subject chain (`identifyImplementation`, shared with `specfirst check` and the desk worker) now throws on an RPC failure, a rate limit or a node error instead of reporting a proxy of unknown kind, so a busy RPC cannot change a subject's implementation key; the check is retried.
- Checks: a failed check is retried after 5, then 10 minutes and dropped after three attempts until the next signal or sweep. A report in which any property is inconclusive because of a fork RPC error (reason prefix "fork RPC error", see `standards/report.ts`) is such a failure: it is neither saved under certs/checks nor recorded as the vault's last check nor attested. A candidate with a subscription is raised to the subscribed priority, so its first check is recorded with source `subscribed`.
- Bounded checks: anyone can deploy what the watcher checks, and a vault whose view functions spin `while (gasleft() > 10_000_000) {}` passes an eth_call pre-check under the node's gas cap and then burns forge's whole gas limit (2^30 by default) on every call. The suite's foundry.toml caps a test call at 100 million gas (the largest mean in 291 Monad mainnet checks was 5.8 million), and every watcher check has a wall-clock budget (`--check-timeout`, 600 s); a check that runs out is an `error` in the feed, not attested and not retried until the next signal or sweep. The cap is in the shared workspace, so `specfirst check` and the desk worker get it too and the suite's `foundryTomlSha256` changes for new reports. The workspace directory now carries the foundry.toml hash, so two builds sharing a cache never rewrite each other's foundry.toml under a running forge.
- Attest rule: the latest Valid attestation of the subject counts whoever issued it (the desk worker signs with another key). One of a later block than the check supersedes the check: the check is in the feed but does not become the vault's last check, gives no `changed` event and no alert, `lastAttestationId` follows the newer attestation, and the vault is checked again after the retry delay (counted as an attempt, so two issuers cannot ping-pong). An `OlderThanLatest` revert at send time is the same case found later (the registry is read again), not a failure. An attestation over the daily budget, or one whose registry read or transaction failed on the RPC, waits in the state and is decided again from the registry before it is sent, so a mined attestation whose receipt was lost is not sent twice; any other revert is recorded, not retried.
- `status.json` gains `gasCostWei` (optional, decimal string): gasUsed x effectiveGasPrice of the watcher's attestations since its state was created, for the web's spend figures.
- `first-deposit` follows the rule literally: every known vault, the seeded ones included, is re-checked once at the first deposit the watcher sees when all its checks predate it.
- Alerts: after a `changed` event the sink gets that event and every active subscription of the subject; a check that changes nothing but is the first since a subscription started goes to the sink as its `checked` event with the subscriptions seen for the first time (the webhook sink POSTs it as `first-check`). The watcher assigns the seq of the `alerted` events the sink returns. A sink that throws (a broken `webhooks.json`) is an `error` event, `alert delivery failed: ...`.
- Sources file (`--sources`): replaces the built-in list of its chain; an emitter-less source can set `candidates: false` so its events only re-check known vaults. `examples/watch/sources-demo.json` does that for testnet and also counts DemoVault's `BrokenSet` as an upgrade, so the demo's bug switch is re-checked at once.
- Demo contracts: `DemoVaultFactory` (`packages/contracts/src/demo/`, MIT) is deployed through the deterministic CREATE2 deployer 0x4e59b44847b379578588920ca78fbf26c0b4956c (present on Monad testnet, mainnet and anvil) with a zero salt, so it lives at 0x27eFcf4d95B8AB853b31b65EFB3Adb1cAd93D432 and the sources file can name it before the deployment; `specfirst watch demo` deploys it, a DemoToken and vaults through the guarded wallet.
- `--once` reads up to the head (or `--to-block`) and runs every due check; `--to-block` without `--once` stops once the queue is empty. After a failed step (head, logs, a check that threw) the loop waits a poll interval before the next pass. Exit code 19 when the watcher cannot start (a refused network, a missing key, a registry or subscriptions address without code, a bad `--webhook-local-origin`) or a `--once` pass cannot read the subject chain.

## Consequences
- The board grows on its own and stays current, and the demo shows the loop without a person: a vault is announced on chain, the watcher sees it, checks it and records the result.
- Free checks earn nothing; revenue depends on subscriptions, and nobody has paid for one yet. The desk keeps working as before.
- A vault caught at its deploy block is often unconfigured, so its first result can be "nothing checkable"; the first-deposit re-check is what makes the result useful.
- The trust model of ADR 0005 is unchanged: the issuer key can attest anything; every attestation stays reproducible from its report.
