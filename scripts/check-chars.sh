#!/usr/bin/env bash
# Fail if em-dash (U+2014), middle dot (U+00B7), or araea (U+318D) appears anywhere outside node_modules, lib, out, .git.
set -u
cd "$(dirname "$0")/.."
hits=$(grep -rnP --exclude-dir={node_modules,lib,out,.git,cache,.specfirst,.ultrafuzz} '[\x{2014}\x{00B7}\x{318D}]' . || true)
if [ -n "$hits" ]; then echo "forbidden characters found:"; echo "$hits"; exit 1; fi
echo "check:chars ok"
