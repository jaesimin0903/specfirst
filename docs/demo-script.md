# Specfirst demo script, 3 minutes

No terminal on screen. Every page is the running web app, every number is real: the Upshift values were measured on a mainnet fork, the board and the watcher feed read mainnet, and the gate and alert scenes replay what happened on Monad testnet on October 7. The recorded cut with Korean captions is `specfirst-demo-gate.mp4`; this file is the English narration for the submitted cut.

| Time | Screen | Narration |
|---|---|---|
| 0:00 | Card: a bot asks a vault `maxWithdraw`, the vault says 801,365.61 AUSD, the bot withdraws 796,956.94 AUSD, the call fails with `WithdrawalRequestRequired` | A curator's bot asks a vault how much it can take out. The vault says 801 thousand. The bot asks for 797 thousand and the withdrawal fails. This is Upshift earnAUSD on Monad mainnet, measured on a fork. |
| 0:15 | Same card, footnote visible | Bots, allocator vaults and lending markets size their moves from these answers. The only way to know a vault answers wrong is to write tests for that vault. Monad has more than 400 of them, and new ones every day. |
| 0:25 | Vault page `/v/143/0xD793...dA5E`, verdict at the top | Open the same vault on Specfirst. It is already marked as a spec mismatch, and nobody asked for that check. |
| 0:33 | Same page, scrolled to "What failed" | The page says which sentence of EIP-4626 it breaks and shows the call. The same result is recorded on chain, and a contract reads it with one call, `isCompliant`. |
| 0:43 | Board `/`, then the findings section | 402 vaults on mainnet. 117 of them the watcher found on chain by itself. Four of the findings, hyAUSD, sLVMON, locked.aprMON and tyYIELD, were found and checked with no person involved, and three of them were attested on chain. A rounding issue is marked SHOULD, not MUST. |
| 0:58 | Watcher feed `/watch?chain=143` | Nobody registers a vault. A factory deployment, a first deposit or a proxy upgrade is enough for the watcher to check it. |
| 1:08 | Card: the testnet timeline of October 7 | Here is what happened on testnet. A new vault was deployed. 18 seconds later it was checked and attested. A gate contract put 60 tokens in. The vault lost 3 percent, and the subscriber was told within 3 minutes. Then the vault got a bug. 3 minutes 24 seconds later the money was out, and nobody holding the owner's key did anything. |
| 1:30 | Gate page `/watch/gate`, then Positions and Recent events | This is the gate. It deposits only while the latest attestation is compliant. When attestation 27 turned the vault non compliant, anyone could call exit, and a keeper bot did. 60 in, 58.2 back, the 3 percent loss included. |
| 1:45 | Inbox `/watch/inbox` with the testnet burner, Alerts | A subscriber sees the same events: share value fell 3 percent, then all passed to mismatch. A drop is only sent after it is seen again at a later block. |
| 1:58 | Webhook receiver `/watch/demo-hook` | The same alert goes to the subscriber's server as a webhook, so a bot can stop sending money to that vault. |
| 2:08 | Desk `/desk`, "Desk and subscriptions together" | Results are free and public. Money comes from alert subscriptions at 0.05 MON a day and from paid re-checks. Today the gas is larger than the revenue, so we are at minus 0.23 MON. Attestations are capped at 15 a day, so 15 subscription days cover the worst day. |
| 2:25 | Card: find, check, record, alert, block. Users: curators and allocator vaults, yield bots and AI agents, lending markets | Specfirst is an automatic inspection station and recall service for vaults. It finds them, checks them against public properties, records the result, alerts the holders and lets contracts act on it. |
| 2:45 | End | |

## What to have open before recording

- The web on the deployed host, or `pnpm --filter @specfirst/web dev -p 3417` with `NEXT_PUBLIC_SPECFIRST_DESK_10143` and `NEXT_PUBLIC_SPECFIRST_SUBS_10143` set.
- The inbox needs the testnet burner that holds subscription #2. Its key stays in the browser that made it; record from that browser profile.
- Nothing has to happen live. The timeline is on chain: deployment at block 68,922,607, allocation at 68,922,734, loss at 68,923,057, bug at 68,923,688, attestation #27 for the check of block 68,924,274, exit at 68,924,353.

## Rehearsing it live

To show it happen instead of replaying it, run the same steps against a fresh vault, each through `node --env-file=.env packages/cli/dist/index.js`. The watcher finds a new vault in about 20 seconds; confirming a share value fall or a changed result takes about 3 minutes each.

```
specfirst watch demo vault --network monad-testnet --asset $SPECFIRST_DEMO_TOKEN_10143
specfirst subs subscribe <vault> --subject-chain 10143 --days 1
specfirst watch demo gate allocate <vault> 60 --network monad-testnet
specfirst watch demo gate keep --network monad-testnet
specfirst watch demo loss <vault> 300 --network monad-testnet
specfirst watch demo set-broken <vault> on --network monad-testnet
```

`subs subscribe` defaults to chain 143; a testnet demo vault needs `--subject-chain 10143`, or the testnet watcher never sees the subscription.
