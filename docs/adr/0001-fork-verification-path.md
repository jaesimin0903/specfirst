# ADR 0001: Post-deploy verification uses fixed-block forge fork, proxy dropped

Date: 2026-09-29. Status: accepted. Supersedes plan.md 3.6 item 6 (first fallback).

## Decision
Post-deploy verification runs the locked Solidity properties with `forge test --fork-url <quicknode>` on a fixed block. The "latest substitution RPC proxy" fallback is dropped. `SpecfirstProbe` (creation-code eth_call) stays as the only fallback.

## Drivers
- Spike (docs/spike-monad.md item 4): QuickNode serves historical state about 13.9M blocks deep (about 49.7 days). Re-query of the pinned block after 60 seconds succeeded. The whole hackathon window is about 15 days.
- Probe via `to`-less eth_call works on all three RPCs (item 6), so a fallback that needs no extra process exists.

## Alternatives considered
- Latest substitution proxy: solves a problem the measurement shows does not exist on QuickNode. Extra process, extra failure mode, and it blurs state across blocks during a run.
- Probe as primary: works, but re-implements property expressions outside the invariant test file, which is why it is a fallback only.

## Consequences
- verify uses QuickNode as the fork RPC. If another RPC must be used, its retention window has to be measured first (Ankr and Foundation were only checked to 1M blocks).
- eth_getLogs pagination is 100 blocks on every RPC, including Ankr's public gateway (measured cap about 101 despite the documented 1,000).
- debug_traceTransaction is available on QuickNode and Foundation with or without options. Ankr public gateway blocks it. Trace stays optional.
- Gas price measured 102 gwei on all three RPCs. MON estimate in plan 0.5 becomes about 8.5 MON. The 25 MON target stands.

## Follow-ups
- 9/29 key-required measurements remain: 16.7M-plus gas tx (docs say 30M per-tx cap, EIP-7825 says 16,777,216), SELFDESTRUCT after creation (EIP-6780), first deployment.
