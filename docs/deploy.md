# Deploying Specfirst on one server

The live system is five processes and the files they share: the web reads what the watchers and the desk worker write (`.specfirst/watch/<chainId>/{feed.ndjson,status.json,vaults.json}`, `.specfirst/watch/webhooks.json`, `.specfirst/watch/demo-hook.json`, `.specfirst/worker/status.json` and the reports under `certs/checks/`). A host that runs only the web would show a watcher that never moves, so the hosted link has to be the whole system on one machine. `deploy/docker-compose.yml` runs it with Docker Compose; this file is the runbook.

| Service | What it runs | Signs with | Writes |
|---|---|---|---|
| `web` | `next start` of `packages/web`, built in the image | nothing | `.specfirst/watch/webhooks.json`, `demo-hook.json` |
| `caddy` | HTTPS for `DOMAIN`, proxy to `web:3000` | nothing | its certificates (volume `caddy-data`) |
| `watch-143` | `watch --subject-chain 143`, the Monad mainnet watcher | `WATCH_ISSUER_PRIVATE_KEY` | `.specfirst/watch/143/`, `certs/checks/143/` |
| `watch-10143` | `watch --subject-chain 10143 --sources examples/watch/sources-demo.json`, the testnet demo | `WATCH_DEMO_ISSUER_PRIVATE_KEY` | `.specfirst/watch/10143/`, `certs/checks/10143/` |
| `worker` | `worker`, the request desk | `ISSUER_PRIVATE_KEY` | `.specfirst/worker/`, `certs/checks/143/` |
| `gate-keeper` | `watch demo gate keep`, AllocationGate exits | `KEEPER_PRIVATE_KEY`, else `REQUESTER_PRIVATE_KEY` | nothing |

The commands and flags are the ones `.specfirst/logs/restart-services.sh` and `run-watch-143.sh` used on the Mac, with `--webhook-local-origin` changed (see Webhooks). `restart: unless-stopped` replaces the bash supervisor: Docker restarts a service that exits, and starts every service again after a reboot.

## Images

`deploy/Dockerfile` builds two images from the repository root:

- `specfirst-cli:local`: Node 25.4.0 and pnpm 10.28.1 (what the Mac runs; the repository pins only pnpm), git, and forge 1.5.1 from the Foundry release tarball, checked against the sha256 GitHub publishes. The build runs `forge build` in `packages/contracts` first, since the CLI and the web copy the CertificateRegistry ABI from its `out/`, then builds core and the CLI. solc 0.8.28 is fetched at build time. The a16z harness and forge-std are still cloned at their pinned commits by the first check, into the volume `standards-cache` (`~/.cache/specfirst`), which also holds the issuer locks.
- `specfirst-web:local`: `next build` with the board data built first (Board below), then `next start` on port 3000 with production dependencies only.

Neither image contains a key: `.dockerignore` leaves out every `.env` file, `.git` and the run state. The CLI services read their keys at run time from a compose secret, a file on the server mounted at `/run/secrets/specfirst_env` and loaded with `node --env-file`, so the keys do not appear in `docker inspect`. The web gets only the variables listed under `web.environment`: contract addresses and RPC URLs. It reads the `NEXT_PUBLIC_SPECFIRST_*_10143` addresses per request through a variable, not the literal `process.env.NEXT_PUBLIC_...` that Next inlines at build time, so they are runtime settings and need no build argument; a change needs `up -d web`, not a rebuild. The literal ones (`NEXT_PUBLIC_MONAD_RPC` in `lib/chain.ts`, `NEXT_PUBLIC_REGISTRY_10143`, `NEXT_PUBLIC_REPORT_BASE`) belong to the older certificate pages and are not set on the Mac either.

Both images run as the `node` user, uid 1000. The state directories on the server must be owned by uid 1000.

## Server

