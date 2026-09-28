forge forge Version: 1.5.1-Homebrew
Captured from a scratch Foundry project with
  forge test --match-path test/specfirst/Invariants.t.sol --json
env FOUNDRY_INVARIANT_RUNS=20 FOUNDRY_INVARIANT_DEPTH=10 FOUNDRY_FUZZ_SEED=1.
pass.json, fail.json, setup.json: stdout, "traces" arrays emptied to keep the files small.
compile-error.stdout.txt and compile-error.stderr.txt: raw streams of a compile failure (exit 1, stdout is not JSON).
example-buggy.json, example-fixed.json: examples/staking-vault at 6c7e768 (planted reentrancy, then fixed/StakingVault.sol),
env FOUNDRY_INVARIANT_RUNS=64 FOUNDRY_INVARIANT_DEPTH=32 FOUNDRY_FUZZ_SEED=1, fresh FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR, traces emptied.
