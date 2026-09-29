# ADR 0003: Third-party standard properties on deployed contracts (`specfirst check`)

Date: 2026-09-30. Status: accepted. Revised the same day after code review (classification, exit 17, identity keys, reproducibility, workspace hygiene).

## Problem
A Specfirst certificate is issued against invariants the deployer wrote in their own spec. A malicious or careless author can write a spec that their contract trivially satisfies and still receive "verified". The certificate proves consistency with the author's claims, not with anything a third party agreed on.

## Decision
Add a read-only path that runs a public property suite, written and maintained by neither the deployer nor Specfirst, against a contract that is already deployed:

    specfirst check <address> --standard erc4626 [--network monad-mainnet|monad-testnet|anvil] [--rpc <url>] [--block <n>] [--runs <n>] [--delta <n>] [--seed <n>]

- Suite: a16z/erc4626-tests, pinned at commit `ac485460e014f22807c1ff687e0b4dc3af96ee40` (26 fuzz tests), with forge-std v1.16.2 (`bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`) and solc 0.8.28, evm_version prague.
- Execution: `forge test --fork-url <rpc> --fork-block-number <block> --fuzz-runs <n> --fuzz-seed <seed> --sender <random EOA> --compute-units-per-second 100 --fork-retries 10 --fork-retry-backoff 2000 --json -vv` with `SF_VAULT`, `SF_DELTA` and a fresh fuzz failure directory per run, so one vault's counterexample is never replayed against the next. The block defaults to the latest block when the check starts and is always recorded. Identity, block and fork all read the one `--rpc` URL; network fallbacks are not used by `check`. Nothing is signed or sent; forge runs against a local fork.
- Reproducibility: the report records the fork block, `seed` (random 32 bytes per run unless `--seed` is given), `sender`, `toolchain.forgeVersion` (first line of `forge --version`), `toolchain.forgeStd` (repo and commit), `toolchain.foundryTomlSha256`, `upstream` and `harnessSha256`. forge runs with a minimal environment (PATH, HOME, TMPDIR, USER, LANG, TLS and proxy variables); `FOUNDRY_*`, `ETH_RPC_URL` and everything else from the caller's shell are dropped, and only the runner's own `SF_*` and `FOUNDRY_FUZZ_FAILURE_PERSIST_DIR` are set.
- Output: `<project>/.specfirst/checks/<chainId>/<address lowercase>/<block>.json` (zod schema `StandardCheckReport`) and, when forge ran, forge's JSON document alone (log lines before it dropped) as `<block>.forge.json`. Both are written through temp files and renamed, and only after the report validated; when forge did not run a stale `<block>.forge.json` is removed. The RPC URL, its host and key-like path and query parts are masked as `<rpc>` in any letter case wherever forge output is kept. The path follows the existing `.specfirst/` layout for run artifacts and the `<chainId>/<address>` layout of `certs/`.
- Exit codes:

  | Code | Constant | When |
  |---|---|---|
  | 0 | | every property passed |
  | 16 | `STANDARD_CHECK_FAILED_EXIT_CODE` | at least one property failed |
  | 17 | `STANDARD_CHECK_INCOMPLETE_EXIT_CODE` | nothing failed, but at least one property is inconclusive or not applicable, or none passed: not verified |
  | 1 | | the check could not run (bad arguments, no code at the address, forge produced no JSON, RPC unreachable) |

- Per-property status: `pass`; `fail` with the reason, forge's decoded assertion lines and the failing call; `inconclusive` when forge rejected every input (for example maxDeposit is 0 and deposit reverts), `deal` could not fund users, or the fork RPC failed, in a test or in setUp; `not_applicable` when setUp reverts for another reason (for example no `asset()`) or the vault is an ERC-7535 native-asset vault. The upstream assertions call `fail()` after emitting log lines, so forge's reason is often null or empty; that is still `fail`, and the first decoded log line becomes the reason.
- Classification only recognises the messages forge and forge-std write, anchored at the start of the reason: `EVM error; database error: ` (fork RPC), `` `vm.assume` rejected too many inputs (N allowed) `` (every input rejected), `stdStorage find(StdStorage): ` (`deal` failed). A vault revert that merely reads like RPC trouble, such as "rate limit exceeded" or "HTTP error 503", stays `fail`.
- Policy: only `pass` counts as verified. `inconclusive` and `not_applicable` never count as pass and lead to exit 17. A contract's revert string becomes forge's reason verbatim, so an adversarial author can imitate one of the prefixes above and turn a `fail` into `inconclusive`; what they get is "not verified", never "verified".

## Upstream and license
a16z/erc4626-tests is AGPL-3.0. None of its code is copied into this repository. At run time the pinned commit is fetched into a cache directory (`$SPECFIRST_CACHE_DIR`, else `$XDG_CACHE_HOME/specfirst`, else `~/.cache/specfirst`) with `git init`, `git fetch --depth 1 origin <sha>`, `git checkout FETCH_HEAD`, and the checked-out HEAD is compared with the pin. forge-std is fetched the same way. The cache is outside any user project so the upstream code never ends up committed in someone's repository.

