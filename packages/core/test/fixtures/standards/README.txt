forge Version: 1.5.1-Homebrew. Raw `forge test --json` stdout of the ERC-4626 standard harness,
with the raw "logs" and "traces" arrays emptied to keep the files small (decoded_logs are kept).
The upstream suite is a16z/erc4626-tests at ac485460e014f22807c1ff687e0b4dc3af96ee40.

morpho-143-109061472-runs32.json
  Monad mainnet (chain 143), fork block 109061472, Morpho vault 0x802c91d807A8DaCA257c4708ab264B6520964e44,
  --fuzz-runs 32, run from the proof-of-concept harness (suite name LiveVaultTest, same logic as
  SpecfirstERC4626.t.sol, without -vv). All 26 tests Success, forge reported 9m 35s.

morpho-143-109061472-runs8-rpc429.json
  The same vault and block through `specfirst check --runs 8` against the public RPC (https://rpc.monad.xyz).
  The RPC answered HTTP 429 (50 requests per second) mid-run: forge printed an ERROR log line before the
  JSON and reported test_withdraw as Failure with "EVM error; database error: ... HTTP error 429". The
  other 25 are Success. Kept with its leading log line; it must parse as inconclusive, never fail.

control-143-109061472-runs8.json
  Positive control: SpecfirstERC4626Control (BrokenVault over Monad USDC 0x754704Bc059F8C67012fEd69BC8A327a5aafb603)
  on the same fork block, --fuzz-runs 8 -vv, via runErc4626Control. Only test_previewDeposit fails
  (forge reason null, the assertion is in decoded_logs); the other 25 pass. forge reported 4m 10s.

local-*.json
  runStandardCheck against contracts placed with anvil_setCode on a local anvil (no transaction, no key),
  fork block 1, --fuzz-runs 8 -vv. Sources: mock-vaults.sol in this directory (MIT, fixture only).
  local-buggy.json     BuggyVault: mints one extra share per deposit, four round-trip properties fail
                       (forge reason null, the assertion is in decoded_logs).
  local-closed.json    ClosedVault: maxDeposit 0 and deposit reverts, every input rejected (too many rejects).
  local-computed.json  ComputedAssetVault: the asset keeps no balances in storage, so forge-std deal fails.
  local-notvault.json  SF_VAULT is the plain token: asset() reverts, setUp fails.

review/ (reproductions from the code review of the first version)
  M.sol, Exp.t.sol   MockToken and Vault(mode) created in setUp, no fork. Modes: 1 maxDeposit reverts
                     "rate limit exceeded", 2 maxDeposit reverts "paused", 3 maxRedeem reverts "HTTP error 503",
                     4 deposit reverts for any non-zero amount while maxDeposit is unlimited.
                     SetupRevertsRateLimit reverts "rate limit exceeded" in setUp. Exp.t.sol inherits the harness,
                     so it carries the harness license header.
  modes-old-harness.json  forge test --json -vv of Exp.t.sol with the first harness (maxDeposit not wrapped).
                     Used to show that vault reverts which merely read like RPC trouble stay fail.
  modes-new-harness.json  The same with the current harness, --fuzz-runs 16 --fuzz-seed 0x1: a reverting
                     maxDeposit fails test_maxDeposit only; mode 4 rejects every input.
  packed-asset-old-harness.json, packed-asset-new-harness.json
                     ModePackedAsset: PackedToken keeps the balance above a 64-bit field in one slot, like AUSD
                     (0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a) on Monad. The first harness's plain deal failed
                     all 26 with "stdStorage checked_write(StdStorage): Failed to write value."; the current
                     harness falls back to the packed slot write and all 26 pass. --fuzz-runs 16 --fuzz-seed 0x1.
                     DecimalsFallback checks that decimals() falls back to 18 (run by standards.forge.test.ts).
  setup-fork429.json setUp against a stub RPC answering HTTP 429 for the vault: forge prints an ANSI log line,
                     then setUp() Failure "EVM error; database error: ... HTTP error 429". Must be inconclusive.
