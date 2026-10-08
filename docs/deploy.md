# Deploying Specfirst on one server

The live system is five processes and the files they share: the web reads what the watchers and the desk worker write (`.specfirst/watch/<chainId>/{feed.ndjson,status.json,vaults.json}`, `.specfirst/watch/webhooks.json`, `.specfirst/watch/demo-hook.json`, `.specfirst/worker/status.json` and the reports under `certs/checks/`). A host that runs only the web would show a watcher that never moves, so the hosted link has to be the whole system on one machine. `deploy/docker-compose.yml` runs it with Docker Compose; this file is the runbook.

| Service | What it runs | Signs with | Writes | Restarts |
|---|---|---|---|---|
| `web` | `next start` of `packages/web`, built in the image | nothing | `.specfirst/watch/webhooks.json`, `demo-hook.json` | with Docker, after reboots too |
| `caddy` | HTTPS for `DOMAIN`, proxy to `web:3000` | nothing | its certificates (volume `caddy-data`) | with Docker, after reboots too |
| `watch-143` | `watch --subject-chain 143`, the Monad mainnet watcher | `WATCH_ISSUER_PRIVATE_KEY` | `.specfirst/watch/143/`, `certs/checks/143/` | 30 s after a crash; never by itself after a reboot |
| `watch-10143` | `watch --subject-chain 10143 --sources examples/watch/sources-demo.json`, the testnet demo | `WATCH_DEMO_ISSUER_PRIVATE_KEY` | `.specfirst/watch/10143/`, `certs/checks/10143/` | same |
| `worker` | `worker`, the request desk | `ISSUER_PRIVATE_KEY` | `.specfirst/worker/`, `certs/checks/143/` | same |
| `gate-keeper` | `watch demo gate keep`, AllocationGate exits | `KEEPER_PRIVATE_KEY`, else `REQUESTER_PRIVATE_KEY` | nothing | same |

The commands and flags are the ones the Mac runs (`.specfirst/logs/restart-services.sh`, `run-watch-143.sh`, `run-watch-10143.sh`), with `--webhook-local-origin` changed (see Webhooks).

The four signers have `restart: "no"` and run under `specfirst-supervise` (`deploy/supervise.sh`), which does what the Mac's `run-watch-*.sh` loops do: it starts the command again 30 seconds after it exits and logs a `supervisor-restart` line. So a crash heals itself, but a server that reboots, or comes back after an outage, starts no signer until someone runs `docker compose up -d` again. That is deliberate: if the owner moved the signers back to the Mac while the server was down, the server must not resume signing with the same keys when it returns. After a planned reboot, check that nothing else signs with these keys, then start them (Migration, step 4).

## Images

`deploy/Dockerfile` builds two images from the repository root, sharing the stages that install and build:

- `specfirst-cli:local`: Node 25.4.0, the version the Mac's services run on, so the signers behave as they did there; pnpm 10.28.1 (`packageManager`), git, and forge 1.5.1 from the Foundry release tarball, checked against the sha256 GitHub publishes. The build runs `forge build` in `packages/contracts` first, since the CLI and the web copy the CertificateRegistry ABI from its `out/`, then builds core and the CLI. solc 0.8.28 is fetched at build time. The a16z harness and forge-std are cloned at their pinned commits by the first check, into the volume `standards-cache` (`~/.cache/specfirst`), which also holds the issuer locks.
- `specfirst-web:local`: `next build` with the board data built first (Board below), then `next start` on port 3000 under Node 24.21.0 (LTS), production dependencies only. The web is the part the internet talks to, so it runs on a supported Node; `build-board.mjs` and `next start` were tested on 24.

Neither image contains a key: `.dockerignore` leaves out every `.env` file, `.git` and the run state. The signers read their keys at run time from a compose secret, a file on the server mounted at `/run/secrets/specfirst_env` and loaded with `node --env-file`, so the keys do not appear in `docker inspect`. The web gets only what it reads: the three `NEXT_PUBLIC_SPECFIRST_*_10143` addresses, its public origin and the local webhook switch. It reads the addresses per request through a variable, not the literal `process.env.NEXT_PUBLIC_...` that Next inlines at build time, so they are runtime settings; a change needs `up -d web`, not a rebuild. The literal ones (`NEXT_PUBLIC_MONAD_RPC` in `lib/chain.ts`, `NEXT_PUBLIC_REGISTRY_10143`, `NEXT_PUBLIC_REPORT_BASE`) belong to the older certificate pages and are not set on the Mac either. `SPECFIRST_PUBLIC_ORIGIN` is there because `next start` builds `request.url` from its own `http://localhost:3000`, which the absolute links of `/api/v1/vaults` would otherwise name.