Our harness template (`packages/core/src/standards/erc4626/SpecfirstERC4626.t.sol`) and the positive control test (`control/SpecfirstERC4626Control.t.sol`) inherit the upstream contracts, so both carry `SPDX-License-Identifier: AGPL-3.0`. The control vault (`control/BrokenVault.sol`) does not inherit anything and is MIT. The rest of the repository keeps its license. The report records `upstream.repo`, `upstream.commit` and `harnessSha256` so a reader can rebuild exactly what ran.

## How the harness differs from upstream
The upstream `ERC4626Test` assumes a mock underlying token it can mint and burn. Against a live vault that is not possible, so the harness changes three things:
1. Balances come from forge-std `deal` instead of the mock token's `mint`.
2. Amounts are bounded to `min(maxDeposit(user), 1e6 whole tokens)`, so the fuzzer does not spend its runs on amounts no live vault accepts.
3. No synthetic yield: `setUpYield` is never called, so the vault's own share price at the fork block is what gets tested.

Test users must be EOAs above the precompile range (`> 0xffff`) and never the vault or its asset. Two robustness changes keep one broken view function from hiding the rest: a reverting `maxDeposit` falls back to the 1e6-token cap inside `setUpVault`, so it fails `test_maxDeposit` ("MUST NOT revert") and nothing else, and a reverting `decimals()` falls back to 18.

A deposit that reverts at or below the vault's own `maxDeposit` is discarded with `vm.assume(false)`, as upstream does. EIP-4626 says it must not revert, so the harness also appends the running test's selector to `sf-events/<run>.deposit-below-max.log` (the only path `fs_permissions` allows writing). The runner counts these per property and appends "deposit reverted below maxDeposit N times" to the reason. The status is not changed: turning it into `fail` risks false positives (a deposit can revert below maxDeposit for reasons the harness caused), so for now it is a visible note on top of `inconclusive` or `pass`.

## Implementation identity
Each report carries `identity`, so N vaults from one factory are not counted as N checks. Measured on Monad mainnet, the runtime code hash alone does not work: three MetaMorpho vaults (0x802c..4e44, 0xBC03..6D29, 0x3284..476D) have the same 19,689-byte code but three different hashes, 52 to 132 bytes apart, all inside immutables.

Fingerprints, for the contract and, when it is a proxy, for its implementation:
- `codeHash`: keccak256 of the runtime code.
- `metadataHash`: the `ipfs` (or `bzzr1`, `bzzr0`) value in the Solidity CBOR metadata at the end of the runtime code (last 2 bytes are its length). Same source and compiler settings give the same value whatever the constructor arguments. Null when missing. The MetaMorpho vaults above carry only `{solc}` in their CBOR (compiled with `bytecode_hash = none`), so this alone does not group them.
- `maskedCodeHash`: keccak256 of the runtime code without the CBOR tail and with every PUSH32 immediate zeroed. solc places immutables as PUSH32 immediates, so the three MetaMorpho vaults share it.

`implementationKey` comes from one fingerprint only: the implementation's when its code was found, otherwise the contract's own; the two are never mixed. Within that fingerprint it is `keccak256(metadataHash || maskedCodeHash)` when there is metadata, else `maskedCodeHash`, else `codeHash`. The CBOR tail is declared by the contract itself and can be copied onto any code, so it never keys alone; the masked code has to match as well. `implementationKeyKind` records which (`of`: implementation or self, `hash`: `metadataHash+maskedCodeHash`, `maskedCodeHash` or `codeHash`), so the web page can show the grounds ("same code with immutables masked") as they are.

