#!/usr/bin/env bash
# Build our Cua Driver fork for Windows from WSL/Linux, without sudo.
#
#   fork/build.sh              # build, then install into plugin/driver/cua-driver.exe
#   fork/build.sh --no-install # build only
#
# The fork is upstream trycua/cua at the commit in fork/UPSTREAM plus fork/patches/*.patch.
# Work happens in tools/src/cua (a sparse clone, gitignored) on branch `bcu`:
#   - first run: clone at the pinned commit, `git am` the patches onto `bcu`
#   - later runs: build whatever `bcu` holds, so edits there can be tested before
#     `fork/export-patches.sh` writes them back to fork/patches/.
# Toolchain: the repo's pinned rustup toolchain, the x86_64-pc-windows-gnu target,
# Zig (from pip, under tools/src/zigpy) and cargo-zigbuild.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
read -r repo sha < "$root/fork/UPSTREAM"
src="$root/tools/src/cua"
rust="$src/libs/cua-driver/rust"
zigpy="$root/tools/src/zigpy"

if [[ ! -d "$src/.git" ]]; then
  echo "cloning $repo at $sha"
  git clone --filter=blob:none --no-checkout --sparse "https://github.com/$repo" "$src"
  git -C "$src" sparse-checkout set .cargo .github libs/cua-driver libs/cua/crates/cua-telemetry \
    libs/cua/crates/cua-teleport/src/ux libs/images
  git -C "$src" checkout -q -b bcu "$sha"
  git -C "$src" am -q "$root"/fork/patches/*.patch
fi
if [[ "$(git -C "$src" branch --show-current)" != "bcu" ]]; then
  echo "tools/src/cua is not on branch bcu; switch to it first" >&2
  exit 1
fi

[[ -x "$zigpy/ziglang/zig" ]] || python3 -m pip install --quiet --target "$zigpy" "ziglang==0.15.2"
command -v cargo-zigbuild >/dev/null || cargo install --locked cargo-zigbuild --version 0.23.4
(cd "$rust" && rustup target add x86_64-pc-windows-gnu >/dev/null)

(cd "$rust" && PATH="$zigpy/ziglang:$PATH" cargo zigbuild --release --target x86_64-pc-windows-gnu -p cua-driver)
exe="$rust/target/x86_64-pc-windows-gnu/release/cua-driver.exe"
echo "built $exe ($(git -C "$src" log --oneline -1))"

if [[ "${1:-}" != "--no-install" ]]; then
  install -m 755 "$exe" "$root/plugin/driver/cua-driver.exe"
  echo "installed plugin/driver/cua-driver.exe"
fi
