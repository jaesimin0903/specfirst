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
  mock-vaults.sol also holds HonouringVault (0x5F..31), AsyncExitVault (0x5f..32, withdraw and redeem always
  revert WithdrawalRequestRequired() 0x75ed2e3e while maxWithdraw and maxRedeem report the balance, like Upshift
  earnAUSD) and HonestClosedExitVault (0x5f..33, same exits but max values of 0). Full checks, upstream plus
  Specfirst's sf- properties, --fuzz-runs 16, seed 1, max_test_rejects 4096:
  local-sf-honouring.json      30 pass.
  local-sf-async-exit.json     sf-maxWithdraw-honored and sf-maxRedeem-honored fail; 12 upstream properties
                               that withdraw or redeem end inconclusive (too many rejects).
  local-sf-honest-closed.json  nothing fails; the same 12 plus the two sf exit properties are inconclusive.
  mock-vaults.sol also holds PackedToken (0x5F..03) and PackedAssetVault (0x5F..21), used live by
  standards.forge.test.ts on a local anvil fork: all 26 pass through the harness's packed-slot fallback.

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

upshift-proxy-143-109061472.hex
  Runtime code (2,001 bytes) of the OpenZeppelin TransparentUpgradeableProxy at Upshift earnAUSD
  0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E, Monad block 109061472, read from forge's local fork cache
  (~/.foundry/cache/rpc/143/109061472). keccak256 matches the cached code_hash
  0xa60c40de9979a21d4ec81b613b9da678727c39ef441c3227d78330cf649233b0.

local-erc7575-no-precheck.json
  SplitShareVault (0x5F..42, mock-vaults.sol): an ERC-7575 vault whose shares are SplitShareToken (0x5f..41);
  the vault has no balanceOf, allowance, approve or totalSupply. Full check run by the runner before the
  ERC-7575 pre-check existed (--fuzz-runs 16, seed 1, local anvil): 14 pass and 16 fail with reason
  "EvmError: Revert" (a call to a missing function, no revert data): deposit, mint, previewWithdraw,
  withdraw, withdraw-zero-allowance, previewRedeem, redeem, redeem-zero-allowance and the 8 round trips.
  The same 16 failed on Centrifuge V3 0x082c62088669facc1fa9f056c5efc8cbccda39b2 on Monad. Today the
  pre-check skips forge for such a vault; the fixture pins how the parser reads that output.

local-zero-max.json
  ZeroMaxVault (0x5F..51, mock-vaults.sol): maxDeposit, maxMint, maxWithdraw and maxRedeem return 0 for
  everyone, the actions work (the shape of Morpho Vault V2 on Monad). Full check with the harness that tries
  the cap when maxDeposit is 0 (--fuzz-runs 16, seed 1, local anvil): the 26 upstream properties pass, the
  four sf- properties end on too many rejects (a max of 0 discards their inputs). With the sf- suite's
  max-zero events (4096 per property, synthesized in standards.parse.test.ts from the measured count)
  they parse as not_applicable.

local-restricted-asset.json, local-partial-restricted.json, local-hook-blocked.json
  Full checks with the transfer probe in both setUps (--fuzz-runs 16, seed 1, local anvil, mock-vaults.sol):
  RestrictedAssetVault (0x5F..61) over AllowlistToken (nobody may transfer, like Valos vUSD) and
  PartialRestrictedVault (0x5F..62) over RecipientAllowlistToken (only the vault may receive: deposits work,
  withdrawals fail in the token, like Euler 0xD8ec..305D) both stop in setUp: 30 not_applicable, reason
  "asset token restricts transfers ... (selector 0x82b42900)". HookBlockedVault (0x5f..63) keeps a free
  asset but refuses deposits in the vault (like Euler 0xf26d..95Bf): the probe passes, sf-maxDeposit-honored
  and sf-maxMint-honored fail with NotAuthorized() 0xea8e4eb5, the rest are inconclusive.

