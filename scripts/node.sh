# Sourced by scripts/install.sh and scripts/doctor.sh: find a Node 24+ to run scripts/setup.ts.
#
#   bcu_node [--download]   prints the path of a usable node, or fails with a message on stderr
#
# Order: $BCU_NODE (used as given, never skipped), `node` on PATH, the path setup recorded in
# ~/.config/bcu/node-path, then bcu's own copy. With --download, and only if none of those
# works, it fetches the pinned Node LTS below into ~/.local/share/bcu/node and checks its
# SHA-256. It never edits shell startup files or touches a system Node.

BCU_NODE_VERSION=v24.22.0
BCU_NODE_SHA256=cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008

bcu_node_ok() {
  [[ -x "$1" ]] && "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null
}

bcu_node() {
  if [[ -n "${BCU_NODE:-}" ]]; then
    bcu_node_ok "$BCU_NODE" && { echo "$BCU_NODE"; return; }
    echo "BCU_NODE=$BCU_NODE is not Node 24 or newer." >&2
    return 1
  fi
  local name="node-$BCU_NODE_VERSION-linux-x64"
  local home="$HOME/.local/share/bcu/node"
  local candidate
  for candidate in "$(command -v node || true)" "$(cat "$HOME/.config/bcu/node-path" 2>/dev/null || true)" "$home/$name/bin/node"; do
    [[ -n "$candidate" ]] && bcu_node_ok "$candidate" && { echo "$candidate"; return; }
  done
  if [[ "${1:-}" != "--download" ]]; then
    echo "No Node 24+ found. Run scripts/install.sh, which downloads one for bcu, or set BCU_NODE." >&2
    return 1
  fi
  if [[ "$(uname -m)" != "x86_64" ]]; then
    echo "No Node 24+ found, and bcu only downloads Node for x86_64. Install Node 24+ or set BCU_NODE." >&2
    return 1
  fi
  echo "No Node 24+ found; downloading $name for bcu into $home" >&2
  mkdir -p "$home"
  local archive
  archive="$(mktemp "$home/download.XXXXXX")"
  if ! curl -fsSL -o "$archive" "https://nodejs.org/dist/$BCU_NODE_VERSION/$name.tar.xz" \
    || ! echo "$BCU_NODE_SHA256  $archive" | sha256sum -c --quiet >&2; then
    rm -f "$archive"
    echo "Downloading Node failed or its checksum didn't match. Install Node 24+ or set BCU_NODE." >&2
    return 1
  fi
  rm -rf "${home:?}/$name"
  tar -xJf "$archive" -C "$home"
  rm -f "$archive"
  echo "$home/$name/bin/node"
}
