#!/bin/sh
# specfirst-supervise <command...>: runs the command and runs it again SPECFIRST_RESTART_DELAY seconds (default 30)
# after every exit, logging each restart as one NDJSON line, as run-watch-143.sh did on the Mac. The signing services
# run under it with restart: "no", so a crash comes back after the delay while a reboot of the server starts nothing
# (docs/deploy.md, Rollback). SIGTERM or SIGINT (docker compose stop) goes to the command and ends the loop.
set -u
delay="${SPECFIRST_RESTART_DELAY:-30}"
child=""
stop() {
  if [ -n "$child" ]; then
    kill -TERM "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  exit 143
}
trap stop TERM INT
while :; do
  "$@" &
  child=$!
  wait "$child"
  code=$?
  child=""
  printf '{"type":"supervisor-restart","at":"%s","exit":%s,"delaySec":%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "$delay"
  sleep "$delay" &
  child=$!
  wait "$child"
  child=""
done
