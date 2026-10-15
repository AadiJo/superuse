#!/usr/bin/env bash
# Build our Cua Driver fork for Windows from WSL/Linux, without sudo.
#
#   fork/build.sh              # dev build of tools/src/cua, installed into plugin/driver/cua-driver.exe
#   fork/build.sh --no-install # dev build only
#   fork/build.sh --clean      # release build: tools/clean/out/cua-driver.exe from a fresh clone
#
# The fork is upstream trycua/cua at the commit in fork/UPSTREAM plus fork/patches/*.patch.
#
# Dev builds work in tools/src/cua (a sparse clone, gitignored) on branch `bcu`:
#   - first run: clone at the pinned commit, `git am` the patches onto `bcu`
#   - later runs: build whatever `bcu` holds, so edits there can be tested before
#     `fork/export-patches.sh` writes them back to fork/patches/.
# A dev build doesn't prove which patches it contains, so installing one removes the driver's
# provenance record and scripts/setup.ts treats it as a local driver.
#
# Clean builds always start over in tools/clean/cua from the pinned commit and the current
# patches, so an old tree can't decide what a release contains. Registry crates compile into
# tools/clean/target and are reused between clean builds. scripts/setup.ts --build and
# scripts/release-driver.ts run this mode and record the result.
#
# Toolchain: the repo's pinned rustup toolchain, the x86_64-pc-windows-gnu target, Zig from the
# official archive (checksum pinned below) and cargo-zigbuild.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
read -r repo sha < "$root/fork/UPSTREAM"
mode="${1:-dev}"
case "$mode" in
  dev|--no-install|--clean) ;;
  *) echo "usage: fork/build.sh [--no-install | --clean]" >&2; exit 2 ;;
esac

zig_version=0.15.2
zig_sha256=02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239
zig="$root/tools/zig-$zig_version"
zigbuild_version=0.23.4

# Fail before any download or compile if a tool is missing.
missing=()
for tool in git curl tar xz sha256sum cargo rustup; do
  command -v "$tool" >/dev/null || missing+=("$tool")
done
if (( ${#missing[@]} )); then
  echo "fork/build.sh needs: ${missing[*]}. Install Rust with rustup (https://rustup.rs); the rest come from your distro." >&2
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

# A sparse clone at the pinned commit with the patches applied on branch `bcu`. `git am` gets a
# committer identity here, so the build never depends on (or changes) global Git config.
clone() {
  local dest="$1"
  echo "cloning $repo at $sha into ${dest#"$root"/}"
  git clone -q --filter=blob:none --no-checkout --sparse "https://github.com/$repo" "$dest"
  git -C "$dest" sparse-checkout set .cargo .github libs/cua-driver libs/cua/crates/cua-telemetry \
    libs/cua/crates/cua-teleport/src/ux libs/images
  git -C "$dest" checkout -q -b bcu "$sha"
  git -C "$dest" -c user.name="bcu build" -c user.email="bcu-build@localhost" am -q "$root"/fork/patches/*.patch
}

if [[ "$mode" == "--clean" ]]; then
  src="$root/tools/clean/cua"
  out="$root/tools/clean/out"
  rm -rf "$src" "$out"
  mkdir -p "$root/tools/clean" "$out"
  clone "$src"
  export CARGO_TARGET_DIR="$root/tools/clean/target"
else
  src="$root/tools/src/cua"
  [[ -d "$src/.git" ]] || { mkdir -p "$root/tools/src"; clone "$src"; }
  if [[ "$(git -C "$src" branch --show-current)" != "bcu" ]]; then
    echo "tools/src/cua is not on branch bcu; switch to it first" >&2
    exit 1
  fi
fi
rust="$src/libs/cua-driver/rust"

(cd "$rust" && rustup target add x86_64-pc-windows-gnu >/dev/null)
(cd "$rust" && PATH="$zig:$PATH" cargo zigbuild --release --target x86_64-pc-windows-gnu -p cua-driver)
exe="${CARGO_TARGET_DIR:-$rust/target}/x86_64-pc-windows-gnu/release/cua-driver.exe"
echo "built $exe ($(git -C "$src" log --oneline -1))"

case "$mode" in
  --clean)
    install -m 755 "$exe" "$out/cua-driver.exe"
    (cd "$rust" && rustc -V) > "$out/rustc.txt"
    echo "clean build: tools/clean/out/cua-driver.exe"
    ;;
  dev)
    mkdir -p "$root/plugin/driver"
    install -m 755 "$exe" "$root/plugin/driver/cua-driver.exe"
    rm -f "$root/plugin/driver/cua-driver.json"
    echo "installed plugin/driver/cua-driver.exe (dev build: no provenance record)"
    ;;
esac
