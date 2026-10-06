# ADR 0006: The chain as the entry point: automatic detection, re-checks and paid alert subscriptions

Date: 2026-10-06. Status: proposed. The files under "Interfaces" are fixed so the watcher, the subscription contract and the web can be built in parallel; implementation details may be added, the shapes may not change without updating this ADR.

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
- Beacon implementation changes (EVK vaults resolve their implementation through the GenericFactory): the factory's implementation-change event, to be identified from the verified source, re-checks every known vault whose implementation resolves through that factory (`implementation`).

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
      attestBudget: { perDay: number, usedToday: number } }

`vaults.json`: `{ v: 1, vaults: Record<lowercase address, { firstSeen: { source, block, at }, deployBlock: string | null, lastCheck: { block, at, reportPath, summary, failed, implementationKey } | null, lastAttestationId: string | null, firstDepositBlock: string | null }> }`

The web reads these files from `SPECFIRST_WATCH_DIR` (default `<repo>/.specfirst/watch`) at request time, so a vault the watcher finds appears without a board rebuild.

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

### Alerts
- Inbox: the web lists the feed's `changed` events (and the first check after a subscription starts) for the subjects a subscriber holds active subscriptions on.
- Webhook: a subscriber registers a URL off chain by signing (EIP-191) exactly `Specfirst alerts webhook\nsubscriber: <checksummed address>\nurl: <url>\nissued: <unix seconds>`; the web API verifies it and stores `{ subscriber, url, issued, signature }` in `<watch dir>/webhooks.json` (latest per subscriber wins). The watcher POSTs `{ v: 1, subscriptionId, subject, chainId, change, check, attestation, reportURL }` as JSON for each `changed` event to every active subscriber of that subject, up to 3 attempts, and appends an `alerted` event.

## Consequences
- The board grows on its own and stays current, and the demo shows the loop without a person: a vault is announced on chain, the watcher sees it, checks it and records the result.
- Free checks earn nothing; revenue depends on subscriptions, and nobody has paid for one yet. The desk keeps working as before.
- A vault caught at its deploy block is often unconfigured, so its first result can be "nothing checkable"; the first-deposit re-check is what makes the result useful.
- The trust model of ADR 0005 is unchanged: the issuer key can attest anything; every attestation stays reproducible from its report.