Proxies followed automatically: EIP-1167 minimal clones, and the EIP-1967 implementation slot and beacon slot (the beacon's `implementation()` is read at the same block). The slots are read only for proxy-shaped code: under 1,024 bytes before the CBOR tail and containing a DELEGATECALL opcode. A full contract can write any address into its own slot and must not borrow another contract's identity that way; larger proxies (for example some TransparentUpgradeableProxy builds) are therefore keyed by their own code, which groups them more coarsely but never inflates the count. Proxy-shaped code without a usable slot, or with a beacon whose `implementation()` reverts or returns zero, is `proxy: {kind: "unknown"}` and keyed by its own fingerprint. The Euler EVK vault 0x4735..cfB7 (366 bytes) keeps its factory as a PUSH32 immutable and also writes it to the EIP-1967 beacon slot, so it resolves as `eip1967-beacon` to 0xef17..0ECD.

## Limitations
- No synthetic yield or loss. Properties are checked at the vault's current share price only; bugs that appear only after a gain or a loss are out of reach.
- Amounts are capped at `min(maxDeposit, 1e6 whole tokens)`. Overflow and rounding at larger amounts are not explored.
- Tokens whose balances `deal` cannot write (rebasing, computed balances, some proxies) make every property `inconclusive`, never `pass`.
- ERC-7535 native-asset vaults (`asset()` returns 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, for example FastLane shMONAD 0x1B68..E19c) are `not_applicable`: the harness funds users with ERC-20 `deal` and `approve`. forge is not started for them.
- Checks that share an `implementationKey` ran the same code and count once. Masking every PUSH32 immediate also masks real constants (event topics, magic numbers), so two contracts that differ only in such a constant are grouped together.
- `pass` means no counterexample in `runs` fuzz cases at one block, not a proof. At 32 runs the full suite took 9 min 35 s against the public Monad RPC.
- Public RPCs rate-limit. The first `specfirst check --runs 8` on the Morpho vault below hit HTTP 429 from https://rpc.monad.xyz (50 requests per second) and forge reported test_withdraw as a Failure ("EVM error; database error: ... HTTP error 429"). A second run with longer retries lost another property the same way. Such failures say nothing about the contract, so they are `inconclusive` with the RPC reason. forge is now also throttled to 100 compute units per second; with that the same run was 26 of 26 pass in 246 s. One clean run is not a guarantee on a shared endpoint. A check with inconclusive properties should be rerun, ideally on a dedicated RPC.
- Deposits that revert at or below maxDeposit are discarded like upstream, so a vault that reverts every such deposit ends `inconclusive` (too many rejects), not `fail`. The count is shown in the reason (see above) but does not change the status.
- tx.origin is detectable. forge runs each test from `--sender`, a fresh random EOA per run, so a vault cannot recognise forge's well-known default sender. The upstream properties still `vm.prank` the user, which changes msg.sender but not tx.origin, so inside a test `tx.origin != msg.sender` while a real EOA call has them equal. A vault that branches on tx.origin can behave differently under the harness.
- forge still reads the global `~/.foundry/foundry.toml` of the machine it runs on; only the environment is cleaned.
- `--delta` defaults to 0, which is the strict reading of EIP-4626; vaults that round by a wei in the user's favour need an explicit delta, recorded in the report.

## Evidence
- Morpho vault 0x802c91d807A8DaCA257c4708ab264B6520964e44, Monad mainnet block 109061472, 32 runs: 26 of 26 pass. At 8 runs on the public RPC: 25 pass and 1 inconclusive (HTTP 429 on one storage read) before throttling, 26 of 26 pass after.
- The same harness on a local vault that mints one extra share per deposit: 4 round-trip properties fail with the upstream "a <=~ b" lines (delta 1), exit 16.
- Positive control: BrokenVault (previewDeposit promises 1% more shares than deposit mints) created inside the same fork over Monad USDC, 8 runs: previewDeposit is the only fail, the other 25 pass. A harness that passed this vault could not catch the bug. `SPECFIRST_LIVE=1` tests assert this.
- Local anvil fixtures (code placed with `anvil_setCode`) cover fail with a null reason, every input rejected, `deal` failure and setUp revert (packages/core/test/fixtures/standards).
- Code review reproductions (fixtures/standards/review): vault reverts "rate limit exceeded" and "HTTP error 503" stay `fail`; a setUp that hits HTTP 429 on the fork is `inconclusive`; with the current harness a reverting maxDeposit fails `test_maxDeposit` only; a vault whose deposit always reverts below maxDeposit logs about 41,000 discards per property at the default reject limit.

## Workspace hygiene
The cache workspace is `<cacheDir>/standards/erc4626-<upstream 12>-<forge-std 12>`, one per pin pair, so two versions never share (or race on) one directory. A pinned checkout is reused only when HEAD is the pin and `git status --porcelain --untracked-files=all` is empty; otherwise it is fetched again. Everything the workspace does not own is removed before each run: other files under `test/` and `src/`, other libraries under `lib/`, and any other top-level entry (forge reads `remappings.txt` and `.env` from the project root). Files are written through a temp file outside the workspace and renamed, and git runs without `GIT_*` variables.

## Safety
`check` is the only command allowed on `monad-mainnet` (chain 143). Three layers keep transactions off it, each fixed by tests:
1. `resolveNetwork` refuses it for every other command (deploy, verify with its rehearsal, run with its deploy pipeline, cert issue, cert revoke) with a ConfigError before any key is read or RPC is called. Network names resolve to own keys only, so "toString" or "__proto__" are unknown networks.
2. `createChainClients().wallet()` refuses to build a signer for chain 143 or for a chain id that is not a safe integer.
3. Before the first `eth_sendRawTransaction` or `eth_sendTransaction` on each RPC URL, the transport reads that URL's `eth_chainId` and refuses to send when it differs from the wallet's chain or is a write-forbidden chain. A testnet configuration pointed at a mainnet RPC therefore stops before the first transaction.

## Follow-ups
- Mask only the immutable positions instead of every PUSH32 immediate, using the `immutableReferences` Sourcify returns for verified contracts, and fall back to the current masking when a contract is not verified.
- Recognise more proxy shapes (ERC-3448 MetaProxy, other immutable-beacon layouts) instead of `unknown`.
- More standards from the same kind of third-party suites, each with its own positive control.
