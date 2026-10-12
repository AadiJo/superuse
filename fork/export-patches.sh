#!/usr/bin/env bash
# Write the commits on tools/src/cua's `bcu` branch back to fork/patches/, one file per commit.
# Run after committing fork changes in tools/src/cua. Nothing here pushes anywhere. Subjects stay
# unnumbered ("[PATCH]"), so adding a commit adds a file instead of rewriting every one.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
read -r _ sha < "$root/fork/UPSTREAM"
rm -f "$root"/fork/patches/*.patch
git -C "$root/tools/src/cua" format-patch -q --no-signature --no-numbered "$sha..bcu" -o "$root/fork/patches"
ls "$root/fork/patches"
