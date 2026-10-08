# Specfirst demo script, 3 minutes

No terminal on screen. Every page is the running web app, every number is real: the Upshift values were measured on a mainnet fork, the board and the watcher feed read mainnet, and the gate and alert scenes replay what happened on Monad testnet on October 7. Two recorded cuts with captions and no voice exist: `specfirst-demo-en.mp4` with English captions and `specfirst-demo-ko.mp4` with Korean captions, 3 minutes each. This file is the narration if a voiced cut is recorded.

| Time | Screen | Narration |
|---|---|---|
| 0:00 | Card: a bot asks a vault `maxWithdraw`, the vault says 801,365.61 AUSD, the bot withdraws 796,956.94 AUSD, the call fails with `WithdrawalRequestRequired` | A curator's bot asks a vault how much it can take out. The vault says 801 thousand. The bot asks for 797 thousand and the withdrawal fails. This is Upshift earnAUSD on Monad mainnet, measured on a fork. |
| 0:13 | Same card, footnote visible | The only way to know a vault answers wrong is to write tests for that vault. Monad has more than 400 of them, and new ones every day. |
| 0:20 | Vault page `/v/143/0xD793...dA5E`, verdict at the top | Open the same vault on Specfirst. It is already marked as a spec mismatch, and nobody asked for that check. |
| 0:28 | Same page, scrolled to "What failed" | The page says which sentence of EIP-4626 it breaks and shows the call. The same result is recorded on chain, and a contract reads it with one call, `isCompliant`. |
| 0:36 | Board `/`, then the findings section | 459 vaults on mainnet. 174 of them the watcher found on chain by itself. It found and checked hyAUSD, sLVMON, locked.aprMON and tyYIELD with no person involved, and attested three of them. A rounding issue is marked SHOULD, not MUST. |
| 0:52 | Watcher feed `/watch?chain=143` | Nobody registers a vault. A factory deployment, a first deposit or a proxy upgrade is enough for the watcher to check it. |
| 1:00 | Card: the testnet timeline of October 7 | A new vault was deployed. 18 seconds later it was checked and attested. A gate contract put 60 tokens in. The vault lost 3 percent, and the subscriber was told within 3 minutes. Then the vault got a bug. 3 minutes 24 seconds later the money was out, and nobody holding the owner's key did anything. |
| 1:13 | Gate page `/watch/gate`, then Positions and Recent events | The gate deposits only while the latest attestation is compliant. When attestation 27 turned the vault non compliant, anyone could call exit, and a keeper bot did. 60 in, 58.2 back, the 3 percent loss included. |
| 1:28 | Inbox `/watch/inbox` with the testnet burner, Alerts | A subscriber sees the same events: share value fell 3 percent, then all passed to mismatch. A drop is only sent after it is seen again at a later block. |
| 1:42 | Webhook receiver `/watch/demo-hook` | The same alert goes to the subscriber's server as a webhook, so a bot can stop sending money to that vault. |
| 1:52 | Card: a real Claude Code run with the Specfirst MCP server | AI agents use the same verdicts. Asked to put 50,000 into vault A or B, the agent called `check_before_moving_funds` four times, got refuse for A and proceed for B, and chose B, citing the failed withdrawal and attestation 15. |
| 2:12 | Desk `/desk`, "Desk and subscriptions together" | Results are free. Money comes from alert subscriptions at 0.05 MON a day and from paid re-checks. Today we are at minus 0.23 MON. Attestations are capped at 15 a day, so 15 subscription days cover the gas of the worst day. |
| 2:26 | Card: find, check, record, alert, block. Users: curators and allocator vaults, yield bots and AI agents, lending markets | Specfirst is an inspection station and recall service for vaults. It finds them, checks them against public properties, records the result, alerts the holders and lets contracts and agents act on it. |
| 3:00 | End | |

## What to have open before recording

- The web on the deployed host, or `pnpm --filter @specfirst/web dev -p 3417` with `NEXT_PUBLIC_SPECFIRST_DESK_10143` and `NEXT_PUBLIC_SPECFIRST_SUBS_10143` set.
- The inbox needs the testnet burner that holds subscription #2. Its key stays in the browser that made it; record from that browser profile.
- The agent scene is a card made from a real run: `claude -p` with `--mcp-config` pointing at `packages/mcp/dist/index.js` and `SPECFIRST_API_BASE` set to the web, allowed tools `mcp__specfirst` only. Its decisions were refuse, refuse, proceed, proceed for A deposit, A withdraw, B deposit, B withdraw.
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
