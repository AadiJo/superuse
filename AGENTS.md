# Superuse

Windows computer use for MCP clients: one sandboxed `js` tool over a background-input UI Automation driver. It runs in WSL2 on Windows 11 (x64). `README.md` covers the design, layout and privacy model.

## Setting Superuse up for the user

Use this when the user asks you to install, configure, update or repair Superuse. Each step ends on its done-condition.

1. **Permanent checkout.** Clients run Superuse from this checkout, so it has to outlive your session. If this is a git worktree (`git rev-parse --git-dir` differs from `--git-common-dir`) or a temp directory, clone it into `~/.local/share/superuse/source` at the commit you're on: `git clone <this checkout> ~/.local/share/superuse/source`, `git -C ~/.local/share/superuse/source checkout <output of git rev-parse HEAD here>`, then `git -C ~/.local/share/superuse/source remote set-url origin https://github.com/AadiJo/superuse`. Cloning from the checkout keeps local commits; commit uncommitted changes the user wants first. If that folder already holds something else, ask the user where to clone. Work from the permanent checkout from here on. Done when you're in a checkout that isn't a worktree or temp folder.
2. **Install.** Run `scripts/install.sh --json`, with `--clients=claude`, `--clients=codex` or both when the user named their client (without it, setup picks the installed ones). It downloads what's missing, registers the clients, and tests the server. Done when the report's `outcome` is `server_verified` or `restart_required`, or the remaining checks need the user.
3. **Fix what the report lists.** Each check with status `action` or `fail` carries a `next` step. Do the ones you can, rerun install, and repeat. Give the user the steps only they can do (`gh auth login`, the browser's remote-debugging toggle), word for word.
4. **Access choices.** The `policy` check shows what is already allowed. Ask the user once, in one message, about what isn't settled and what their task needs:
   - which apps Superuse may control without asking. Clients that can't show approval prompts need this (`claude -p`, T3 Code);
   - whether Superuse may briefly take the real mouse and focus when background input fails;
   - whether `w.page()` may use their running, logged-in browser.

   Rerun install with exactly the approved answers: `--allow-apps=TestPad,Calculator`, `--foreground=allow|ask|deny`, `--browsers=attach|off`. Wildcards (`--allow-apps=*`) and attach come only from the user's own words. Done when every choice is either answered or left at its default by the user.
5. **Prove it.** With `restart_required`, tell the user to start a new session of that client (or run `/reload-plugins` in Claude Code). In a session that has Superuse loaded, call the `js` tool with `return (await desktop.windows()).length`. If the user turned the browser on, also run `scripts/doctor.sh --verify` with the browser open. Done when the client the user named returns a number from that call, and `browser` reads `BROWSER_VERIFIED` or `BROWSER_DISABLED`.

Finish by telling the user the outcome, what you verified, and anything still waiting on them. `scripts/doctor.sh` rechecks everything later without changing anything.

## Working on Superuse

- Checks: `node bench/server-check.ts` (sandbox and policy), `node bench/ui-check.ts` (window API on fixture windows; sends input, so run it on an idle desktop), `node bench/acceptance.ts` (driver checks on real apps; also sends input), `node bench/setup-check.ts` (installer, in isolated client config), `npm run typecheck` at the root and in `plugin/server`.
- Bump `version` in `plugin/.claude-plugin/plugin.json` whenever the server, skill, launcher, dependencies or driver pin change. The server and setup read it from there.
- Editing `driver/` or `scripts/build-driver.sh` changes the driver's source fingerprint. Installs then need `--build`, until a maintainer runs `node scripts/release-driver.ts --publish` and commits the new `driver/release.json`.
- Agent sessions export `CLAUDE_CONFIG_DIR`, which beats `HOME`. A test that only changes `HOME` edits the user's real Claude config. Set `CLAUDE_CONFIG_DIR` and `CODEX_HOME` too, as `bench/setup-check.ts` does.
