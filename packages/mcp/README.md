# @specfirst/mcp

An MCP server that lets an AI agent ask Specfirst about an ERC-4626 vault on Monad before it moves money. Yield bots and agents size deposits and withdrawals from `maxWithdraw` and the previews; this server tells them when a check showed those answers are wrong, and says refuse, caution or proceed for the action they are about to take.

It reads two things: the Specfirst web API (the latest check report of a vault and the watcher's feed) and `CheckAttestationRegistry` on Monad testnet, which it reads itself over RPC, so an agent's yes or no does not rest only on our server. It holds no key, never signs and never sends a transaction. ADR 0008 (`docs/adr/0008-mcp-server.md`) has the decisions behind it.

MIT. Built on the official MCP TypeScript SDK, v2 (`@modelcontextprotocol/server` 2.3), served over stdio, which is what Claude Code and Claude Desktop launch. Clients that still speak the 2025 protocol revisions are served too (`serveStdio` picks the era from the client's first message).

## Setup

From the repository root (Node 20 or later):

```
pnpm install
(cd packages/contracts && forge build)          # only when packages/contracts/out is missing
pnpm --filter @specfirst/core build
pnpm --filter @specfirst/mcp build              # packages/mcp/dist/index.js, the specfirst-mcp bin
```

### Claude Code

```
claude mcp add specfirst \
  -e SPECFIRST_API_BASE=http://localhost:3417 \
  -e MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz \
  -- node "$PWD/packages/mcp/dist/index.js"
```

Add `--scope user` to have it in every project. `claude mcp list` should show it connected; the four tools appear as `mcp__specfirst__vault_verdict` and so on.

### Claude Desktop

In `claude_desktop_config.json` (Settings, Developer, Edit Config), with the absolute path of your checkout:

```json
{
  "mcpServers": {
    "specfirst": {
      "command": "node",
      "args": ["/absolute/path/to/specfirst/packages/mcp/dist/index.js"],
      "env": {
        "SPECFIRST_API_BASE": "http://localhost:3417",
        "MONAD_TESTNET_RPC": "https://testnet-rpc.monad.xyz"
      }
    }
  }
}
```

Restart Claude Desktop after editing it.

### Environment

None of these is a key; the server reads no key at all.

| Variable | Default | Meaning |
|---|---|---|
| `SPECFIRST_API_BASE` | `http://localhost:3417` | The Specfirst web. Point it at the deployed host once there is one. An origin: https, or plain http on this machine only; no path, credentials, query or fragment. |
| `MONAD_TESTNET_RPC` | `https://testnet-rpc.monad.xyz` | RPC for the registry and subscription reads. Its `eth_chainId` must be 10143, or the reads are refused. A provider key in its path or query is kept; only its origin ever appears in a result. |
| `SPECFIRST_ATTEST_REGISTRY_10143` | `0x3754918bBB8481D046D80718a9efe434e353daF7` | CheckAttestationRegistry. |
| `SPECFIRST_SUBS_10143` | `0xA1A205C1eF2Ecd2354DE900276C74Fb34b7119a4` | CheckSubscriptions. |
| `SPECFIRST_MCP_STALE_HOURS` | `48` | A check older than this is stale (twice the watcher's 24 hour sweep). |
| `SPECFIRST_MCP_TIMEOUT_MS` | `10000` | Per request, API and RPC alike. The registry read gets twice this in all, so an answer comes back well inside a host's tool timeout. |

### Try it without a host

`scripts/call.mjs` spawns the built server over stdio with the SDK client, as a host does, and prints one tool's text:

```
node packages/mcp/scripts/call.mjs --list
node packages/mcp/scripts/call.mjs check_before_moving_funds '{"address":"0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E","action":"withdraw"}'
node packages/mcp/scripts/call.mjs vault_verdict '{"address":"0x802c91d807a8daca257c4708ab264b6520964e44"}' --json
```

## Tools

All four are read only (`readOnlyHint`). Each result is a short text an LLM can quote, the same result as JSON in a second text block, and `structuredContent` that matches the tool's `outputSchema`. Addresses may be all lower case, all upper case or EIP-55 checksummed; a mixed-case address with a wrong checksum is refused as a likely typo, and results always carry the checksummed form. `chainId` defaults to 143, Monad mainnet.

| Tool | Input | What it answers |
|---|---|---|
| `check_before_moving_funds` | `address`, `chainId?`, `action`: `deposit`, `mint`, `withdraw` or `redeem`, `amount?` (an integer in base units) | `decision`: `refuse`, `caution` or `proceed`, with `reasons` (a code, its effect and a sentence each), `sizing` (which max function not to size from, and why), the basis of the decision and what a result means. |
| `vault_verdict` | `address`, `chainId?` | `status` (all-passed, mismatch, partly-checked, not-applicable, unchecked, unknown), `level` (must, rounding, should, none), each failed property with its EIP-4626 sentence, a plain explanation, the concrete call and the actions it concerns, the properties not judged, traits such as asynchronous redemption, the block checked and its age, the report (`verified`: the file hashes to the reportHash the API names and is about this vault and block; `matchesApiSummary`; `coversAllProperties`; `fullStrength`: the pinned suite with at least 16 fuzz runs and delta 0; the replay command built from the file), and the latest attestation read on chain: id, status, isCompliant, issuedAt, issuer and whether it is still one, the failed properties in its bitmap, whether it attests the shown report (`matchesReport`), the same implementation, an earlier or a later block. |
| `recent_findings` | `chainId?`, `limit?` (1 to 50, default 10) | What the watcher found by itself: result changes (regressed, recovered, changed, implementation, a first check that found a mismatch) and confirmed falls of share value, newest first, and the vaults whose latest check is a mismatch, read from the last 1,000 events of its feed at most, within three request timeouts. Events not in the expected shape are left out and counted. |
| `how_to_watch` | `address`, `chainId?` | How to be alerted: CheckSubscriptions on Monad testnet with its fee per day read on chain, the `subscribe` call and its arguments for this vault, the web inbox, the webhook message to sign, its payload fields, kinds (`first-check`, `change`, `price-drop`) and idempotency key. Informational only. |

An address Specfirst never checked is an answer, not an error: `vault_verdict` says `unchecked`, what the watcher knows about it, and links the request desk (`/check?vault=<address>`), where a paid request checks it now.

## Decision rules

The rule of thumb: refuse needs evidence of a MUST mismatch that concerns the action, proceed needs evidence that everything passed and is attested, and everything in between, including anything that could not be read, is caution. A source that is down never turns into proceed.

Which properties concern which action: `asset`, `totalAssets`, `convertToShares` and `convertToAssets` concern every action; each entry point concerns itself (`deposit` concerns maxDeposit, previewDeposit, deposit and sf-maxDeposit-honored; mint, withdraw and redeem likewise). Money that goes in has to come out, so for deposit and mint the exits count too once both withdraw and redeem fail a MUST; with only one of them broken the money can still come out through the other, which is a caution. An id outside the table concerns everything.

**refuse** when either holds:
- `must-failure-on-action`: the latest report has a failed EIP-4626 MUST property that concerns the action. For Upshift earnAUSD a withdraw is refused on `sf-maxWithdraw-honored` (maxWithdraw returned the whole balance, withdraw of that amount reverted with `WithdrawalRequestRequired()`), and so is a deposit, since redeem fails too.
- `registry-must-failure-on-action`: the registry's latest attestation, read on chain, is Valid, not compliant, about the same implementation as the latest report, and its failedBitmap has a MUST property of the 30-property table that concerns the action, even when a newer report on the server passes: that report is not attested, so the on-chain answer stands until a newer check is.

**caution** when there is no refusal and any of these holds:
- `must-failure-elsewhere`: a MUST failed that does not concern this action (a deposit hook, when you want to withdraw).
- `one-exit-broken`: for deposit and mint, withdraw or redeem fails a MUST but the other does not.
- `rounding-only`: only round trips failed, each by at most max(2 base units, 1 bp of the amount) in the caller's favor, which EIP-4626 only says SHOULD not happen (tyYIELD).
- `should-only`: only SHOULD properties failed (zero-allowance checks, or a round trip off by more than rounding, or by an amount the report does not give).
- `not-judged`, `not-applicable`: inconclusive or not applicable properties; an unjudged property is never a pass.
- `unchecked`: Specfirst never checked the vault.
- `api-unavailable`, `report-unverified`: the Specfirst API could not be read or answered something unusable, or the report file could not be read, does not hash to the reportHash the API names, is about another vault or block, disagrees with the API's summary (the file is used) or does not cover the 30 properties. With the API down the decision rests on a Valid attestation alone, which can still refuse.
- `weaker-check`: the latest check ran with fewer than 16 fuzz runs a property, a tolerance (delta above 0), another upstream commit, or a suite hash other than the one the API names; its pass is weaker than this server vouches for.
- `stale-result`: the latest check is older than `SPECFIRST_MCP_STALE_HOURS`, or its time is unknown or in the future.
- `async-redeem`: exits go through a request (ERC-7540 style), so withdraw and redeem can revert until a request is claimable.
- `no-attestation`, `attestation-revoked`, `registry-not-compliant`, `registry-unread`: nothing on chain backs the result, the latest attestation was revoked, it is not compliant without a MUST that concerns the action (or with bits outside the 30-property table), or the registry could not be read.
- `issuer-removed`, `issuer-unread`, `other-implementation`, `implementation-unknown`: the attesting issuer is no longer an issuer or that could not be read, or the attestation is about another implementation than the latest report (an upgrade since; its failures then do not refuse) or that could not be shown.

**proceed** only when all of these hold: the report file hashes to the reportHash the API names, is about this vault and block, agrees with the API's summary and has exactly the 30 properties of a published table, all passed; it ran at full strength (the pinned suite, at least 16 fuzz runs, delta 0, and the suite hash the API names); it is not stale; the registry was read and its latest attestation is Valid, `isCompliant`, with 30 passes and nothing else in its counts and bitmap and a readable time; its issuer is read and still an issuer; and it is about the same implementation as the report. The attestation may be of an earlier check with the same outcome, since the watcher does not re-attest an unchanged result; the reasons then say so. Any caution above blocks proceed.

`sizing` lists, for every failed `sf-max*-honored` property, the max function not to size from, with the call that showed it ("Do not size withdrawals from maxWithdraw: maxWithdraw returned 609,877,786,697, then withdraw(609,877,786,695) reverted with 0x75ed2e3e, WithdrawalRequestRequired() at block 111224893."), and for an asynchronous vault, to plan exits as a request and a later claim.

The `amount` is echoed back and does not change the decision: a check tries amounts up to the vault's own max values for its test users at one block, not the agent's amount for the agent's account.

## What a result means, and the trust model

- **Pass** means no counterexample to these 30 properties was found at that block, with 16 fuzz runs a property. It is not a safety guarantee or an audit. Every proceed says so.
- **Mismatch** is a disagreement with a sentence of EIP-4626, shown by a concrete call on a fork of that block. It is not a claim that funds are at risk or were lost.
- **Two sources, read separately.** The report comes from the Specfirst web; the attestation comes from CheckAttestationRegistry on Monad testnet, read by this process over `MONAD_TESTNET_RPC` (after checking the RPC is chain 10143). The report file is held to core's report schema, and its keccak256 over its canonical JSON (ADR 0004) is computed here and compared with the reportHash the API names and with the attested one. The verdict then rests on the file's own results, not on the API's summary of them, so a summary that does not match its file is caught and an attestation of another report is shown as such. What this cannot catch is a server that serves an older report than its latest one; the registry read narrows that for attested vaults.
- **Links stay home.** A link the API returns is followed only as a path on `SPECFIRST_API_BASE`, after checking the result has the same origin, and CCIP-Read is off in the RPC client, so neither source can make this process fetch another host.
- **Quoted text.** Vault names, symbols and revert texts come from the vault and its deployer. They are cleaned to one bounded line (control, zero-width and bidi characters removed) and JSON-quoted, feed fields are held to their shapes (change kinds, decimal blocks and amounts, property ids), and the server's instructions tell the agent to act on the `decision` and the reason codes.
- **Always an answer.** An answer of either source that this code cannot use counts as an unreadable source, and `check_before_moving_funds` answers caution rather than a tool error for anything past the input. The registry read and the feed each have one overall deadline, so an answer comes back well inside a host's tool timeout.
- **What the registry adds**, and what it does not, is in ADR 0004: an issuer's signature over the hashes, a time and a revocation path. A reader of the registry trusts its issuers, nothing more; `issuerCurrent` says whether the attesting issuer still is one.
- **No keys.** The server reads no private key, builds no wallet, and sends only GET requests to the API and `eth_chainId` and `eth_call` to the RPC. `test/no-keys.test.ts` checks the source; the end to end test checks the traffic.

## Tests

`pnpm --filter @specfirst/mcp test` builds the server and runs vitest: the decision rules on fixtures captured from the live web and registry for Upshift earnAUSD (MUST), tyYIELD (rounding) and a MetaMorpho vault (all passed) and on variations of them (should, partly checked, not applicable, a MUST on one side only, one exit or both exits broken, a non-compliant attestation behind a passing report, a bit outside the table, revoked, removed or unread issuer, upgraded implementation, a file that disagrees with its API summary or is about another vault, a future check time, stale, a vault name with a line break, unknown vault, API down, RPC down, both down; no variation with a source down ever proceeds); the level classification run against the board's own `packages/web/lib/board/levels.ts`; the API client and the chain reader against local mocks (timeouts, HTTP errors, a body over 4 MiB, links off the configured host, an RPC of the wrong chain, an OffchainLookup revert that must not be followed); the watcher feed reading; and an end to end test that spawns `dist/index.js` over stdio with the SDK client against a mocked API and RPC.
