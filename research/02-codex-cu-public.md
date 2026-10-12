# Codex Computer Use: what OpenAI has shipped and said publicly

Research date: 2026-10-11. Scope is public information only (OpenAI posts and docs, the openai/codex repo, OpenAI staff posts, interviews, reviews, HN). Another agent is reading the locally installed runtime, so internals here are limited to what is publicly documented. Every claim has a link. Anything I could not confirm from a primary source is marked "unverified" or "secondary".

## TL;DR

- "Ultra" and "Ultrafast" are two different official OpenAI features, and neither is specific to computer use. **Ultra** is a reasoning setting above Max that runs four cooperating subagents in parallel by default ([GPT-5.6 post](https://openai.com/index/gpt-5-6/), [Models docs](https://learn.chatgpt.com/docs/models)). **Ultrafast** is a premium inference speed tier: GPT-6 Astra at up to 300 tokens/s in Codex, up to 8x Standard, at 6x the API price, on the new $500 Pro plan or Enterprise ([DevDay recap](https://openai.com/index/devday-2026-recap/), [Speed docs](https://learn.chatgpt.com/docs/agent-configuration/speed)). The "peak experience" people describe is almost certainly GPT-6 Astra (or GPT-6.1 Sol) on Ultrafast, inside the Codex/ChatGPT desktop app's Computer Use plugin.
- OpenAI has published no number for how much Ultrafast speeds up a computer-use task end to end. The CU speed claims it has published come from the model plus harness work: "nearly 2x faster" with Astra, ~60% from harness changes alone on GPT-5.6 Sol ([Ari Weinstein, Sep 4](https://x.com/AriX/status/2095671700771762341)), and 1.9x faster on Mind2Web ([GPT-6 Astra post](https://openai.com/index/gpt-6-astra/)).
- Timeline: OpenAI bought Software Applications Inc. (Sky) on 2025-10-23. The Codex app launched 2026-02-02. Computer Use shipped on macOS 2026-04-16 and on Windows 2026-05-29. It reached the EU/UK/CH on 2026-06-16. Codex merged into the ChatGPT desktop app on 2026-07-09, and Computer Use came to the developer Agents API (hosted browser) at DevDay on 2026-09-29 ([changelog](https://learn.chatgpt.com/docs/changelog)).
- The model is whatever you pick in Codex. GPT-5.4 (2026-03-05) was the first with native CU. OpenAI calls GPT-6 Astra (2026-09-03) "the world's best computer use model": 72.6% on OSWorld 2.0 offline at about 40 min/task, and 92.7% on ScreenSpot-Pro. GPT-6.1 Sol lands within 2.1 points of that at about 1/7 the cost per task ([Astra](https://openai.com/index/gpt-6-astra/), [6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/)). The older OSWorld-Verified numbers are 75.0% for GPT-5.4 and 78.7% for GPT-5.5.
- Architecture, from OpenAI's own head of Computer Use: the model writes JavaScript that executes many actions per call. It combines screenshots, the accessibility tree, DOM and Playwright. Speed came from dropping screenshot-and-scroll loops and fixing "a lot of little paper cuts". He also says "we train our models on our Computer Use harness", which may give a speed, cost, and accuracy edge ([Latent Space, 2026-09-30](https://www.latent.space/p/devday-2026)).
- The open-source openai/codex repo confirms two REPL-backed MCP servers. `node_repl` serves the browser, Chrome and older computer-use plugins. `cua_repl` serves the `unified-computer-use` plugin. Both expose a `js` tool, and a guardian model reviews their calls ([bundled_hooks.rs](https://github.com/openai/codex/blob/main/codex-rs/plugin/src/bundled_hooks.rs), [mcp.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/mcp.rs), [node_repl_policy.md](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/node_repl_policy.md)). The native helper (`SkyComputerUseService`) is closed source.
- On macOS it runs in the background with its own cursor, and several agents can share the Mac with you. On Windows it takes over the foreground. Every app needs approval (Allow, Always allow, Cancel). It cannot drive terminal apps, ChatGPT itself, or OS security prompts ([Computer Use docs](https://learn.chatgpt.com/docs/computer-use)).
- Reception is strong on precision and "it doesn't take over my Mac". MacStories called it "the best computer use feature I have ever tested". Ari said it was the first time he had seen an LLM operate a GUI as fast as a person. Complaints focus on usage burn (Astra, and Ultrafast at 8x included usage), Windows capture bugs, and surprise when a glowing cursor shows up uninvited.
- For our project, the bar is roughly human-speed GUI operation with background, multi-cursor control on macOS. We need batched code actions over an AX-first observation, per-app approvals, and an automatic action reviewer. Speed has to show up as wall-clock per task, not just model tokens/s.

## What "ultra" and "ultra-fast" mean

There are two official features with similar names, plus loose usage ("Ultra Fast", "UltraFast") in OpenAI's own code and in speech.

| | Ultra (reasoning) | Ultrafast (speed tier) |
|---|---|---|
| What it is | Reasoning setting above Max. "Coordinating four agents in parallel by default, trading higher token use for stronger results and faster time-to-result" ([GPT-5.6](https://openai.com/index/gpt-5-6/)) | A service tier. The same model runs on faster inference hardware or settings, without a smaller model ([Ultrafast API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode)) |
| First appeared | Announced with the GPT-5.6 Sol preview on 2026-06-26 ([preview](https://openai.com/index/previewing-gpt-5-6-sol/)), GA on 2026-07-09 ([GPT-5.6](https://openai.com/index/gpt-5-6/)) | Previewed 2026-08-13 for GPT-5.6 Sol on Cerebras, up to 750 tok/s and up to 14x Standard ([OpenAI](https://openai.com/index/previewing-ultrafast/), [Cerebras](https://x.com/cerebras/status/2087948820906950719)). Broad launch at DevDay on 2026-09-29 for GPT-6 Astra ([recap](https://openai.com/index/devday-2026-recap/)). GPT-6.1 Sol Ultrafast reached Codex on 2026-10-08 ([changelog](https://learn.chatgpt.com/docs/changelog)) |
| Models | GPT-5.6 Sol, GPT-6 Sol, GPT-6.1 Sol, and per the live catalog GPT-6 Astra. Not Luna or Terra ([Models docs](https://learn.chatgpt.com/docs/models); Astra support comes from a third-party catalog read, [clodex #272](https://github.com/bman654/clodex/issues/272), so treat it as secondary) | GPT-6 Astra and GPT-6.1 Sol ([Speed docs](https://learn.chatgpt.com/docs/agent-configuration/speed)) |
| Speed | Faster time-to-result through parallelism. Tokens per second are unchanged | Astra Ultrafast is "up to 8x faster than GPT-6 Astra in Standard mode in Codex", 300 tok/s, and "4x faster than Astra Fast". In the API it is "up to 6x" ([OpenAI on X](https://x.com/OpenAI/status/2104993966043320759), [OpenAIDevs](https://x.com/OpenAIDevs/status/2104996045482778973)) |
| Cost | More tokens (four or more agents) | API price is 6x Standard. Astra costs $60 in / $300 out per 1M, and 6.1 Sol $12 / $60 ([pricing](https://developers.openai.com/api/docs/pricing)). In Codex it draws included usage at 8x and credits at 6x ([Speed docs](https://learn.chatgpt.com/docs/agent-configuration/speed)) |
| Availability | Codex on Plus and up. ChatGPT Work on Pro and Enterprise ([GPT-5.6](https://openai.com/index/gpt-5-6/)). Not an API value: the backend rejects `effort: "ultra"` with HTTP 400, and the catalog describes it as "Maximum reasoning with automatic task delegation", so it is client-side ([clodex #272](https://github.com/bman654/clodex/issues/272), secondary). The API equivalent is the multi-agent beta | Codex and ChatGPT Work on Pro $500 (25x Plus usage) and eligible Enterprise/Edu. Other self-serve plans can't use it even with credits ([recap](https://openai.com/index/devday-2026-recap/), [Speed docs](https://learn.chatgpt.com/docs/agent-configuration/speed)). Open to all API users with separate rate limits ([API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode)) |
| How to turn on | The model slider. "Ultra in model picker slider" in Settings > Configuration. CLI: `/model`, then "More reasoning…" ([Models docs](https://learn.chatgpt.com/docs/models)) | The model or speed picker in the app. API: `service_tier: "ultrafast"`, ideally over WebSockets. Codex config has an `ultrafast_mode` feature flag ([codex PR #51253](https://github.com/openai/codex/pull/51253)) |

Other speed options, for context. **Fast** costs 2x price for about 2x (Astra) or 1.5x (GPT-5.5/5.6) speed. It was formerly called Priority processing ([Speed docs](https://learn.chatgpt.com/docs/agent-configuration/speed), [Astra post](https://openai.com/index/gpt-6-astra/)). **GPT-5.3-Codex-Spark** was a small text-only Cerebras model at 1000+ tok/s (launched 2026-02-12, deprecated 2026-09-14) ([changelog](https://learn.chatgpt.com/docs/changelog)).

My read on the slang. "Ultra-fast" as a peak computer-use experience means Astra (or 6.1 Sol) on the Ultrafast tier in the desktop app. That is the fastest token generation OpenAI sells on its strongest CU model. "Ultra" alone is ambiguous. It is either short for Ultrafast or the subagent reasoning setting. I found no Computer Use setting called "ultra", and no OpenAI statement that Ultra subagents drive the desktop in parallel. The settings page lists Ultra with a Full access warning dialog ("Added clearer Full access warnings and a dialog when combining Full access with Ultra", [changelog 26.707](https://learn.chatgpt.com/docs/changelog)). Early user reactions to Ultrafast are emphatic: "Codex Ultra Fast mode is insane. Almost changes at the speed of thought" ([@remilouf, 2026-08-18](https://x.com/remilouf/status/2089751290783899826)). That was during the preview, so likely preview access (unverified).

Why Ultrafast could matter more for CU than for coding: CU is a long chain of short model turns between tool calls. OpenAI tells developers that without a persistent WebSocket, "network overhead can reduce the latency gains" ([API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode)). The counterpoint comes from Ari Weinstein: "as Computer Use gets faster, we're increasingly bottlenecked by just, like, the speed of doing an operation," such as waiting for doordash.com to load ([Latent Space](https://www.latent.space/p/devday-2026)). Faster tokens won't fix slow apps.

Hands-on Ultrafast data (not computer use specifically):

| Task | Standard | Ultrafast | Weekly usage | Source |
|---|---|---|---|---|
| 60 s reel from 145+ GB of footage, Astra Extra High | 49m 53s | 19m 13s (2.6x) | 4% vs 17% | [Nate Herk](https://www.linkedin.com/posts/nateherkelman_i-tested-codexs-500mo-ultrafast-what-activity-7511478636235939841-yL-u) |
| YouTube transcript to resource guide | 13m 3s | 1m 43s (7.6x) | 1% vs 3% | same |

MindStudio reviewed the same tests and concluded that Fast mode is the everyday choice and Ultrafast an "emergency lever" ([MindStudio](https://www.mindstudio.ai/blog/codex-ultrafast-pricing)). The lesson is that tool calls and heavy reasoning shrink the speedup well below the advertised 8x.

## Timeline

| Date | Event | Source |
|---|---|---|
| 2025-05 | Software Applications Inc. (Ari Weinstein, Conrad Kramer, Kim Beverett, ex-Workflow/Shortcuts) unveils Sky, a Mac natural-language interface that "understands what's on your screen and can take action using your apps" | [TechCrunch](https://techcrunch.com/2025/10/23/openai-buys-sky-an-ai-interface-for-mac/) |
| 2025-10-23 | OpenAI acquires Software Applications Inc., and all 12 staff join. The plan was to bring "Sky's deep macOS integration" into ChatGPT | [OpenAI](https://openai.com/index/openai-acquires-software-applications-incorporated/), [CNBC](https://www.cnbc.com/2025/10/23/openai-buys-ai-startup-software-applications-incorporated.html) |
| 2026-02-02 | Codex app for macOS launches | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-02-12 | GPT-5.3-Codex-Spark (Cerebras, 1000+ tok/s, text-only) | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-03-04 | Codex app for Windows | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-03-05 | GPT-5.4, "first general-purpose model with native computer-use capabilities". OSWorld-Verified 75.0%. The API gets an updated `computer` tool | [GPT-5.4](https://openai.com/index/introducing-gpt-5-4/) |
| 2026-04-16 | "Codex for (almost) everything", app version 26.415. Background computer use on macOS, an in-app browser, 90+ plugins, memory. Not in the EEA/UK/CH at launch | [OpenAI](https://openai.com/index/codex-for-almost-everything/), [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-04-23 | GPT-5.5 (OSWorld-Verified 78.7%). Browser use in the app through the bundled Browser plugin | [GPT-5.5](https://openai.com/index/introducing-gpt-5-5/), [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-04-30 | "Computer Use runs this use case 42% faster in today's Codex app update" | [Ari Weinstein](https://x.com/AriX/status/2049932746567598472) |
| 2026-05-07 | Codex for Chrome extension. It "works in parallel across tabs in the background without taking over your browser" | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-05-21 | 26.519: Appshots (press both Command keys), locked/remote computer use after the Mac locks, a read-only JS sandbox for browser data extraction | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-05-29 | 26.527: Computer Use on Windows, foreground only, plus Windows remote control | [changelog](https://learn.chatgpt.com/docs/changelog), [James Sun via AriX](https://x.com/AriX/status/2060506125011911147) |
| 2026-06-11 | 26.609: Enterprise access to CU, Windows per-app policies, Browser Developer mode (CDP), "Browser use up to 2x faster through CDP and DOM snapshot optimizations" | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-06-16 | CU and the Chrome extension reach the EEA, UK and Switzerland | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-06-18 | 26.616: Record & Replay (demonstrate a workflow on macOS and it becomes a skill) | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-06-26 / 07-09 | GPT-5.6 Sol/Terra/Luna. Max and Ultra efforts arrive. 26.707 merges Codex into the ChatGPT desktop app and "Made Computer Use faster with GPT-5.6" | [preview](https://openai.com/index/previewing-gpt-5-6-sol/), [GPT-5.6](https://openai.com/index/gpt-5-6/), [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-08-13 | Ultrafast preview (GPT-5.6 Sol on Cerebras, 750 tok/s) | [OpenAI](https://openai.com/index/previewing-ultrafast/) |
| 2026-08-25 | Browser extension for Edge, Brave, Opera, Vivaldi. Site tools (WebMCP) in the built-in browser | [changelog](https://learn.chatgpt.com/docs/changelog) |
| 2026-09-03 | GPT-6 Astra plus a harness update for CU speed | [Astra](https://openai.com/index/gpt-6-astra/), [AriX](https://x.com/AriX/status/2095671700771762341) |
| 2026-09-10 | Agents API public beta ("the Codex harness, fully managed by OpenAI") | [OpenAI](https://openai.com/index/introducing-the-agents-api/) |
| 2026-09-29 | DevDay: Agents API gets computer use. Ultrafast, GPT-6.1 Sol, the Pro $500 plan, Dots with cloud computers | [recap](https://openai.com/index/devday-2026-recap/) |
| 2026-10-08 | GPT-6.1 Sol Ultrafast in Codex | [changelog](https://learn.chatgpt.com/docs/changelog) |

Internal names visible in public sources:

- Plugin IDs `computer-use@openai-bundled` (served by `node_repl`), `unified-computer-use@openai-bundled` (served by `cua_repl`), plus `browser@`, `chrome@`, `chrome-dev@`, and `chrome-internal@openai-bundled` ([bundled_hooks.rs](https://github.com/openai/codex/blob/main/codex-rs/plugin/src/bundled_hooks.rs)).
- macOS service `SkyComputerUseService`, bundle `com.openai.sky.CUAService`, CU service version 26.929.1001365 alongside desktop 26.930.41038 ([issue #50823](https://github.com/openai/codex/issues/50823)). The earlier client was `SkyComputerUseClient.app` ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/), [issue #20851](https://github.com/openai/codex/issues/20851)).
- On Windows the helper is `codex-computer-use-swift.exe`, seen in app 26.930.3930.0 ([issue #51022](https://github.com/openai/codex/issues/51022)).
- `@oai/cua` 0.2.4 and `@oai/sky` 0.6.26 ship inside ChatGPT.app 26.901 ([Qwen Code design doc](https://github.com/QwenLM/qwen-code/blob/main/docs/design/cua-app-oriented-actions.md), third-party reverse engineering).
- App versions follow `YY.MDD`, so 26.930 is a Sep 30, 2026 build (inferred from the changelog dates).

## Models, benchmarks, speed and cost

Computer Use in Codex uses whichever model the thread runs. The docs recommend GPT-6 Astra "for difficult tasks that depend on screenshots or visual judgment" ([Computer Use docs](https://learn.chatgpt.com/docs/computer-use)).

All of the figures below are reported by OpenAI.

| Model (date) | CU benchmark | Score | Notes |
|---|---|---|---|
| GPT-5.4 (03-05) | OSWorld-Verified | 75.0% (human 72.4%) | WebArena-Verified 67.3%, Online-Mind2Web 92.8% screenshot-only ([GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)) |
| GPT-5.5 (04-23) | OSWorld-Verified | 78.7% | Claude Opus 4.7 at 78.0% in the same table ([GPT-5.5](https://openai.com/index/introducing-gpt-5-5/)) |
| GPT-5.6 Sol (07-09) | OSWorld 2.0 | 62.6% | Opus 4.8 at 54.8%. "Surpasses Opus 4.8 while using 85% fewer output tokens" ([GPT-5.6](https://openai.com/index/gpt-5-6/)) |
| GPT-6 Astra (09-03) | OSWorld 2.0 offline (v2026.08.08, partial score) | 72.6% at ~40 min/task | GPT-5.6 Sol scores 65.7% at ~75 min, Claude Opus 5 70.2%. ScreenSpot-Pro (no tools) 92.7%. Agents' Last Exam 59.3% ([Astra](https://openai.com/index/gpt-6-astra/)) |
| GPT-6.1 Sol (09-29) | OSWorld 2.0 offline | Within 2.1 pts of Astra at max effort, ~1/7 the cost per task | +7 pts over GPT-6 Sol ([6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/)) |

Speed claims, newest first:

- GPT-6 Astra plus the harness: "1.9x faster task completion compared to the current GPT-5.6 Sol experience, on the Mind2Web benchmark". One demo run took 2 min 54 s ([Astra](https://openai.com/index/gpt-6-astra/)).
- "With Astra, ChatGPT is nearly 2x faster at computer use than before… These optimizations work in existing models too, so tasks are sped up by ~60% in GPT-5.6 Sol" ([AriX](https://x.com/AriX/status/2095671700771762341)).
- "Computer Use is, like, faster at accomplishing tasks than, like, the average human probably in most cases". A meal-prep order that took Ari 2 hours by hand took 15 minutes on GPT-6.1 Sol ([Latent Space](https://www.latent.space/p/devday-2026)).
- On 2026-04-30 Ari reported 42% faster on one use case after an app update ([AriX](https://x.com/AriX/status/2049932746567598472)). A follow-up quoted by secondary sources attributes 42% to 5.3-Spark and 16% to GPT-5.5 (unverified, I could not load the follow-up post). Spark was text-only at launch, which suggests CU can make progress on accessibility text alone (my inference).
- On 2026-04-16 Ari wrote: "This is the first time I've ever seen an LLM operate a GUI as fast as a person" ([AriX quote](https://x.com/AriX/status/2049932746567598472)).
- A GPT-5.4 customer, Mainstay, reported "~3x faster while using ~70% fewer tokens" on about 30K property-tax portals, with a 95% first-attempt success rate ([GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)).

Steps per task have not been published. GPT-5.4's post argues that "tool yields", not tool calls, are the better latency proxy because parallel calls share one yield ([GPT-5.4](https://openai.com/index/introducing-gpt-5-4/)). OSWorld 2.0 uses 108 hour-long tasks (secondary, [Miraflow](https://miraflow.ai/blog/osworld-2-explained-computer-use-agent-benchmark-2026)).

Cost and plans:

- API Standard is $10/$50 per 1M tokens for Astra and $2/$10 for 6.1 Sol. Fast is 2x and Ultrafast 6x ([pricing](https://developers.openai.com/api/docs/pricing)).
- The `computer` tool has no separate fee. Tokens are billed at model rates ([pricing](https://developers.openai.com/api/docs/pricing)). The Agents API adds "no additional fees" ([Agents API](https://openai.com/index/introducing-the-agents-api/)). Pricing for the hosted desktop or browser is not listed (unverified).
- In Codex, Pro $500 gives 25x Plus usage and includes Ultrafast ([recap](https://openai.com/index/devday-2026-recap/)). The $200 Pro tier dropped to 10x Plus ([The Decoder](https://the-decoder.com/openai-expands-codex-and-its-api-at-devday-with-security-scans-a-decisions-api-and-ultrafast/), secondary).

## Product behavior

**Background and parallel.** "With background computer use, Codex can now use all of the apps on your computer by seeing, clicking, and typing with its own cursor. Multiple agents can work on your Mac in parallel, without interfering with your own work in other apps" ([OpenAI](https://openai.com/index/codex-for-almost-everything/)). MacStories saw several cursors working across apps without bringing them to the foreground. The cursor wiggles while the model thinks and takes its color from the wallpaper ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/)). Windows is different. It "can't operate in the background… expect ChatGPT to move the pointer, type, and take over the foreground", and Esc cancels ([Computer Use docs](https://learn.chatgpt.com/docs/computer-use), [James Sun](https://x.com/AriX/status/2060506125011911147)).

**Setup and invocation.** You install the Computer Use plugin, which is "one MCP server ('Computer-use') and one skill". You grant Screen Recording and Accessibility on macOS. Then you mention `@Computer`, `@AppName` (e.g. `@Chrome`), or just ask ([docs](https://learn.chatgpt.com/docs/computer-use)). Codex also reaches for it on its own "when it's the right tool for the job" ([James Sun](https://x.com/AriX/status/2060506125011911147)). A CLI entry point is only semi-official. Installing it from the app makes it available to the CLI ([HN, conradev](https://news.ycombinator.com/item?id=47822866)), and a first-class CLI request is still open ([#20851](https://github.com/openai/codex/issues/20851)).

**Approvals.**
- Codex asks before using each app, with Allow, Always allow, or Cancel. It may also ask before "sensitive or disruptive actions" ([docs](https://learn.chatgpt.com/docs/computer-use)).
- Config keys: `[computer_use.windows] always_allowed_app_ids`. Admins use `[features].computer_use = false` in `requirements.toml` ([docs](https://learn.chatgpt.com/docs/computer-use)). The open-source schema also has `default_app_access`, `macos.bundle_ids`, `windows.aumids`, and `windows.exes` ([computer_use.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/computer_use.rs)).
- A guardian model (auto-review) checks `node_repl`/`cua_repl` actions. Its policy says to judge clicks "according to the actual interface… not the agent's description of its intent". It denies unapproved sign-ins, permission grants and sensitive egress ([node_repl_policy.md](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/node_repl_policy.md)).

**Other surfaces.**
- **Appshots** share the frontmost window as a screenshot plus its "raw accessibility representation" ([Latent Space](https://www.latent.space/p/devday-2026), [changelog](https://learn.chatgpt.com/docs/changelog)).
- **Record & Replay** ([changelog](https://learn.chatgpt.com/docs/changelog)).
- **Locked use**: after the Mac locks, an Apple authorization plug-in covers the displays and relocks on any local input ([docs](https://learn.chatgpt.com/docs/computer-use)).
- **Remote control** from a phone ([changelog](https://learn.chatgpt.com/docs/changelog)).
- **Dots** get "a cloud Linux virtual computer" with full desktop apps ([36Kr summary of Latent Space](https://eu.36kr.com/en/p/4017229795299203), [Dots docs](https://learn.chatgpt.com/docs/dots/computers-and-apps)).

**Browser is separate.** There are three routes. The in-app browser handles public or local pages with annotations. The Chrome (and other browser) extension works with your signed-in profile in background tabs. Computer Use handles native or cross-app work ([Jason Liu](https://jxnl.co/writing/2026/06/16/three-ways-codex-can-use-a-computer/), [changelog](https://learn.chatgpt.com/docs/changelog)). The docs say "If an app has a dedicated plugin or MCP server, prefer that" ([docs](https://learn.chatgpt.com/docs/computer-use)).

**Limitations stated by OpenAI.** It "can't automate terminal apps or ChatGPT itself", can't authenticate as an administrator, and can't approve OS security and privacy prompts. Desktop-app edits may not appear in the review pane ([docs](https://learn.chatgpt.com/docs/computer-use)).

**Failure modes in public issues** (the openai/codex tracker has dozens of open `computer-use` issues as of 2026-10-11):
- Windows window capture times out (`FrameArrived timed out`), and clicks fail with "coordinate input geometry is unavailable" ([#49680](https://github.com/openai/codex/issues/49680), [#51291](https://github.com/openai/codex/issues/51291)). Native app inventory comes back empty ([#46436](https://github.com/openai/codex/issues/46436)).
- The macOS service crashes while reading a SwiftUI sheet ([#50823](https://github.com/openai/codex/issues/50823)).
- The Windows helper keeps resetting the idle timer after Esc, so the display never sleeps ([#51022](https://github.com/openai/codex/issues/51022)).
- The plugin goes missing or reports "Failed to spawn managed Computer Use service" ([#52191](https://github.com/openai/codex/issues/52191)).
- Intel Macs are unsupported ([#42514](https://github.com/openai/codex/issues/42514)). Thread opens stall for about 5 s while the helper is connected ([Aident](https://aident.ai/blog/fix-codex-thread-owner-discovery-timeout), secondary).
- There is no first-party Linux support. A community XDG-portal prototype exists ([#52654](https://github.com/openai/codex/issues/52654)).

## Architecture, from public sources

- **Code mode.** "It's not just doing one action at a time. It's actually writing JavaScript code that it executes, that the computer executes to perform sometimes many actions at once" ([Ari, Latent Space](https://www.latent.space/p/devday-2026)). The open-source repo backs this up:
  - `node_repl` and `cua_repl` are "Node REPL-backed" MCP servers with a `js` tool, e.g. `mcp__cua_repl__js` ([mcp.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/mcp.rs)).
  - There is a general "JavaScript code mode" feature with `exec`/`wait` entrypoints and a prewarmed host process ([features/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs)). The older `js_repl` flag has been removed.
  - OpenClaw's docs say the newer CU server "exposes `js`" and that a health check is one `await cua.listApps();` call ([OpenClaw docs](https://github.com/openclaw/openclaw/blob/main/docs/plugins/codex-computer-use.md)).
- **Observation mix.** "The model may use screenshots, it may use accessibility, it may use Playwright". With "direct access to the DOM… the language model can actually see, like, an entire page or an entire application" instead of screenshot-scroll-screenshot loops ([Latent Space](https://www.latent.space/p/devday-2026)). The AX dump is made "token-efficient… there's, like, a bit of an art to it" (same). MacStories saw GPT-5.4 reason about which "accessibility tree" to parse, with screenshots, coordinate clicks and AppleScript as fallbacks ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/)).
- **Native layer.** This is closed source. Community reverse engineering describes the input path: a persistent JS `cua` app object, then `@oai/cua`/`@oai/sky`, then IPC, then `SkyComputerUseService`, then AX queries or synthesized CGEvents sent to the target PID and window rather than moving the real cursor ([cc-haha blueprint](https://github.com/NanmiCoder/cc-haha/blob/main/docs/internals/computer-use-codex-impl-blueprint.md), [Qwen Code doc](https://github.com/QwenLM/qwen-code/blob/main/docs/design/cua-app-oriented-actions.md); third-party, not OpenAI).
- **Harness and model are co-trained.** "We train our models on our Computer Use harness, so there is an advantage to using the one that's in distribution for the model. There actually might be a speed and cost and accuracy advantage" ([Latent Space](https://www.latent.space/p/devday-2026)). Gains come "sometimes in the harness and sometimes in the model" (same).
- **Waiting.** "You want as little delay as possible between when it finally finishes loading and when you go and trigger the LLM to do the next action… When possible, you want it to be event-driven" ([Latent Space](https://www.latent.space/p/devday-2026)).
- **Transport.** WebSockets were built first for Spark, to cut tool-call round-trip overhead. Async tool calling and mid-turn steering came later (Nikunj Handa, [Latent Space](https://www.latent.space/p/devday-2026)).

## Developer-facing offering

- **Responses API `computer` tool** (GPT-5.4 and later).
  - The model returns `computer_call` items with an ordered `actions` array, so batching is supported. Actions are click, double_click, drag, move, scroll, keypress, type, wait and screenshot.
  - You run the environment yourself. OpenAI advises returning screenshots with `detail: "original"`.
  - "For GPT-6 Astra, we recommend code execution. The `computer` tool remains supported as an alternative". In code execution the model writes PyAutoGUI or Playwright scripts against a runtime you host. The [CUA sample app](https://github.com/openai/openai-cua-sample-app) shows both approaches.
  - Older `computer-use-preview` integrations have a migration path ([Computer use guide](https://developers.openai.com/api/docs/guides/tools-computer-use)).
- **Agents API with computer use** (DevDay). You add `{ "type": "computer_use" }` with `environment.type: "openai_hosted"` and `desktop.enabled: true`.
  - It runs a browser in an OpenAI-hosted environment. Every new origin needs user approval, and sign-in goes through a credential flow kept outside model input.
  - Examples use `gpt-6-astra` ([Agents API CU guide](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use)).
  - The Agents API is "powered by the open-source Codex harness" ([Agents API](https://openai.com/index/introducing-the-agents-api/)).
  - It does not drive a user's local desktop.
- **Can third parties use the same model and harness?** The models, yes, through the API, in any harness. The cloud harness, yes, through the Agents API, but only for hosted browser/desktop sessions. The local desktop harness (Sky service, `cua` JS API) has no public API.
  - Projects like OpenClaw reach it only by letting Codex app-server own the tool calls with OpenAI models ([OpenClaw docs](https://github.com/openclaw/openclaw/blob/main/docs/plugins/codex-computer-use.md)).
  - Whether non-OpenAI models can drive it is out of scope here. The runtime agent should answer that.
- **Ultrafast in the API**: `service_tier: "ultrafast"`, WebSockets recommended. Rate limits on Astra are 500K TPM (Build), 1M (Launch) and 5M (Grow). Astra Ultrafast is US-only residency ([API guide](https://developers.openai.com/api/docs/guides/ultrafast-mode)).

## Reception

- MacStories (Federico Viticci): "the best computer use feature I have ever tested in any LLM or desktop agent", "Codex's computer use plugin is the state of the art at the moment" ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/)).
  - He found it more precise than the Claude app and Perplexity's Personal Computer, which he says lean on screen recording plus AppleScript/osascript.
  - In a music test, Perplexity couldn't press Play and Codex could.
  - "Even the (kind of slow) GPT 5.4 is faster than Sky ever was", partly because Sky ran on Claude. Spark/Fast mode was "dramatically faster".
  - It is still slower than an expert human.
- OpenAI leaders: Sam Altman said it "feels even more useful than I expected". Alexander Embiricos called it "deep OS-level wizardry" ([Techmeme roundup](https://www.techmeme.com/260416/p40); secondary, quoted from search snippets because the page sits behind a bot check).
- Hacker News: the launch thread drew 1001 points and 559 comments ([HN](https://news.ycombinator.com/item?id=47796469)).
  - Commenters called "background GUI use" the killer feature ([comment](https://news.ycombinator.com/item?id=47797786)) and puzzled over how macOS allows input without raising windows ([comment](https://news.ycombinator.com/item?id=47799128), [reply on CGEventPostToPid](https://news.ycombinator.com/item?id=47809186)).
  - One user "got _really_ freaked out when a glowing cursor popped up" and started reading Slack on its own ([comment](https://news.ycombinator.com/item?id=47805282)). Another found LLMs "really slow for this task" ([comment](https://news.ycombinator.com/item?id=47796836)).
- People cloned it fast:
  - trycua's background driver got 192 points ([HN](https://news.ycombinator.com/item?id=47936312)).
  - `background-computer-use` claims "rough parity with OpenAI Codex Computer Use" ([repo](https://github.com/actuallyepic/background-computer-use)).
  - `mac-computer-use` is another clone ([HN](https://news.ycombinator.com/item?id=47821116)).
  - Qwen Code's design docs treat Codex's runtime as the reference ([doc](https://github.com/QwenLM/qwen-code/blob/main/docs/design/cua-app-oriented-actions.md)).
- Astra-era reviews: ChatPRD calls computer use "the real story", driving Excel, Unity and Blender. MindStudio reports an eBay comparison task done in under 2 minutes (secondary, via [search summaries of ChatPRD and MindStudio](https://www.chatprd.ai/how-i-ai/gpt-6-astra-review-hardware-3d-games-and-coding), [MindStudio](https://www.mindstudio.ai/blog/gpt6-astra-practical-use-cases); not opened directly).
- Usage burn: X trending summaries report Astra exhausting a $200 plan in about 12 hours of continuous work, and an OpenAI usage reset on 2026-09-07 ([X trending](https://x.com/i/trending/2096666307194474981), secondary).
- Head to head: I found no timed, controlled test of Codex CU against Claude, Gemini or Comet. theCLICK's comparison with Claude Cowork is qualitative ("It opens apps on your computer. It uses them. It does it fast") ([theCLICK](https://theclick.ai/vlog/codex-computer-use-vs-claude-cowork/)). Jason Liu notes CU is "usually the slowest" of the three Codex routes because of its observe, click, wait loop ([jxnl](https://jxnl.co/writing/2026/06/16/three-ways-codex-can-use-a-computer/)).

What people say makes it feel fast, in their words and OpenAI's:
- It doesn't steal your cursor, so the wait doesn't block you.
- It batches many actions per model turn.
- It reads the AX tree or DOM instead of scrolling and re-screenshotting.
- It uses fast models (Spark, Fast, Ultrafast).
- Harness work fixes "paper cuts" and makes waits event-driven.
- Appshots give it full context in one keystroke.

## Implications for our project

**The bar.**
- Accuracy should be near frontier CU numbers on long tasks: OSWorld 2.0 offline in the low 70s at about 40 min per hour-long task for Astra. Older OSWorld-Verified results sit around 75 to 79%.
- Speed should be roughly human pace on everyday GUI tasks. OpenAI claims "faster than the average human" and is aiming for expert speed.
- The target moves. OpenAI roughly doubled CU speed between April and September through model and harness changes together.
- Our accuracy will mostly come from the host model, so our harness has to avoid losing points. Harness speed is our part and we can measure it.

**What users value**, from the reception above:
1. Background operation on macOS, with no cursor or focus stealing and several agents at once.
2. Precision in native apps, which comes from AX-first targeting.
3. Fast perceived progress: few model turns per action and no screenshot-scroll loops.
4. Clear per-app consent, Esc to stop, and a visible cursor.
5. Reach into real apps and signed-in browsers.

People complain about Windows foreground takeover, crashes and capture bugs, surprise autonomy, and usage cost.

**Design lessons that carry over to any model.**
- Expose one code-execution tool (a JS REPL with a `cua`-style app object) over MCP, not just a coordinate `computer` tool. OpenAI's own API docs recommend code execution for its best model. It also cuts tool yields, which is where latency hides.
- Make observation AX-first and token-efficient, with screenshots on demand and per-app window binding. Add DOM/CDP for browsers.
- Use event-driven waits and keep a persistent session. Measure wall-clock time between "UI ready" and the next action.
- Build per-app approvals plus an automatic reviewer for consequential actions, judged on the actual UI state.
- Windows background mode is open territory. OpenAI hasn't shipped it.

**Bold idea.** Ari says OpenAI models are trained on OpenAI's harness. If our JS API looks close to the public shape of `cua` (`listApps`, `getApp`, per-app objects, compact element IDs), GPT models may perform better in our harness for free. We would then add adapters for Claude and Gemini, whose native computer tools are coordinate- and screenshot-based. This needs an eval before committing.

**What we can't copy.** Ultrafast is server-side inference. Our MCP server can still pass through to any fast tier the host model offers (e.g. `service_tier: "ultrafast"`, Claude fast mode), so the experience scales with the user's model choice.

**Evals.** Report success rate together with wall-clock time per task and model turns per task. That is how OpenAI frames its own claims (minutes per task, Mind2Web time-to-complete).

## Open questions

- Does Ultrafast measurably speed up computer-use tasks end to end? OpenAI has published nothing CU-specific, and the only hands-on Ultrafast tests were not CU tasks.
- Does Ultra spawn subagents that operate the desktop in parallel with separate cursors? Not documented.
- OpenAI hasn't reported an OSWorld-Verified score for Astra (it switched to OSWorld 2.0), and nobody has independently replicated its CU benchmarks. DataCamp notes that Astra's results are "highly harness-dependent" (secondary).
- I could not see the 2026-04-30 follow-up post that splits the speedup into "42% in 5.3-Spark / 16% in 5.5".
- Will the Agents API get local desktop control, or stay a hosted browser? Is the hosted environment priced separately?
- Is the `cua` JS API stable enough to target, and is it documented anywhere official? I found only third-party descriptions.
- When will Windows get background operation?

## Sources (primary first)

- OpenAI: [Sky acquisition](https://openai.com/index/openai-acquires-software-applications-incorporated/), [Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/), [GPT-5.4](https://openai.com/index/introducing-gpt-5-4/), [GPT-5.5](https://openai.com/index/introducing-gpt-5-5/), [GPT-5.6 Sol preview](https://openai.com/index/previewing-gpt-5-6-sol/), [GPT-5.6](https://openai.com/index/gpt-5-6/), [Ultrafast preview](https://openai.com/index/previewing-ultrafast/), [GPT-6 Astra](https://openai.com/index/gpt-6-astra/), [Agents API](https://openai.com/index/introducing-the-agents-api/), [GPT-6.1 Sol](https://openai.com/index/introducing-gpt-6-1-sol/), [DevDay 2026 recap](https://openai.com/index/devday-2026-recap/)
- Docs: [Computer Use](https://learn.chatgpt.com/docs/computer-use), [Speed](https://learn.chatgpt.com/docs/agent-configuration/speed), [Models](https://learn.chatgpt.com/docs/models), [Changelog](https://learn.chatgpt.com/docs/changelog), [Browser](https://learn.chatgpt.com/docs/browser), [Browser extension](https://learn.chatgpt.com/docs/chrome-extension), [API computer use](https://developers.openai.com/api/docs/guides/tools-computer-use), [Agents API computer use](https://developers.openai.com/api/docs/guides/agents-api/tools/computer-use), [Ultrafast API](https://developers.openai.com/api/docs/guides/ultrafast-mode), [API pricing](https://developers.openai.com/api/docs/pricing)
- openai/codex: [bundled_hooks.rs](https://github.com/openai/codex/blob/main/codex-rs/plugin/src/bundled_hooks.rs), [mcp.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/mcp.rs), [features/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/features/src/lib.rs), [computer_use.rs](https://github.com/openai/codex/blob/main/codex-rs/config/src/computer_use.rs), [guardian node_repl policy](https://github.com/openai/codex/blob/main/codex-rs/prompts/templates/guardian/node_repl_policy.md), [PR #51253](https://github.com/openai/codex/pull/51253), issues [#20851](https://github.com/openai/codex/issues/20851), [#49680](https://github.com/openai/codex/issues/49680), [#50823](https://github.com/openai/codex/issues/50823), [#51022](https://github.com/openai/codex/issues/51022), [#52654](https://github.com/openai/codex/issues/52654)
- OpenAI staff: Ari Weinstein on X ([Apr 16](https://x.com/AriX/status/2044829770228351423), [Apr 30](https://x.com/AriX/status/2049932746567598472), [May 29](https://x.com/AriX/status/2060506125011911147), [Sep 4](https://x.com/AriX/status/2095671700771762341)), [OpenAI Ultrafast post](https://x.com/OpenAI/status/2104993966043320759), [OpenAIDevs](https://x.com/OpenAIDevs/status/2104996045482778973), [Latent Space DevDay episode with Ari Weinstein and Nikunj Handa](https://www.latent.space/p/devday-2026), [OpenAI video "Computer use in Codex" (2026-05-12)](https://www.youtube.com/watch?v=D_FCYsshMI4)
- Secondary: [MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/), [VentureBeat](https://venturebeat.com/technology/openais-gpt-6-1-sol-offers-astra-like-performance-at-1-5th-price-a-new-ultrafast-tier-clocks-at-300-tokens-per-second), [The Decoder](https://the-decoder.com/openai-expands-codex-and-its-api-at-devday-with-security-scans-a-decisions-api-and-ultrafast/), [MindStudio](https://www.mindstudio.ai/blog/codex-ultrafast-pricing), [Nate Herk](https://www.linkedin.com/posts/nateherkelman_i-tested-codexs-500mo-ultrafast-what-activity-7511478636235939841-yL-u), [Jason Liu](https://jxnl.co/writing/2026/06/16/three-ways-codex-can-use-a-computer/), [OpenClaw docs](https://github.com/openclaw/openclaw/blob/main/docs/plugins/codex-computer-use.md), [Qwen Code design doc](https://github.com/QwenLM/qwen-code/blob/main/docs/design/cua-app-oriented-actions.md), [clodex #272](https://github.com/bman654/clodex/issues/272), [HN launch thread](https://news.ycombinator.com/item?id=47796469)
