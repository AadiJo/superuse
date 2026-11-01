#!/usr/bin/env bash
# Install or update superuse from this checkout (WSL2 on Windows 11, x64). Safe to rerun: it repairs
# what's missing or stale and leaves the rest alone.
#
#   scripts/install.sh                          detect Claude Code and Codex, set up both
#   scripts/install.sh --clients=codex          only these clients (claude, codex; "none" for neither)
#   scripts/install.sh --build                  build the driver from source instead of downloading it
#   scripts/install.sh --allow-apps=TestPad     record access the user approved (see --help)
#   scripts/install.sh --json                   one JSON report on stdout
#
# This finds a Node 24+ (downloading one for superuse if needed), then runs scripts/setup.ts, which
# does the rest and prints what works and what still needs a restart or the user.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
source "$root/scripts/node.sh"
node="$(superuse_node --download)"
exec "$node" "$root/scripts/setup.ts" install "$@"
