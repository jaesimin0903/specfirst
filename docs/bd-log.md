# BD log: aggregator and partner contact

Rule: record every outreach and every reply by date. Quote a reply only with permission. "Integration 1" is claimed only at L2 or above.

Levels: L0 no reply | L1 reply with interest or feedback | L2 applied on their staging or testnet screen | L3 merged into their repo or production.

## Draft message (Moose, Kuru)

Subject: Metropolis Track 4, a two-line certified-vault check for your routing UI

Hi, I am building Specfirst for Metropolis Track 4. It issues onchain verification certificates for contracts: a spec of plain-language invariants is fuzzed with Foundry, the contract is deployed and rehearsed on Monad testnet, and the result is recorded in a registry keyed by contract address and by invariant-set hash.

What I am asking for is small. On a staking route or vault card, call one view and show a badge:

    registry.isCertifiedWith(vault, BASIC_VAULT_INVARIANTS_V1)

or fetch GET /api/cert/{address} and render "certified, 7 invariants, issued 3 days ago". Uncertified vaults are not blocked, they just show no badge. A one-line widget script is also available.

Why it might matter to you: after the 0x report on hook quote spoofing, exposure criteria are the question. This gives you a criterion you did not have to write, with the invariant list public on the certificate page.

I can have the registry on testnet by Sep 30 and a sample certified vault by Oct 4. If you are open to trying it on a staging screen before Oct 8, I will adapt to whatever format you need.

Repo (public): github.com/jaesimin/specfirst
Thanks, Jaemin

## Log

| Date | Party | Channel | Action | Level | Notes |
|---|---|---|---|---|---|
| 2026-09-29 | Moose (FastLane) | hackathon mentor channel | draft ready, not yet sent | L0 | send by user |
| 2026-09-29 | Kuru | hackathon mentor channel | draft ready, not yet sent | L0 | send by user |
