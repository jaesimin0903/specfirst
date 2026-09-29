# ADR 0003: Third-party standard properties on deployed contracts (`specfirst check`)

Date: 2026-09-30. Status: accepted.

## Problem
A Specfirst certificate is issued against invariants the deployer wrote in their own spec. A malicious or careless author can write a spec that their contract trivially satisfies and still receive "verified". The certificate proves consistency with the author's claims, not with anything a third party agreed on.

## Decision
Add a read-only path that runs a public property suite, written and maintained by neither the deployer nor Specfirst, against a contract that is already deployed:

    specfirst check <address> --standard erc4626 [--network monad-mainnet|monad-testnet|anvil] [--rpc <url>] [--block <n>] [--runs <n>] [--delta <n>]

- Suite: a16z/erc4626-tests, pinned at commit `ac485460e014f22807c1ff687e0b4dc3af96ee40` (26 fuzz tests), with forge-std v1.16.2 (`bf647bd6046f2f7da30d0c2bf435e5c76a780c1b`) and solc 0.8.28, evm_version prague.
- Execution: `forge test --fork-url <rpc> --fork-block-number <block> --fuzz-runs <n> --compute-units-per-second 100 --fork-retries 10 --fork-retry-backoff 2000 --json -vv` with `SF_VAULT` and `SF_DELTA`, and a fresh fuzz failure directory per run so one vault's counterexample is never replayed against the next. The block defaults to the latest block when the check starts and is always recorded. Nothing is signed or sent; forge runs against a local fork.
- Output: `<project>/.specfirst/checks/<chainId>/<address lowercase>/<block>.json` (zod schema `StandardCheckReport`, validated before it is written) and the raw forge output next to it as `<block>.forge.json`. The path follows the existing `.specfirst/` layout for run artifacts and the `<chainId>/<address>` layout of `certs/`.
- Exit codes: 0 when no property failed, 16 (`STANDARD_CHECK_FAILED_EXIT_CODE`) when at least one failed, 1 when the check could not run.
- Per-property status: `pass`; `fail` with the reason, forge's decoded assertion lines and the failing call; `inconclusive` when forge rejected every input (for example maxDeposit is 0 and deposit reverts), `deal` could not fund users, or the fork RPC failed mid-run; `not_applicable` when setUp reverts (for example no `asset()`) or the vault is an ERC-7535 native-asset vault. The upstream assertions call `fail()` after emitting log lines, so forge's reason is often null or empty; that is still `fail`, and the first decoded log line becomes the reason.

## Upstream and license
a16z/erc4626-tests is AGPL-3.0. None of its code is copied into this repository. At run time the pinned commit is fetched into a cache directory (`$SPECFIRST_CACHE_DIR`, else `$XDG_CACHE_HOME/specfirst`, else `~/.cache/specfirst`) with `git init`, `git fetch --depth 1 origin <sha>`, `git checkout FETCH_HEAD`, and the checked-out HEAD is compared with the pin. forge-std is fetched the same way. The cache is outside any user project so the upstream code never ends up committed in someone's repository.

Our harness template (`packages/core/src/standards/erc4626/SpecfirstERC4626.t.sol`) and the positive control test (`control/SpecfirstERC4626Control.t.sol`) inherit the upstream contracts, so both carry `SPDX-License-Identifier: AGPL-3.0`. The control vault (`control/BrokenVault.sol`) does not inherit anything and is MIT. The rest of the repository keeps its license. The report records `upstream.repo`, `upstream.commit` and `harnessSha256` so a reader can rebuild exactly what ran.

## How the harness differs from upstream
The upstream `ERC4626Test` assumes a mock underlying token it can mint and burn. Against a live vault that is not possible, so the harness changes three things:
1. Balances come from forge-std `deal` instead of the mock token's `mint`.
2. Amounts are bounded to `min(maxDeposit(user), 1e6 whole tokens)`, so the fuzzer does not spend its runs on amounts no live vault accepts.
3. No synthetic yield: `setUpYield` is never called, so the vault's own share price at the fork block is what gets tested.

Test users must be EOAs above the precompile range (`> 0xffff`) and never the vault or its asset.

## Implementation identity
Each report carries `identity`, so N vaults from one factory are not counted as N checks. Measured on Monad mainnet, the runtime code hash alone does not work: three MetaMorpho vaults (0x802c..4e44, 0xBC03..6D29, 0x3284..476D) have the same 19,689-byte code but three different hashes, 52 to 132 bytes apart, all inside immutables.