- 4 vCPU, 8 GB RAM, 80 GB SSD, Ubuntu 24.04 LTS, x86_64 (arm64 works too: the Dockerfile picks the forge build for the machine). The worker (16 fuzz runs per property) and both watchers can each run a forge check on a fork at the same time, and `next build` takes about 2 GB of memory while the web image builds. With 4 GB of RAM, add swap.
- Disk: the images take about 2 GB, the testnet demo watcher writes about 15 MB of reports a day, logs are capped at 100 MB per service.
- Open ports 22, 80 and 443. The web listens only on 127.0.0.1 of the host; the outside reaches it through Caddy.
- A domain name whose A record (and AAAA, if the server has IPv6) points at the server.

## From a blank Ubuntu box

Docker Engine and the compose plugin from Docker's repository:

```
sudo apt-get update && sudo apt-get install -y ca-certificates curl rsync git jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw enable
```

The code, at the commit the Mac runs (`git -C ~/Developer/Personal/specfirst-batch rev-parse HEAD`). The repository has no remote today; either push it and clone, or send a bundle from the Mac:

```
# on the Mac
git -C ~/Developer/Personal/specfirst-batch bundle create /tmp/specfirst.bundle main
scp /tmp/specfirst.bundle root@<server>:/tmp/
# on the server
sudo git clone -b main /tmp/specfirst.bundle /opt/specfirst
```

The keys: the Mac's `../specfirst/.env` becomes `/etc/specfirst/specfirst.env`, the same variable names (`.env.example` lists them). Only the CLI services read it.

```
# on the Mac
scp ~/Developer/Personal/specfirst/.env root@<server>:/tmp/specfirst.env
# on the server
sudo install -d -m 0755 /etc/specfirst
sudo install -m 0600 -o 1000 -g 1000 /tmp/specfirst.env /etc/specfirst/specfirst.env && sudo shred -u /tmp/specfirst.env
```

The compose settings, none of them a key:

```
cd /opt/specfirst
sudo cp deploy/.env.example deploy/.env
sudo grep -E '^(MONAD_TESTNET_RPC|MONAD_TESTNET_RPC_FALLBACKS|SPECFIRST_(ATTEST_REGISTRY|DESK|SUBS|DEMO_TOKEN|GATE)_10143)=' /etc/specfirst/specfirst.env
sudo nano deploy/.env    # DOMAIN, and the lines the grep printed in place of the empty ones
```

Keep `COMPOSE_PROFILES=https` for now: the signing services stay off until the Migration below says to start them.

The state directories, owned by the images' user:

```
sudo mkdir -p .specfirst/watch .specfirst/worker
sudo chown -R 1000:1000 .specfirst certs/checks
```

Copy the state from the Mac now (Migration, step 1), so the board the web image builds includes the Mac's reports, then build and start the web and Caddy:

```
sudo docker compose -f deploy/docker-compose.yml build
sudo docker compose -f deploy/docker-compose.yml up -d
```

Caddy gets a certificate for `DOMAIN` on its first start; the DNS record has to point at the server by then (`dig +short <DOMAIN>`). `sudo docker compose -f deploy/docker-compose.yml logs caddy` shows the ACME exchange.

## Migration from the Mac

The watchers and the worker keep their place in `state.json`, `status.json`, `vaults.json` and `feed.ndjson`; copying them lets the server continue where the Mac stopped instead of backfilling from scratch. The reports the Mac wrote under `certs/checks` are not in git, and the feed and the vault pages point at them.

**The rule: stop the Mac's signing services before the server's start.** Two processes signing with one key send transactions with the same nonces, so one of each pair fails or replaces the other, and two watchers on the same chain attest the same signal twice. The issuer locks in `~/.cache/specfirst/locks` and the `watch.lock` and `worker.lock` files only stop a second process on the same machine. The `signers` profile keeps the server's signers off until step 4.

1. First copy, while the Mac still runs. From the Mac (the trailing slashes matter; the lock files hold Mac pids and stay behind):

   ```
   cd ~/Developer/Personal/specfirst-batch
   rsync -az --exclude '*.lock' .specfirst/watch/ root@<server>:/opt/specfirst/.specfirst/watch/
   rsync -az --exclude '*.lock' .specfirst/worker/ root@<server>:/opt/specfirst/.specfirst/worker/
   rsync -az certs/checks/ root@<server>:/opt/specfirst/certs/checks/
   ssh root@<server> chown -R 1000:1000 /opt/specfirst/.specfirst /opt/specfirst/certs/checks
   ```

   Then build and start the web and Caddy as above, and check the site (Health checks). The pages show the Mac's data as of the copy, with the watchers behind the head, since nothing on the server advances them yet. Do not register a webhook on the server yet: step 3 overwrites `webhooks.json`.

