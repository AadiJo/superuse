#!/usr/bin/env bash
# MCP launcher for the bcu server. Claude's plugin manifest and Codex's registration both run
# this file, so a client started from a GUI (without the shell's PATH) still finds Node.
#
# Node, in order: $BCU_NODE, the path scripts/install.sh recorded in ~/.config/bcu/node-path,
# then `node` on PATH if it's 24+. It never scans version managers or downloads anything: the
# client is waiting for the MCP handshake. stdout belongs to MCP, so errors go to stderr.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repair="run $(cd "$here/../.." && pwd)/scripts/install.sh to pick a Node 24+"

node="${BCU_NODE:-}"
[[ -n "$node" ]] || node="$(cat "$HOME/.config/bcu/node-path" 2>/dev/null || true)"
if [[ -n "$node" ]]; then
  [[ -x "$node" ]] || { echo "bcu: no Node at $node; $repair" >&2; exit 1; }
else
  node="$(command -v node || true)"
  if [[ -z "$node" ]] || ! "$node" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)'; then
    echo "bcu: no Node 24+ recorded or on PATH; $repair" >&2
    exit 1
  fi
fi
exec "$node" "$here/main.ts"
