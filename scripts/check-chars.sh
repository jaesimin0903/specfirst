#!/usr/bin/env bash
# Fail if em-dash (U+2014), middle dot (U+00B7), or araea (U+318D) appears anywhere outside build and dependency dirs.
# Uses UTF-8 byte sequences so it works with BSD grep on macOS and GNU grep on Linux.
set -u
cd "$(dirname "$0")/.."
pattern=$(printf '\xe2\x80\x94\\|\xc2\xb7\\|\xe3\x86\x8d')
hits=$(LC_ALL=C grep -rn --exclude-dir={node_modules,lib,out,.git,cache,.specfirst,.ultrafuzz,dist,.next} -e "$pattern" . || true)
if [ -n "$hits" ]; then echo "forbidden characters found:"; echo "$hits"; exit 1; fi
echo "check:chars ok"