2. Stop every signing service on the Mac, the supervisor first (it would restart the mainnet watcher 30 seconds later), and check that none is left:

   ```
   pkill -f run-watch-143.sh
   pkill -f "index.js --json watch"     # both watchers and the gate keeper
   pkill -f "index.js --json worker"
   ps -axo pid,command | grep -E "index.js --json|run-watch-143" | grep -v grep    # must print nothing
   pkill -f "next dev -p 3417"          # the Mac web, so nobody reads the stale copy
   mv .specfirst/logs/restart-services.sh .specfirst/logs/restart-services.sh.disabled
   ```

   The last line keeps a habit from starting the Mac signers again later.

3. Final copy: the three `rsync` commands and the `chown` of step 1 again. They send only what changed since.

4. Start the signers on the server. In `deploy/.env` set `COMPOSE_PROFILES=https,signers` (so later `up` commands and reboots keep them), then:

   ```
   sudo docker compose -f deploy/docker-compose.yml up -d
   sudo docker compose -f deploy/docker-compose.yml logs --tail 20 watch-143 watch-10143 worker gate-keeper
   ```

   The mainnet watcher should report its cursor from the copied `state.json`, not a backfill from the current head, and the feed on `/watch?chain=143` should continue the Mac's sequence numbers.

5. Move the demo subscriber and re-register its webhook (Webhooks below).

Lock files hold a pid and a lock whose pid is gone is taken over. Under `init: true` each CLI process runs under Docker's init with the same pid after every restart, so a restarted service takes its own stale lock back; the Mac's pids would not be alive on the server either, but step 1 leaves them behind anyway.

### Rollback

Stop the server's signers first (`sudo docker compose -f deploy/docker-compose.yml stop watch-143 watch-10143 worker gate-keeper` and remove `signers` from `COMPOSE_PROFILES`), copy the three directories back with the same `rsync` commands in the other direction, then run `restart-services.sh` on the Mac. A watcher of older code cannot read a `vaults.json` written by newer code (`lastCheck.reportHash`), so the Mac must run the same commit as the server, or a newer one. With both on the same commit this does not arise.

## Webhooks

`/watch/inbox` offers the demo receiver at `${window.location.origin}/api/v1/watch/demo-hook`, which on the server is `https://<DOMAIN>/api/v1/watch/demo-hook`. The web accepts it like any webhook: https, a public host name. `SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS` stays unset; it exists for a local http origin such as `http://localhost:3417` on a laptop.

Delivery: before each POST the watcher resolves the host and refuses one that resolves to a private address, except for the exact origins given with `--webhook-local-origin`. Both watchers here get `--webhook-local-origin https://<DOMAIN>` (`PUBLIC_ORIGIN` in `deploy/.env` overrides it), and Caddy carries `DOMAIN` as an alias on the compose network. So a watcher reaches the site's own receiver inside the host, through Caddy with its real certificate, without depending on the host's NAT sending its own public address back in. The exception covers that one origin only; every other webhook still has to resolve to a public address. Without Caddy (TLS elsewhere), `DOMAIN` resolves through public DNS and delivery leaves the host and comes back.

The registration on the Mac does not carry over by editing the file. `webhooks.json` holds `http://localhost:3417/api/v1/watch/demo-hook`, signed by the subscriber over that exact URL, and the watcher checks the signature again before every delivery, so a rewritten URL fails as `signature`. Left as it is, each alert to it is recorded as a failed `alerted` event ("webhook registration refused: url"), since nothing on the server is allowed to deliver to `http://localhost:3417`. Register again on the server; the newest registration of a subscriber replaces the old one:

1. The demo subscriber is the testnet burner kept in the browser's `localStorage` for the origin it was made on (`http://localhost:3417`), key `specfirst:burner:v1`. In the browser profile that made it, open `http://localhost:3417` (step 2 of the Migration stopped the Mac web; start it again for a minute, or read the key from the browser's site data), and in the developer console run `copy(localStorage.getItem('specfirst:burner:v1'))`. On `https://<DOMAIN>`, run `localStorage.setItem('specfirst:burner:v1', '<pasted value>')` and reload. It is a testnet key, kept the same way the site always keeps it.
2. On `https://<DOMAIN>/watch/inbox`, register the demo URL the page shows. It is one signature and no transaction; the subscriber must hold an active subscription.
3. The next alert for a subscribed vault appears on `/watch/demo-hook` and as an `alerted` event with `ok: true` in the feed.

## Board

`/` is prerendered at `next build` from `packages/web/data/board.json`, which the web image builds from the reports in the checkout's `certs/checks/143` (the Mac's included, after the copy) and a read of CheckAttestationRegistry through `SPECFIRST_BOARD_RPC` (default `https://rpc.ankr.com/monad_testnet`; the public testnet RPC allows 15 requests per second). A failed registry read does not fail the build; the board says so. The rest reads current files per request: vault pages prefer a report newer than the board, the desk and watch pages read the watcher and the worker, and the board's table adds the vaults the watcher found when the page loads.

Rebuilding `board.json` inside a running container would change the vault pages but not `/`, so there is no periodic job. To bring `/` up to date (counts, the attested column), rebuild the web image; the CLI services keep running and the web is down for the seconds of its restart:

```
cd /opt/specfirst && sudo docker compose -f deploy/docker-compose.yml up -d --build web
```

`.dockerignore` leaves `certs/checks/10143` out of the build context: the demo reports are not board material and grow by the hour.

## Health checks

```
cd /opt/specfirst
sudo docker compose -f deploy/docker-compose.yml ps                      # web healthy, the others running
for p in / '/watch?chain=143' /watch/gate /watch/inbox /desk; do
  printf '%s %s\n' "$(curl -s -o /dev/null -w '%{http_code}' "https://<DOMAIN>$p")" "$p"
done
curl -s 'https://<DOMAIN>/api/v1/watch/status?chainId=143' | jq '{running, stale, updatedAgoSec, behindBlocks, problem}'
curl -s 'https://<DOMAIN>/api/v1/watch/feed?chainId=143&limit=3' | jq '.events[0]'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/about       # the web without Caddy
sudo docker compose -f deploy/docker-compose.yml logs --tail 50 watch-143   # NDJSON events, what watch-143.ndjson held on the Mac
jq -r .updatedAt .specfirst/watch/143/status.json .specfirst/watch/10143/status.json
```

`stale: true` or an `updatedAt` minutes old means a watcher stopped; `docker compose ps` shows whether it is restarting, and its logs say why. Each service's stdout (the NDJSON the Mac appended to `.specfirst/logs/*.ndjson`) is in `docker compose logs`, rotated at 20 MB, five files.

## Updating

```
cd /opt/specfirst && sudo git pull     # or: git pull /tmp/specfirst.bundle main
sudo docker compose -f deploy/docker-compose.yml up -d --build
```

This rebuilds both images (the web with a fresh board) and recreates the services whose image changed.

## Notes

- forge's version string goes into every report (`toolchain.forgeVersion`) and from there into the attestation's suite. The Mac's Homebrew forge says `forge Version: 1.5.1-Homebrew`, the release build another suffix, so attestations made on the server carry another suiteHash than the Mac's for the same check. The AllocationGate on testnet pins no suite (`suiteHash()` is zero), so its verdicts are unaffected; a gate that pins one would treat the server's attestations as another suite.
- Node 25 left support in June 2026. The images use 25.4.0 because the live services ran on it; `NODE_VERSION` at the top of `deploy/Dockerfile` switches to 24 (LTS) once that is tested.
- `git pull` refuses to overwrite an untracked file, as on the Mac: a report the server wrote under `certs/checks` that is later committed from elsewhere has to be moved aside first.
