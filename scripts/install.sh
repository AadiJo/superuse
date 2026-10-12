#!/usr/bin/env bash
# Install the bcu plugin into Claude Code from this checkout (WSL or Linux shell).
#
#   scripts/install.sh
#
# The plugin loads in place from plugin/ (a local-path marketplace), so later edits apply after
# /reload-plugins. This script makes sure the driver exe and the server's Node dependencies exist,
# then registers the marketplace and installs the plugin at user scope.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

[[ -f "$root/plugin/driver/cua-driver.exe" ]] || "$root/fork/build.sh"
[[ -d "$root/plugin/server/node_modules/quickjs-emscripten" ]] || (cd "$root/plugin/server" && npm ci --omit=dev --no-audit --no-fund --silent)

if ! claude plugin marketplace list 2>/dev/null | grep -q "better-computer-use"; then
  claude plugin marketplace add "$root"
fi
claude plugin install bcu@better-computer-use --scope user
echo "Installed. Start a new Claude Code session (or run /reload-plugins) to load it."