Both images run as the `node` user, uid 1000. The checkout's state directories on the server must be owned by uid 1000.

## Server

- 4 vCPU, 8 GB RAM, 80 GB SSD, Ubuntu 24.04 LTS, x86_64 (arm64 works too: the Dockerfile picks the forge build for the machine). The worker (16 fuzz runs per property) and both watchers can each run a forge check on a fork at the same time, and `next build` takes about 2 GB of memory while the web image builds. With 4 GB of RAM, add swap.
- Disk: the images take about 2 GB and every rebuild leaves build cache behind (Board shows the prune), the testnet demo watcher writes about 15 MB of reports a day, logs are capped at 100 MB per service.
- Open ports 22, 80 and 443. The web listens only on 127.0.0.1 of the host; the outside reaches it through Caddy.
- A domain name whose A record (and AAAA, if the server has IPv6) points at the server.
- A login user with sudo, not root. On Ubuntu cloud images the default user (`ubuntu`) has uid 1000, the uid of the images' `node` user, so files it writes in the checkout are already the containers' (`id -u` to check). With another uid, run the `chown` lines below after anything that writes there.

## From a blank Ubuntu box

Docker Engine and the compose plugin from Docker's repository, and the firewall:

```
sudo apt-get update && sudo apt-get install -y ca-certificates curl rsync git jq
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw --force enable
```

Ports Docker publishes bypass ufw; that is why the web is bound to 127.0.0.1 and only Caddy's 80 and 443 are public.

The code. The repository has no remote today, so either push it and clone, or send a bundle. Merge `feat/deploy` into `main` first (the bundle below carries `main`), and use the commit the Mac runs, so the server and the Mac read each other's state files (Rollback):

```
# on the Mac
git -C ~/Developer/Personal/specfirst-batch bundle create /tmp/specfirst.bundle main
scp /tmp/specfirst.bundle <user>@<server>:/tmp/
# on the server, as the login user
sudo install -d -o "$USER" -g "$USER" /opt/specfirst
git clone -b main /tmp/specfirst.bundle /opt/specfirst
```

The keys. `/etc/specfirst/specfirst.env` holds only what the four signers read (`deploy/server.env.example`): their four keys, the contract addresses and the RPCs. `DEPLOYER_PRIVATE_KEY`, the owner of every contract, stays on the Mac. Send those lines straight from the Mac's `.env` into the file, without a copy in `/tmp`:

```
# on the Mac
grep -E '^(MONAD_TESTNET_RPC|MONAD_TESTNET_RPC_FALLBACKS|SPECFIRST_(ATTEST_REGISTRY|DESK|SUBS|DEMO_TOKEN|GATE)_10143|WATCH_ISSUER_PRIVATE_KEY|WATCH_DEMO_ISSUER_PRIVATE_KEY|ISSUER_PRIVATE_KEY|KEEPER_PRIVATE_KEY|REQUESTER_PRIVATE_KEY)=' ~/Developer/Personal/specfirst/.env \
  | ssh <user>@<server> 'sudo install -d -m 0755 /etc/specfirst && sudo sh -c "umask 077; cat > /etc/specfirst/specfirst.env" && sudo chown 1000:1000 /etc/specfirst/specfirst.env'
# on the server: names only, and no deployer key
sudo cut -d= -f1 /etc/specfirst/specfirst.env
sudo grep -c '^DEPLOYER' /etc/specfirst/specfirst.env    # 0
```

`sudo` here must not ask for a password (cloud images set it up that way); otherwise log in once and paste the lines into `sudo nano` with `umask 077`. The Mac has no `KEEPER_PRIVATE_KEY`, so the keeper signs with `REQUESTER_PRIVATE_KEY`, the key `desk request` and `subs subscribe` also pay from. A key of its own for the keeper keeps those apart: make one, fund it with testnet MON and add `KEEPER_PRIVATE_KEY=` to the file.

The compose settings, none of them a key:

