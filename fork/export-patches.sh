#!/usr/bin/env bash
# Write the commits on tools/src/cua's `bcu` branch back to fork/patches/, one file per commit.
# Run after committing fork changes in tools/src/cua. Nothing here pushes anywhere.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
read -r _ sha < "$root/fork/UPSTREAM"
rm -f "$root"/fork/patches/*.patch
git -C "$root/tools/src/cua" format-patch -q --no-signature "$sha..bcu" -o "$root/fork/patches"
ls "$root/fork/patches"