Fingerprints, for the contract and, when it is a proxy, for its implementation:
- `codeHash`: keccak256 of the runtime code.
- `metadataHash`: the `ipfs` (or `bzzr1`, `bzzr0`) value in the Solidity CBOR metadata at the end of the runtime code (last 2 bytes are its length). Same source and compiler settings give the same value whatever the constructor arguments. Null when missing. The MetaMorpho vaults above carry only `{solc}` in their CBOR (compiled with `bytecode_hash = none`), so this alone does not group them.
- `maskedCodeHash`: keccak256 of the runtime code without the CBOR tail and with every PUSH32 immediate zeroed. solc places immutables as PUSH32 immediates, so the three MetaMorpho vaults share it.

`implementationKey` is the first available of: implementation metadataHash, own metadataHash, implementation maskedCodeHash, own maskedCodeHash, implementation codeHash, own codeHash. `implementationKeyKind` records which one (`of`: implementation or self, `hash`: metadataHash, maskedCodeHash or codeHash), so the web page can show the grounds ("same code with immutables masked") as they are.

Proxies followed automatically: EIP-1967 implementation slot, EIP-1967 beacon slot (the beacon's `implementation()` is read at the same block), and EIP-1167 minimal clones. The Euler EVK vault 0x4735..cfB7 keeps its factory as a PUSH32 immutable and also writes it to the EIP-1967 beacon slot, so it resolves as `eip1967-beacon` to 0xef17..0ECD. Any other code under 1,024 bytes (before the CBOR tail) that contains a DELEGATECALL opcode is reported as `proxy: {kind: "unknown"}` and keyed by its own fingerprints.

## Limitations
- No synthetic yield or loss. Properties are checked at the vault's current share price only; bugs that appear only after a gain or a loss are out of reach.
- Amounts are capped at `min(maxDeposit, 1e6 whole tokens)`. Overflow and rounding at larger amounts are not explored.
- Tokens whose balances `deal` cannot write (rebasing, computed balances, some proxies) make every property `inconclusive`, never `pass`.
- ERC-7535 native-asset vaults (`asset()` returns 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, for example FastLane shMONAD 0x1B68..E19c) are `not_applicable`: the harness funds users with ERC-20 `deal` and `approve`. forge is not started for them.
- Checks that share an `implementationKey` ran the same code and count once. Masking every PUSH32 immediate also masks real constants (event topics, magic numbers), so two contracts that differ only in such a constant are grouped together.
- `pass` means no counterexample in `runs` fuzz cases at one block, not a proof. At 32 runs the full suite took 9 min 35 s against the public Monad RPC.
- Public RPCs rate-limit. The first `specfirst check --runs 8` on the Morpho vault below hit HTTP 429 from https://rpc.monad.xyz (50 requests per second) and forge reported test_withdraw as a Failure ("EVM error; database error: ... HTTP error 429"). A second run with longer retries lost another property the same way. Such failures say nothing about the contract, so they are `inconclusive` with the RPC reason. forge is now also throttled to 100 compute units per second; with that the same run was 26 of 26 pass in 246 s. One clean run is not a guarantee on a shared endpoint. A check with inconclusive properties should be rerun, ideally on a dedicated RPC.
- `--delta` defaults to 0, which is the strict reading of EIP-4626; vaults that round by a wei in the user's favour need an explicit delta, recorded in the report.

## Evidence
- Morpho vault 0x802c91d807A8DaCA257c4708ab264B6520964e44, Monad mainnet block 109061472, 32 runs: 26 of 26 pass. At 8 runs on the public RPC: 25 pass and 1 inconclusive (HTTP 429 on one storage read) before throttling, 26 of 26 pass after.
- The same harness on a local vault that mints one extra share per deposit: 4 round-trip properties fail with the upstream "a <=~ b" lines (delta 1), exit 16.
- Positive control: BrokenVault (previewDeposit promises 1% more shares than deposit mints) created inside the same fork over Monad USDC, 8 runs: previewDeposit is the only fail, the other 25 pass. A harness that passed this vault could not catch the bug. `SPECFIRST_LIVE=1` tests assert this.
- Local anvil fixtures (code placed with `anvil_setCode`) cover fail with a null reason, every input rejected, `deal` failure and setUp revert (packages/core/test/fixtures/standards).

## Safety
`check` is the only command allowed on `monad-mainnet` (chain 143). `resolveNetwork` refuses it for every other command (deploy, verify with its rehearsal, run with its deploy pipeline, cert issue, cert revoke) with a ConfigError before any key is read or RPC is called, and `createChainClients().wallet()` refuses to build a signer for chain 143 as a second layer. Both are fixed by tests.

## Follow-ups
- Mask only the immutable positions instead of every PUSH32 immediate, using the `immutableReferences` Sourcify returns for verified contracts, and fall back to the current masking when a contract is not verified.
- Recognise more proxy shapes (ERC-3448 MetaProxy, other immutable-beacon layouts) instead of `unknown`.
- More standards from the same kind of third-party suites, each with its own positive control.