Monad precompiles, mint funding and refusals below the bound (mock-vaults.sol, used live by
standards.forge.test.ts on a local anvil fork started with --chain-id 143, no recorded JSON). An input whose vault
call needed a missing precompile is left unjudged with an event; a property with any unjudged input is never a
pass (a fail elsewhere stays a fail, otherwise inconclusive). Any revert of a call that reached a missing
precompile is unjudged, whatever it says. Inputs rejected in a setup deposit (setUpVault, the deposit that gives
shares) count as rejects of the property, not as unjudged inputs.
  PrecompileVault (0x5f..71)           deposit and mint stake through Monad's staking precompile 0x1000, like
                                       Magma gMON: every input needs it, 30 inconclusive, skipReason
                                       missing-precompile.
  ThresholdPrecompileVault (0x5f..72)  stakes only deposits and mints above 10 tokens: no fail, the 26 upstream
                                       properties pass (their staked setUpVault deposits are rejects), sf-maxDeposit
                                       and sf-maxMint inconclusive with the staked inputs counted, sf-maxWithdraw
                                       and sf-maxRedeem judged with a one-token deposit and passing.
  FakePrecompileTextVault (0x5f..73)   maxMint and withdraw revert with precompile-sounding text and call no
                                       precompile: maxMint and sf-maxWithdraw-honored stay fail.
  FakePrecompileSetupVault (0x5F..74)  asset() reverts with that text: 30 not_applicable, setup-reverted.
  MintSurchargeVault (0x5f..75)        mint pulls 2% plus 2 more than previewMint quotes (hyAUSD shape):
                                       previewMint fails, sf-maxMint-honored passes. The harness before 2026-10-07
                                       (1% more funding) failed sf-maxMint-honored with Panic 0x4e487b71.
  MinDepositVault (0x5f..76)           deposit and mint refuse amounts below 500,000 tokens under an unlimited max:
                                       sf-maxDeposit-honored and sf-maxMint-honored pass with the below-bound count.
                                       The harness before 2026-10-07 failed both with BelowMinimum() 0x860b82a9.
  WithdrawFeeVault (0x5f..9b)          sLVMON shape: previewWithdraw and withdraw charge a 5 bps fee in shares,
                                       maxWithdraw ignores it, so withdraw(maxWithdraw) reverts. Every sf- run
                                       tries the bound after the drawn amount, so sf-maxWithdraw-honored fails at
                                       the bound with every seed (sf-only runs, 4 runs, five seeds); the harness
                                       before passed it at 4 runs with each of ten seeds.
  PreviewDodgeVault (0x5F..9c)         maxRedeem reports the whole balance while 0.05% is illiquid; previewRedeem and
                                       redeem revert at the bound. A reverting preview does not skip the bound:
                                       sf-maxRedeem-honored fails at maxRedeem with every seed, sf-maxWithdraw
                                       (which honours the illiquid part) passes.
  ApproveCapToken (0x5F..06), ApproveCapVault (0x5f..9d)  approve refuses more than 1,000 tokens, so the
                                       1e6-token bound cannot be funded: sf-maxDeposit and sf-maxMint end
                                       inconclusive with "the bound could not be funded in N inputs", never pass.
Review PoCs (ported from the reviewer's Adv.sol, mock-vaults.sol "Review PoCs"), full checks, 16 runs where the
fuzzer must reach a fee bug:
  FeeVault (0x5F..91), FeeTouchVault (0x5F..92)  fee withdraw (Panic 0x11 near maxWithdraw); FeeTouch adds an
                                       ignored staticcall to 0x1001. FeeVault fails sf-maxWithdraw-honored with a
                                       counterexample; FeeTouch's reverting withdraws are not judged, so it is
                                       inconclusive there (never a pass) and keeps its previewWithdraw fail.
  ProbeKillVault (0x5f..93), ProbeKillControl (0x5F..94)  bonus share and fee withdraw; ProbeKill also touches
                                       0x1001 and reverts for exactly one whole token (the old probe amount). Both
                                       fail previewWithdraw, sf-maxWithdraw-honored and, since the bound is always
                                       tried, sf-maxRedeem-honored (the bonus share makes redeem(maxRedeem) pay one
                                       unit more than the vault holds); nothing stops the suites.
  WindowVault (0x5F..95)               refuses 500,000 to 1,000,000 tokens and accepts the bound: sf-maxDeposit
                                       passes with "N amounts below the bound were refused; the bound itself was
                                       accepted".
  ReenterVault (0x5f..96)              calls setUp and an sf- property back from its deposit: the guard refuses,
                                       30 pass, no event.
  LyingMintVault (0x5F..97)            mint pulls more than it returns: test_mint fails, sf-maxMint passes.
  FeeLaunderVault (0x5f..98)           second review: FeeVault's bug, an ignored staticcall to 0x1001 and a withdraw
                                       that does nothing when 0x1001 has code (the former mocked rerun gave it code).
                                       sf-maxWithdraw-honored is never a pass; FeeVault fails it.
  HonestDynVault (0x5f..99)            third review: every deposit reads getDelegations (a dynamic return) from
                                       0x1000 and delegates; honest on Monad, reverts with no data on the fork. Must
                                       never fail: sf-maxDeposit-honored is inconclusive with its inputs not judged.
  EpochGuardVault (0x5F..9a)           fourth review: every deposit reads getEpoch() from 0x1000 with a low-level
                                       call and reverts InvalidEpoch() below epoch 500 or on a malformed answer;
                                       honest on Monad. Must never fail: the deposit inputs are not judged.
review/M.sol Vault mode 5 deposits through 0x1000; review/Exp.t.sol ForkGaps covers SfForkGaps (the list only on
chains 143 and 10143, a precompile the EVM has is left out, a staking deposit needs 0x1000, any revert after
reaching a precompile is blamed on it with or without data, a call without any precompile is the vault's own
revert, reverted frames are seen) and the SfEvents
re-entry guard; GuardedSetUp the setUp guard.

Asynchronous exits and the async-redeem trait (mock-vaults.sol, full checks on a local anvil fork in
standards.forge.test.ts, no recorded JSON):
  AsyncRedeemVault (0x5f..81)      Upshift shape with ERC-7540 requestRedeem in the code: trait with run
                                   exits-rejected and erc165 null, statuses identical to AsyncExitVault (0x5f..32,
                                   the same exits without a request function, no trait).
  SelectorOnlyVault (0x5f..82)     requestRedeem in the code, withdraw and redeem work: 30 pass, no trait.
  PrecompileAsyncVault (0x5f..83)  gMON shape: deposits stop at 0x1000, requestRedeem, ERC-165 declares
                                   0x620ee8e4: 30 inconclusive, trait with run not-exercised.
standards.traits.test.ts reads two committed reports of the 2026-09-30 batch (certs/checks/143, Upshift earnAUSD
and Morpho 0x802c..4e44) for the run evidence.