```
cd /opt/specfirst
cp deploy/.env.example deploy/.env
nano deploy/.env    # DOMAIN (lowercase), and SPECFIRST_DESK_10143, SPECFIRST_SUBS_10143, SPECFIRST_GATE_10143 from the key file
```

Keep `COMPOSE_PROFILES=https` for now: the signing services stay off until the Migration below says to start them. Leave `PUBLIC_ORIGIN` unset; it defaults to `https://<DOMAIN>`. If it is set, it must be exactly `scheme://host[:port]`, lowercase, without a trailing slash, or the watchers refuse to start.

The state directories, owned by uid 1000:

```
mkdir -p .specfirst/watch .specfirst/worker
sudo chown -R 1000:1000 .specfirst certs/checks
```

Copy the state from the Mac now (Migration, step 1), so the board the web image builds includes the Mac's reports, then build both images (`--profile signers` builds the CLI image now, so the cutover does not wait for it) and start the web and Caddy:

```
sudo docker compose -f deploy/docker-compose.yml --profile signers build
sudo docker compose -f deploy/docker-compose.yml up -d
```

Caddy gets a certificate for `DOMAIN` on its first start; the DNS record has to point at the server by then (`dig +short <DOMAIN>`). `sudo docker compose -f deploy/docker-compose.yml logs caddy` shows the ACME exchange.

## Migration from the Mac

The watchers and the worker keep their place in `state.json`, `status.json`, `vaults.json` and `feed.ndjson`; copying them lets the server continue where the Mac stopped instead of backfilling from scratch. The reports the Mac wrote under `certs/checks` are not in git, and the feed and the vault pages point at them.

**The rule: stop the Mac's signing services before the server's start, and never let both sign.** Two processes signing with one key send transactions with the same nonces, so one of each pair fails or replaces the other, and two watchers on the same chain attest the same signal twice. The issuer locks in `~/.cache/specfirst/locks` and the `watch.lock` and `worker.lock` files only stop a second process on the same machine. The `signers` profile keeps the server's signers off until step 4.

1. First copy, while the Mac still runs. From the Mac (the trailing slashes matter; the lock files hold Mac pids and stay behind):

   ```
   cd ~/Developer/Personal/specfirst-batch
   rsync -az --exclude '*.lock' .specfirst/watch/ <user>@<server>:/opt/specfirst/.specfirst/watch/
   rsync -az --exclude '*.lock' .specfirst/worker/ <user>@<server>:/opt/specfirst/.specfirst/worker/
   rsync -az certs/checks/ <user>@<server>:/opt/specfirst/certs/checks/
   ssh <user>@<server> sudo chown -R 1000:1000 /opt/specfirst/.specfirst /opt/specfirst/certs/checks
   ```

   Then build and start the web and Caddy as above, and check the site (Health checks). The pages show the Mac's data as of the copy, with the watchers behind the head, since nothing on the server advances them yet. Do not register a webhook on the server yet: step 3 overwrites `webhooks.json`.

2. Stop every signing process on the Mac, the supervisors first (they restart their watcher 30 seconds later), and check that none is left:

   ```
   pkill -f "run-watch-"                       # run-watch-143.sh and run-watch-10143.sh
   pkill -f "packages/cli/dist/index.js"       # both watchers, the worker, the gate keeper, any one-off command
   pgrep -fl "run-watch-|packages/cli/dist/index.js"    # must print nothing
   pkill -f "next dev -p 3417"                 # the Mac web, so nobody reads the stale copy
   mv .specfirst/logs/restart-services.sh .specfirst/logs/restart-services.sh.disabled
   ```

   `restart-services.sh` starts the signers again; renaming it keeps a habit from doing that. `restart-web.sh` starts only the web and is harmless. From now on the Mac's `.env` must not sign with the four keys the server holds: no `worker`, `watch`, `watch demo gate keep`, `cert attest` (`ISSUER_PRIVATE_KEY`), and no `desk request` or `subs subscribe` while the keeper signs with `REQUESTER_PRIVATE_KEY`. Commands that sign with `DEPLOYER_PRIVATE_KEY` (`watch demo vault`, `watch demo loss`, `watch demo set-broken`, `watch demo gate allocate`) stay on the Mac and are safe.

3. Final copy: the three `rsync` commands and the `chown` of step 1 again. They send only what changed since.

