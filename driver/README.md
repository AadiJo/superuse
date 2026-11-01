# Driver

The native Windows layer under the Superuse plugin: `superuse-driver.exe`, a stdio MCP server that reads UI Automation trees and sends input to windows in the background. It's a hard fork of [Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver) (MIT, `LICENSE`). `NOTES.md` covers what we changed and why.

Build it from WSL with `scripts/build-driver.sh` at the repo root. It installs `plugin/driver/superuse-driver.exe`.

## Crates

| Crate | Purpose |
| --- | --- |
| `superuse-driver` | The `superuse-driver` binary: CLI, MCP server and daemon |
| `superuse-core` | Shared protocol, tool models, config and CDP helpers |
| `platform-windows` | Windows UIA, capture, input, overlay and diagnostics |
| `superuse-contract` | Tool and CLI contract types |
| `superuse-sdk` | In-process embedding API |
| `cursor-overlay`, `cursor-motion` | The agent cursor's renderer and motion model |
| `pip-preview` | Packaging preview helper |
| `superuse-testkit` | Test-only helpers for spawning the driver and parsing responses |

Upstream's macOS and Linux platforms, end-to-end suites, bindings generator, perception and cursor-theme tooling aren't in this fork. The shared crates still hold their `cfg(target_os = "macos" | "linux")` code; only Windows builds.

`Skills/cua-driver/` is upstream's agent guide. The driver embeds it as MCP resources, so it stays as is. The Superuse plugin's own skill lives in `plugin/skills/`.
