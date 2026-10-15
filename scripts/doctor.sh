#!/usr/bin/env bash
# Report whether this checkout's bcu install works, without changing anything.
#
#   scripts/doctor.sh             text report
#   scripts/doctor.sh --json      one JSON report on stdout
#   scripts/doctor.sh --verify    also drive a test app (and the browser, if enabled) through the server
#
# It never downloads, edits client configuration or changes permissions. Exit status: 0 when the
# install works (a client restart may still be pending), 1 on a failure, 2 when the user must act.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/node.sh"
node="$(bcu_node)" || exit 1
exec "$node" "$root/scripts/setup.ts" doctor "$@"