4. Start the signers on the server. In `deploy/.env` set `COMPOSE_PROFILES=https,signers` (so later `up` commands keep them), then:

   ```
   sudo docker compose -f deploy/docker-compose.yml up -d
   sudo docker compose -f deploy/docker-compose.yml logs --tail 20 watch-143 watch-10143 worker gate-keeper
   ```

   The mainnet watcher should report its cursor from the copied `state.json`, not a backfill from the current head, and the feed on `/watch?chain=143` should continue the Mac's sequence numbers.

5. Move the demo subscriber and register its webhook again (Webhooks below).

### One-off commands on the server

Never `docker compose run` a signing service. Its pid locks cannot see another container: a process gets the same small pid in every container (`init: true`), so the lock left by a running watcher looks like the new container's own and is taken over, and two processes sign with one key. For a command inside a running service, use `exec`, which shares that container's processes, so the locks work as on the Mac:

```
sudo docker compose -f deploy/docker-compose.yml exec watch-143 node --env-file=/run/secrets/specfirst_env /app/packages/cli/dist/index.js <command>
```

Commands that only read need no key at all: `sudo docker run --rm specfirst-cli:local <command>`. Commands that sign with `DEPLOYER_PRIVATE_KEY` run on the Mac.

A restarted service takes its own stale lock back for the same reason (same pid), and the supervisor's restarts give the new process a new pid while the old one is gone. Recording the host name next to the pid would not help either: a container's host name changes whenever it is recreated, so such a lock would block the service itself. The rule above is the protection, together with one key per signer.

### Rollback

1. Make sure the server signs nothing, before anything starts on the Mac: `sudo docker compose -f deploy/docker-compose.yml rm -sf watch-143 watch-10143 worker gate-keeper`, and remove `signers` from `COMPOSE_PROFILES` in `deploy/.env`. If the server cannot be reached, power it off or detach its public IP in the provider's console first. When it comes back, its signers stay stopped (`restart: "no"`); remove them before anything runs `up -d` there.
2. Copy the three directories back with the same `rsync` commands in the other direction (`rsync -az --exclude '*.lock' <user>@<server>:/opt/specfirst/.specfirst/watch/ .specfirst/watch/`, and so on).
3. Rename `restart-services.sh.disabled` back and run it on the Mac.

A watcher of older code cannot read a `vaults.json` written by newer code (`lastCheck.reportHash`), so the Mac must run the same commit as the server, or a newer one. With both on the same commit this does not arise.

## Webhooks

`/watch/inbox` offers the demo receiver at `${window.location.origin}/api/v1/watch/demo-hook`, which on the server is `https://<DOMAIN>/api/v1/watch/demo-hook`. The web accepts it like any webhook: https, a public host name. `SPECFIRST_ALLOW_LOCAL_HTTP_WEBHOOKS` stays unset; it exists for a local http origin such as `http://localhost:3417` on a laptop.

Delivery: before each POST the watcher resolves the host and refuses one that resolves to a private address, except for the exact origins given with `--webhook-local-origin`. Both watchers here get `--webhook-local-origin https://<DOMAIN>` (`PUBLIC_ORIGIN` overrides it), and Caddy carries `DOMAIN` as an alias on the compose network. So a watcher reaches the site's own receiver inside the host, through Caddy with its real certificate, without depending on the host's NAT sending its own public address back in. The exception covers that one origin only; every other webhook still has to resolve to a public address.

The receiver keeps whatever is POSTed to it and shows it on `/watch/demo-hook`, so Caddy takes a POST to `/api/v1/watch/demo-hook` only from the two watchers, at their fixed addresses on the compose network (`.11` and `.12` of `SPECFIRST_NET`), and answers 403 to anyone else. Not every private address: a connection Docker's userland proxy forwards, such as one over IPv6, arrives from the network's gateway. Reading the page and `GET /api/v1/watch/demo-hook` stay open. Caddy also refuses any request body over 256 KB.

The registration on the Mac does not carry over by editing the file. `webhooks.json` holds `http://localhost:3417/api/v1/watch/demo-hook`, signed by the subscriber over that exact URL, and the watcher checks the signature again before every delivery, so a rewritten URL fails as `signature`. Left as it is, each alert to it is recorded as a failed `alerted` event ("webhook registration refused: url"), since nothing on the server is allowed to deliver to `http://localhost:3417`. Register again on the server; the newest registration of a subscriber replaces the old one:

1. The demo subscriber is the testnet burner kept in the browser's `localStorage` for the origin it was made on (`http://localhost:3417`), key `specfirst:burner:v1`. In the browser profile that made it, open `http://localhost:3417` (step 2 of the Migration stopped the Mac web; `restart-web.sh` starts it alone for a minute), and in the developer console run `copy(localStorage.getItem('specfirst:burner:v1'))`. On `https://<DOMAIN>`, run `localStorage.setItem('specfirst:burner:v1', '<pasted value>')` and reload. It is a testnet key, kept the same way the site always keeps it.
2. On `https://<DOMAIN>/watch/inbox`, register the demo URL the page shows. It is one signature and no transaction; the subscriber must hold an active subscription.
3. The next alert for a subscribed vault appears on `/watch/demo-hook` and as an `alerted` event with `ok: true` in the feed.

## Board

`/` is prerendered at `next build` from `packages/web/data/board.json`, which the web image builds from the reports in the checkout's `certs/checks/143` (the Mac's included, after the copy) and a read of CheckAttestationRegistry through `SPECFIRST_BOARD_RPC` (default `https://rpc.ankr.com/monad_testnet`; the public testnet RPC allows 15 requests per second). A failed registry read does not fail the build; the board says so. The rest reads current files per request: vault pages prefer a report newer than the board, the desk and watch pages read the watcher and the worker, and the board's table adds the vaults the watcher found when the page loads.

Rebuilding `board.json` inside a running container would change the vault pages but not `/`, so there is no periodic job. To bring `/` up to date (counts, the attested column), rebuild the web image; the signers keep running and the web is down for the seconds of its restart. Each rebuild leaves the old image and build cache behind, so prune them after:

```
cd /opt/specfirst && sudo docker compose -f deploy/docker-compose.yml up -d --build web
sudo docker image prune -f && sudo docker builder prune -f
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
curl -s https://<DOMAIN>/api/v1/vaults/143/0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E | jq .links    # https://<DOMAIN>/..., not localhost
curl -s -o /dev/null -w '%{http_code}\n' -X POST -d '{}' https://<DOMAIN>/api/v1/watch/demo-hook    # 403 from outside
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/about       # the web without Caddy
sudo docker compose -f deploy/docker-compose.yml logs --tail 50 watch-143   # NDJSON events, what watch-143.ndjson held on the Mac
sudo docker compose -f deploy/docker-compose.yml logs watch-143 | grep supervisor-restart    # crashes, 30 s apart
jq -r .updatedAt .specfirst/watch/143/status.json .specfirst/watch/10143/status.json
```

`stale: true` or an `updatedAt` minutes old means a watcher stopped; `docker compose ps` shows whether its container runs, and its logs say why. Each service's stdout (the NDJSON the Mac appended to `.specfirst/logs/*.ndjson`) is in `docker compose logs`, rotated at 20 MB, five files.

## Updating

As the login user (uid 1000), so new files in the checkout stay the containers':

```
cd /opt/specfirst && git pull     # or: git pull /tmp/specfirst.bundle main
sudo chown -R 1000:1000 .specfirst certs/checks    # needed only if git ran as another uid or as root
sudo docker compose -f deploy/docker-compose.yml up -d --build
sudo docker image prune -f && sudo docker builder prune -f
```

This rebuilds both images (the web with a fresh board) and recreates the services whose image changed. `git pull` refuses to overwrite an untracked file, as on the Mac: a report the server wrote under `certs/checks` that is later committed from elsewhere has to be moved aside first.

## Notes

- forge's version string goes into every report (`toolchain.forgeVersion`) and from there into the attestation's suite. The Mac's Homebrew forge says `forge Version: 1.5.1-Homebrew`, the release build in the image says `forge Version: 1.5.1-v1.5.1`, so attestations made on the server carry another suiteHash than the Mac's for the same check. The AllocationGate on testnet pins no suite (`suiteHash()` is zero), so its verdicts are unaffected; a gate that pins one would treat the server's attestations as another suite.
- Node 25 left support in June 2026. Only the CLI runs on it, for parity with the Mac; `NODE_VERSION` at the top of `deploy/Dockerfile` moves it to 24 once the signers are tested there.
