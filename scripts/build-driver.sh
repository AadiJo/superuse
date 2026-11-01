#!/usr/bin/env bash
# Build the driver in driver/ for Windows from WSL/Linux, without sudo.
#
#   scripts/build-driver.sh              # build, then install into plugin/driver/cua-driver.exe
#   scripts/build-driver.sh --no-install # build only: tools/out/cua-driver.exe and tools/out/rustc.txt
#
# The installed build carries no provenance record, so scripts/setup.ts treats it as a local driver.
# scripts/setup.ts --build and scripts/release-driver.ts run --no-install and record the result.
#
# Toolchain: driver/rust-toolchain.toml, the x86_64-pc-windows-gnu target, Zig from the official
# archive (checksum pinned below) and cargo-zigbuild. Cargo builds into tools/target.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:-install}"
case "$mode" in
  install|--no-install) ;;
  *) echo "usage: scripts/build-driver.sh [--no-install]" >&2; exit 2 ;;
esac

zig_version=0.15.2
zig_sha256=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239
zig="$root/tools/zig-$zig_version"
zigbuild_version=0.23.4
target=x86_64-pc-windows-gnu

# Fail before any download or compile if a tool is missing.
missing=()
for tool in curl tar xz sha256sum cargo rustup; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  echo "scripts/build-driver.sh needs: ${missing[*]}. Install Rust with rustup (https://rustup.rs); the rest come from your distro." >&2
  exit 1
fi

if [[ ! -x "$zig/zig" ]]; then
  echo "downloading zig $zig_version"
  mkdir -p "$root/tools"
  archive="$(mktemp "$root/tools/zig.XXXXXX.tar.xz")"
  trap 'rm -f "$archive"' EXIT
  curl -fsSL -o "$archive" "https://ziglang.org/download/$zig_version/zig-x86_64-linux-$zig_version.tar.xz"
  echo "$zig_sha256  $archive" | sha256sum -c --quiet
  rm -rf "$zig" "$root/tools/zig-x86_64-linux-$zig_version"
  tar -xJf "$archive" -C "$root/tools"
  mv "$root/tools/zig-x86_64-linux-$zig_version" "$zig"
fi
[[ "$(cargo-zigbuild --version 2>/dev/null)" == *" $zigbuild_version" ]] \
  || cargo install --locked cargo-zigbuild --version "$zigbuild_version"

src="$root/driver"
export CARGO_TARGET_DIR="$root/tools/target"
(cd "$src" && rustup target add "$target" >/dev/null)
(cd "$src" && PATH="$zig:$PATH" cargo zigbuild --locked --release --target "$target" -p cua-driver)
exe="$CARGO_TARGET_DIR/$target/release/cua-driver.exe"
echo "built $exe"

out="$root/tools/out"
mkdir -p "$out"
install -m 755 "$exe" "$out/cua-driver.exe"
(cd "$src" && rustc -V) > "$out/rustc.txt"
if [[ "$mode" == install ]]; then
  mkdir -p "$root/plugin/driver"
  install -m 755 "$exe" "$root/plugin/driver/cua-driver.exe"
  rm -f "$root/plugin/driver/cua-driver.json"
  echo "installed plugin/driver/cua-driver.exe (local build: no provenance record)"
fi
