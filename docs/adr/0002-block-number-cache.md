# ADR 0002: Post-deploy verification must read the block number uncached

Date: 2026-09-29. Status: accepted.

## Problem
viem's `getBlockNumber()` returns a value cached for the client's polling interval (100 ms on anvil, 500 ms on Monad). Verification called it right after waiting for a deposit receipt and got the block before the deposit. `eth_getLogs` then stopped one block short, the depositor set missed the newest depositor, and INV-1 failed spuriously. On Monad, with blocks about 0.3 s apart, the same cache could also pin the fork one block early.

Found as a flaky test under `pnpm -r --parallel test` (1 of 2 runs). Root cause was in product code, not the test.

## Decision
Every block number used as a boundary in verify (depositor scan `toBlock`, fork block) and in the Probe path is read with `getBlockNumber({ cacheTime: 0 })`.

## Consequences
- A regression test caches the block number with a 60 s client, deposits, then verifies that the scan includes the deposit. Reverting the fix makes it fail deterministically.
- anvil test helpers start `anvil --port 0` and read the assigned port from stdout, so parallel suites never collide.
- Root `pnpm -r test` and `pnpm -r --parallel test` pass 3 times in a row (core 134, cli 39, web 48).
