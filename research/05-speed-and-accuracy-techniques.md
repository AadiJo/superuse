# Speed and accuracy techniques for computer-use agents

Research date: 2026-10-11. Scope: what makes computer-use (CU) agents faster and more accurate, with measured evidence, organized by where time and errors come from in the observe, think, act, verify loop. Numbers come from primary sources (arXiv, vendor docs, repos) unless marked. Labels used below:

- "(vendor claim)" means the company selling the product measured it.
- "(secondary)" means I only found the number in a write-up about the source, not the source itself.
- "(aggregator)" means a leaderboard site that mixes self-reported and independent runs.
- "(unverified)" means I could not confirm it at all.

## TL;DR, ranked by expected impact

1. **The model call is the bottleneck, so cut round trips first.** Planning, reflection and judging LLM calls take 75-96% of task wall time in measured agents. Screenshots and input take about 1-3%, grounding 2-4% ([OSWorld-Human, MLSys 2026](https://arxiv.org/html/2506.16042)). Every technique that removes an LLM turn beats every technique that speeds up capture or clicking.
2. **Batching and code-as-action is the biggest proven lever.** On OSWorld 2.0, batched tool calls cut Claude Opus 4.8's turns from 190 to 103 and raised binary success from 18.5% to 20.6% at lower cost ([OSWorld 2.0, Table 3](https://arxiv.org/html/2606.29537v1)). Agent S3 halved LLM calls and cut time per task 62% mostly by removing a planning layer ([arXiv 2510.02250](https://arxiv.org/html/2510.02250)). OpenAI now recommends code execution over its native `computer` tool for GPT-6 Astra ([OpenAI docs](https://developers.openai.com/api/docs/guides/tools-computer-use)). Codex's single `js` tool is the right shape.
3. **Use program state before pixels.** Agents that act through APIs, files, shell, DOM or app object models finish in far fewer steps:
   - UFO2 with o1 used 58.5% fewer steps and gained +8.2 points from a handful of Office APIs ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v1)).
   - StateAct gained +6.3 points binary on OSWorld 2.0 at about 9x lower cost ([arXiv 2607.22798](https://arxiv.org/abs/2607.22798)).
   - ActionEngine was 3.2x faster and 8x cheaper than Claude Code on WebArena ([arXiv 2602.20502](https://arxiv.org/html/2602.20502)).
   - The GUI still has to be there as the fallback. StateAct's code-only variant scored below the screenshot baseline.
4. **Make the accessibility tree the default observation, but fast, compact and diffed.**
   - A naive tree dump costs 3-26 s per step and thousands of tokens ([OSWorld-Human](https://arxiv.org/html/2506.16042)). An optimized macOS walker does a Chrome tree in 31 ms ([mac-control-mcp PR #18](https://github.com/AdelElo13/mac-control-mcp/pull/18)).
   - 52.9% of within-page web steps change nothing in the DOM ([Region4Web](https://arxiv.org/abs/2605.07134)), so sending diffs or "unchanged" saves a lot.
   - Keep screenshots for canvas, custom-drawn and visual-state tasks. The UIA plus vision hybrid beats either alone ([UFO2](https://arxiv.org/html/2504.14603v1)).
5. **Replace fixed sleeps with event-driven settle detection, and verify inside the same call.** OSWorld 2.0's harness pauses 3 s after every action. At 100-300 turns that is roughly 5-15 minutes of pure sleep per task (my arithmetic). A pixel-settle wait matched a 1.0 s sleep's reliability in 0.65 s and beat a 0.2 s sleep, which dropped 4 of 5 keystrokes ([quern PR #101](https://github.com/quern-dev/quern/pull/101)). Inside code mode, "act, wait for settle, check the expected change" becomes one tool call instead of three model turns.
6. **Size images per provider, and zoom instead of sending huge screenshots.**
   - Each screenshot costs about 1,000-1,800 tokens on Claude, and up to 4,784 on Opus 4.7+ high-res ([Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). Browser Use measured about 0.8 s of extra inference latency per screenshot ([Browser Use](https://browser-use.com/posts/speed-matters)).
   - Region zoom adds 5-19 points on ScreenSpot-Pro for open grounders ([ZoomClick](https://arxiv.org/html/2512.05941), [MAI-UI](https://arxiv.org/pdf/2512.22047)). Claude now ships a `zoom` member tool on by default.
7. **Caching and replay give the biggest speedups on repeated tasks, but naive replay is lossy.**
   - Measured warm-replay speedups: 8.5-13x ([PreAct](https://arxiv.org/html/2606.17929)) and about 60% less time with 96% fewer tokens ([EchoPath](https://arxiv.org/html/2609.16635v1)). Vendors claim 2.3x to 100x.
   - Replays that skip verification silently fail. All 48 of PreAct's ungated WebArena warm replays scored 0.
   - A budget-matched study found that in-prompt memory and skill modules often don't beat simply giving the base agent more steps ([arXiv 2606.15017](https://arxiv.org/abs/2606.15017)).
   - Code mode makes replay cheap to build, because every successful action is already a program.
8. **A separate grounding model is now optional for frontier models, but still valuable for open-weight and text-only ones.**
   - Frontier models reportedly score 85-93% on ScreenSpot-Pro natively ([BenchLM, aggregator](https://benchlm.ai/benchmarks/screenspot-pro)).
   - Open 8B grounders sit around 58-68%: UI-Venus-1.5-8B 68.4% ([README](https://github.com/inclusionAI/UI-Venus/blob/UI-Venus-1.5/README.md)), MAI-UI-8B 65.8%, Holo2-8B 58.9%.
   - Adding a grounder lifted GPT-4o from 5% to 27% on OSWorld ([Jedi](https://arxiv.org/abs/2505.13227)).
9. **Model-side levers mostly belong to the MCP client, not our server.** Prompt caching cuts time-to-first-token by up to 80-85% ([Anthropic](https://www.anthropic.com/news/prompt-caching), [OpenAI cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201)). Lower effort sometimes costs nothing: Sonnet 4.6 at medium effort had higher binary success than at max on OSWorld 2.0. What our server controls is result size, determinism (stable bytes help caching), and how many turns a task needs.
10. **Speculation and routing are real but second-order today.**
    - Speculative next actions gave up to 20% latency reduction in the original paper ([arXiv 2510.04371](https://arxiv.org/abs/2510.04371)) and only 1.05x in a later live test ([arXiv 2607.12236](https://arxiv.org/html/2607.12236)).
    - Small/large routing projected up to 78% cost savings within 2 points of accuracy ([AVR](https://arxiv.org/abs/2603.12823)).
    - Build these after the basics.

## Technique table

Speed and accuracy effects are the best evidence I found, not guarantees. "Cost" is implementation cost for us.

| Technique | Loop stage | Speed effect | Accuracy effect | Evidence | Cost |
|---|---|---|---|---|---|
| Code-mode tool with batched actions | Act | Turns about halved: 190 to 103 (Opus 4.8), 318 to 161 (Opus 4.7) | +2.1 to +4.3 pts binary on OSWorld 2.0. CodeAct up to +20% success with about 30% fewer turns | [OSWorld 2.0](https://arxiv.org/html/2606.29537v1), [CodeAct](https://arxiv.org/abs/2402.01030), [Agent S3](https://arxiv.org/html/2510.02250) | Medium (sandboxed JS REPL) |
| Flat policy, no separate planner/reflector LLM calls | Think | 52% fewer LLM calls, 62% less time per task | +13.8 pts (48.8 to 62.6) | [Agent S3](https://arxiv.org/html/2510.02250) | Client design, free for us |
| API / CLI / shell / MCP actions next to GUI | Act | -58.5% steps (UFO2 + o1), 3.2x faster than Claude Code (ActionEngine), about 9x cheaper (StateAct) | +6 to +8 pts (UFO2), +6.3 pts binary (StateAct), o3 8.3 to 20.4% at 15 steps (OSWorld-MCP) | [UFO2](https://arxiv.org/html/2504.14603v1), [StateAct](https://arxiv.org/abs/2607.22798), [ActionEngine](https://arxiv.org/html/2602.20502), [OSWorld-MCP](https://arxiv.org/html/2510.24563v2) | Medium-high, per app |
| Compact, window-scoped accessibility tree with element refs | Observe | No image tokens. Avoids about 0.8 s per screenshot | Clicking by ref removes grounding error. The hybrid with vision is best | [UFO2](https://arxiv.org/html/2504.14603v1), [Browser Use](https://browser-use.com/posts/speed-matters) | Medium-high per OS |
| Fast tree extraction (bulk reads, caps, IPC timeouts) | Observe | Chrome tree 1,177 ms to 31.5 ms. Naive OSWorld tree 3-26 s | Prevents target-app freezes (10-13 s IntelliJ freezes reported) | [mac-control-mcp #18](https://github.com/AdelElo13/mac-control-mcp/pull/18), [Codex #38873](https://github.com/openai/codex/issues/38873), [UIA caching](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients) | Medium |
| Observation diffs / suppress unchanged | Observe | History diffs use about 1/3 the tokens. PageDigest -43% observation tokens | Diff history matches or beats full history for some models. PageDigest +2.3 pts | [Read More, Think More](https://arxiv.org/html/2604.01535), [Region4Web](https://arxiv.org/abs/2605.07134) | Low-medium |
| Semantic actions (UIA Invoke/SetValue, AX press) | Act | About 170 ms per op on Windows | Practitioners report less flakiness than synthetic input. No controlled study found | [winappCli #1053](https://github.com/microsoft/winappCli/pull/1053), [windows-mcp-server](https://github.com/deploymenttheory/windows-mcp-server) | Medium |
| Event or pixel settle detection instead of sleeps | Verify | 0.65 s vs a 1.0 s sleep that was needed for reliability | 5/5 keystrokes landed vs 1/5 with a 0.2 s sleep | [quern #101](https://github.com/quern-dev/quern/pull/101) | Low-medium |
| Action returns a change summary | Verify | Saves a re-observation turn | Catches popups and dropdowns the click opened (qualitative) | [Agent-E](https://arxiv.org/html/2407.13032v1) | Low |
| On-demand region zoom | Ground | One extra capture, only when needed | +5.6 (MAI-UI-32B), +7.9 (Holo2-235B), +19.1 (UI-Venus-72B) pts on ScreenSpot-Pro | [MAI-UI](https://arxiv.org/pdf/2512.22047), [Holo2](https://huggingface.co/Hcompany/Holo2-235B-A22B), [ZoomClick](https://arxiv.org/html/2512.05941) | Low |
| Optional local grounding model | Ground | Grounding is 1.8-3.9% of task time on one A6000 | GPT-4o 5% to 27% on OSWorld with Jedi-7B | [OSWorld-Human](https://arxiv.org/html/2506.16042), [Jedi](https://arxiv.org/abs/2505.13227) | Medium (GPU) |
| Per-provider screenshot sizing, JPEG, crop | Model | 1280-wide JPEG capture in 38 ms. Fewer image tokens | Too small hurts. Opus 4.7's higher resolution added +4.4 pts on ScreenSpot-Pro (secondary) | [Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool), [mac-control-mcp #18](https://github.com/AdelElo13/mac-control-mcp/pull/18) | Low |
| Keep bulky data out of context (filter in code) | Model | 150k to 2k tokens in Anthropic's example | Neutral to positive | [Anthropic](https://www.anthropic.com/engineering/code-execution-with-mcp), [Cloudflare](https://blog.cloudflare.com/code-mode/) | Free with code mode |
| Cache-friendly, deterministic results | Model | Up to 80-85% lower TTFT on long cached prefixes | Neutral | [Anthropic](https://www.anthropic.com/news/prompt-caching), [OpenAI](https://developers.openai.com/cookbook/examples/prompt_caching_201) | Low |
| Guarded record and replay | Cache | 8.5-13x warm (PreAct), about 60% less time (EchoPath), 10-100x claimed (Stagehand) | Risky without a verify gate: ungated replays scored 0 on WebArena | [PreAct](https://arxiv.org/html/2606.17929), [EchoPath](https://arxiv.org/html/2609.16635v1), [Stagehand](https://docs.stagehand.dev/v3/best-practices/caching) | Medium-high |
| Workflow or skill memory in the prompt | Cache | About 2 fewer steps (AWM) | +51% relative on WebArena, but budget-matched vanilla ties it | [AWM](https://arxiv.org/abs/2409.07429), [arXiv 2606.15017](https://arxiv.org/abs/2606.15017) | Medium |
| Speculative multi-action from one observation | Act | Up to 51.5% fewer LLM calls (UFO2 on OSWorld-W) | Neutral to +2 pts | [UFO2](https://arxiv.org/html/2504.14603v1) | Covered by code mode |
| Speculative next-action execution | Model | Up to 20% (paper), 1.05x (live replication) | Lossless by design | [Speculative Actions](https://arxiv.org/abs/2510.04371), [Speculate with Memory](https://arxiv.org/html/2607.12236) | High |
| Small/large model routing | Model | Up to 78% cost (projected) | Within 2 pts | [AVR](https://arxiv.org/abs/2603.12823) | Client-side |
| Set-of-mark overlays | Observe | Fewer steps in some apps (Writer 50 to 16) | Mixed. SeeAct found SoM poor for GPT-4V on the web | [OSWorld-Human](https://arxiv.org/html/2506.16042), [SeeAct](https://arxiv.org/html/2401.01614) | Low |
| History compression and screenshot pruning | Model | Flattens per-step latency growth (later steps up to 3x slower) | Keep recent screenshots. Use text diffs for older steps | [OSWorld-Human](https://arxiv.org/html/2506.16042), [Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) | Low |

## Detailed findings

### 1. Where the time and errors actually go

**OSWorld-Human** ([arXiv 2506.16042 v2, MLSys 2026](https://arxiv.org/html/2506.16042)) is the best measured breakdown I found. It profiled Agent S2 and GTA1 on 39 OSWorld tasks:

- **Agent S2** (GPT-4.1 planner, UI-TARS-7B grounder): planning 53.5%, reflection 33.6%, grounding 3.9%, retrieval 3.1%, screenshot 1.7%, action execution 1.6% of task time.
- **GTA1** (o3 planner and judge, GTA1-7B grounder): planning 74.6%, judging 22.5%, grounding 1.8%, screenshot 0.4%, action 0.7%.
- **Why:** prefill dominates, because each prompt carries the full step history. Later steps can take 3x longer than early ones, and cumulative cost grows quadratically with step count. GTA1 averaged about $2.43 per task, with planning at about 87% of the cost.
- **Grounding failures:** in 23% of failures the plan was right and the click coordinates were wrong. These led to up to about 30 extra steps. In failed tasks over 50 steps, 66% of steps were wasted in grounding loops. One Chrome loop cost $8.47 and 27 minutes.
- **Accessibility tree cost:** building the a11y tree took 3-26 s per step in OSWorld's implementation (LibreOffice was worst), capped at 10k tokens.
- **Step counts by observation type (S2, one task per app):** adding the tree raised step counts for Writer (21 to 50) and Calc (14 to 50). Adding set-of-mark on top brought them down to 16 and 10.
- **Agents vs humans:** humans need 2.8-13.2 single actions per task, or 2.0-4.5 if you group actions. The best leaderboard agent's 41.4% success drops to 15.6% on the efficiency-weighted score (WES).
- **The authors' recommendations:**
  - Group several actions per observation, including conditional ones.
  - Detect loops and roll back.
  - Improve grounding.
  - Compress history.
  - Use prefix caching and speculative decoding.

**OSWorld 2.0** ([arXiv 2606.29537](https://arxiv.org/html/2606.29537v1)) has 108 long tasks. Humans need a median of 1.6 hours per task, and agents average about 300 steps.

- **Budget breakdown:** visual grounding 15.5%, tool-semantics reasoning 13.8%, information extraction 12.8%, execution 10.1%, verification 9.8%.
- **Action mix:** GUI clicks 27.4%, terminal 24.7%, hotkeys 14.0%, waiting 13.9%.
- **Failure modes:** stale-UI timing (acting on a screen that already changed), skipped verification ("submission is not verification"), and losing early facts kept only in compressed reasoning.
- **Pacing:** the harness pauses 3 s after every action.

**Agent S3** ([arXiv 2510.02250](https://arxiv.org/html/2510.02250)) shows the payoff of removing model calls. Dropping the manager-worker hierarchy alone took GPT-5 from 73.6 LLM calls and 2,367 s per task to 41.4 calls and 1,133 s. Success rose from 48.8% to 57.9%. Adding the coding agent brought it to 35.1 calls, 891 s and 62.6%.

**Other data points:**

- **On-device:** with Qwen3-VL-2B on a phone, inference is 77% of step latency. Prefill is 2.6 s, decoding 6.0 s, and waiting for the app to respond 2.5 s ([PastForward](https://arxiv.org/html/2609.32166)).
- **Browser agents:** Browser Use reported 68 s per task vs 225-330 s for vendor CU APIs on Online-Mind2Web, at about 3 s per step (vendor claim, Oct 2025, [Browser Use](https://browser-use.com/posts/speed-matters)). Google reported about 225 s median for Gemini 2.5 Computer Use on the same harness ([MarkTechPost summary](https://www.marktechpost.com/2025/10/08/google-ai-introduces-gemini-2-5-computer-use-preview-a-browser-control-model-to-power-ai-agents-to-interact-with-user-interfaces/)).
- **Scores are near saturation on short tasks.** Top OSWorld-Verified scores are now 80-86%, mostly self-reported ([BenchLM aggregator](https://benchlm.ai/benchmarks/osworld-verified), [Steel](https://leaderboard.steel.dev/leaderboards/osworld/)). Human baselines are 72-84%. Wall time, cost and long-horizon reliability are where systems now differ.

**My read:** for an MCP server we don't choose the model. So our biggest levers are (a) letting one model turn do more work, (b) making each turn's input smaller and cache-stable, and (c) making actions reliable enough that the model never burns turns on grounding loops.

### 2. Observation

#### Accessibility tree vs screenshot vs hybrid

- **Original OSWorld (2024 models)** ([arXiv 2404.07972](https://arxiv.org/html/2404.07972)): a text-only a11y tree beat screenshots for the models of the time. GPT-4 scored 12.24% with the tree, and GPT-4V 5.26% with screenshots. Tree plus screenshot (12.17%) and set-of-mark (11.77%) were similar for GPT-4V.
- **UFO2 on Windows** ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v1)):
  - Over 62% of WAA failures were control-detection failures. UIA misses controls in apps like LibreOffice.
  - A hybrid of UIA plus OmniParser-v2 beat UIA-only and vision-only. With o1 on OSWorld-W it scored 24.5% UIA-only, 14.3% vision-only and 28.6% hybrid.
  - Visual detections overlapping a UIA control (IoU above 10%) were dropped as duplicates.
- **Browser Use** navigates mainly from DOM text and takes screenshots only when needed, because each screenshot added about 0.8 s of inference latency ([vendor](https://browser-use.com/posts/speed-matters)).
- **Codex Computer Use on macOS** reads the AX tree of any app and clicks by element. MacStories found it faster than earlier screenshot-heavy tools but slower than a skilled human ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/)). A community Linux port returns a compact AT-SPI projection and suppresses an unchanged projection on repeated reads ([docs](https://github.com/ilysenko/codex-desktop-linux/blob/main/docs/linux-computer-use.md)).
- **Counterpoint, richer is sometimes better:** [Read More, Think More (arXiv 2604.01535)](https://arxiv.org/html/2604.01535) found that weaker models do better with compact a11y trees. Stronger models with larger thinking budgets do better with fuller HTML, because they use layout cues for grounding. Over-pruning can hurt frontier models. Expose a detail knob instead of one fixed format.

#### Token cost per observation type

| Observation | Typical tokens | Source |
|---|---|---|
| Claude screenshot, pre-Opus-4.7 models | About w*h/750, capped near 1.15 MP or 1568 px long edge. About 1,000-1,800 per CU screenshot | [Claude vision docs](https://docs.claude.com/en/docs/build-with-claude/vision), [CU docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |
| Claude screenshot, Opus 4.7 and later | Up to 4,784 visual tokens (ceil(w/28) * ceil(h/28)), 2576 px long edge. The API rejects oversize images instead of downscaling | [CU docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |
| Gemini 3 image | Configurable: 280 / 560 / 1120 / 2240 tokens (low to ultra_high) | [Gemini media resolution](https://ai.google.dev/gemini-api/docs/media-resolution) |
| OpenAI screenshot | `detail: "original"` recommended for CU. About 1,566 tokens for 1440x900 (secondary estimate) | [OpenAI CU guide](https://developers.openai.com/api/docs/guides/tools-computer-use) |
| OSWorld filtered a11y table | 6,000 tokens covers about 90% of observations. Raw XML is "millions" of tokens | [OSWorld](https://arxiv.org/html/2404.07972) |
| WebArena a11y tree per step | 5,767-7,158 tokens depending on model tokenizer. 3,207-4,521 with PageDigest | [Region4Web](https://arxiv.org/abs/2605.07134) |
| Playwright MCP aria snapshot | 2k-5k simple pages, 20k+ complex SPAs (practitioner reports, unverified) | [summary of reports](https://bug0.com/blog/playwright-cli-vs-playwright-mcp-ai-browser-testing-2026) |
| Raw DOM | 10k-100k typical, up to about 800k (Agent-E). Exceeded a 128k context in 42% of Online-Mind2Web pages | [Prune4Web](https://arxiv.org/abs/2511.21398), [D2Snap](https://arxiv.org/html/2508.04412v4) |

The takeaway is that a scoped, filtered tree is roughly the same token cost as one screenshot. A full-window tree of a complex app can cost several screenshots' worth. So scoping and diffing matter more than the format choice.

#### Tree pruning and compaction formats

- **OSWorld** converts the raw tree to a tab-separated table: tag, name, text, position, size ([arXiv 2404.07972](https://arxiv.org/html/2404.07972)).
- **AgentOccam** merges static text into the interactive element it labels. It keeps only the "pivotal" nodes the agent names, plus their ancestors, siblings and descendants. With the matching action-space cleanup, that gave +26.6 points (+161%) over a plain agent on WebArena ([arXiv 2410.13825](https://www.alphaxiv.org/abs/2410.13825)).
- **Region4Web / PageDigest** groups the AX tree into functional regions and sends a per-page digest that persists across steps. Observation tokens fell 43% (6,437 to 3,671) and success rose 2.3 points on average across GPT-5.1, Gemini 3.1 Flash-Lite, DeepSeek-V3.2 and Qwen3.5-27B ([arXiv 2605.07134](https://arxiv.org/abs/2605.07134)).
- **D2Snap** downsamples the DOM to a token budget. It reached 73% vs a 67% grounded-screenshot baseline, not statistically significant, and over-aggressive downsampling fell to 42% ([arXiv 2508.04412 v4](https://arxiv.org/html/2508.04412v4)).
- **Prune4Web** has the LLM write a small scoring program that filters the DOM to about 20 candidates. That is 25-50x fewer candidates, and low-level grounding accuracy rose from 46.8% to 88.3% ([arXiv 2511.21398](https://arxiv.org/abs/2511.21398)). Code mode makes this pattern free: the model can query and filter the tree in JS instead of reading it.
- **Other reported cuts:** FocusAgent cut the AX tree by more than 50%, often more than 80%. LineRetriever cut observations by 61-73% (both via the [efficiency survey, arXiv 2609.02309](https://arxiv.org/html/2609.02309v1)).
- **Viewport-only trees:** I found no controlled study isolating "visible only" against "full window". The Linux Codex port caps traversal at 2,000 nodes and depth 64 and warns that unscoped desktop trees can exhaust context. Visible-only filtering is a sensible default with a flag to expand (design judgment, not measured).

#### Set-of-mark and OCR

- **Set-of-mark:** results are mixed for older models. SeeAct found SoM-style image annotation "not effective" for GPT-4V on the web, while textual choices did best ([arXiv 2401.01614](https://arxiv.org/html/2401.01614)). In OSWorld, SoM helped GPT-4V and hurt GPT-4o ([arXiv 2404.07972](https://arxiv.org/html/2404.07972)). OSWorld-Human saw SoM sharply reduce steps in Writer and Calc. My read: SoM is a workaround for weak grounding. Clicking by tree element ID gives the same benefit with no image annotation, so treat SoM as a fallback for apps without a usable tree.
- **OCR:** this is a cheap grounding aid for text targets.
  - Agent S2's textual (OCR) grounding expert: removing it lowered subtask success from 70.6% to 65.2% ([arXiv 2504.00906](https://arxiv.org/pdf/2504.00906)).
  - OmniParser v2 combines a YOLO detector, Florence-2 captions and OCR. It runs at 0.6 s per frame on an A100 and 0.8 s on a 4090, and lifted GPT-4o from 0.8% to 39.6% on ScreenSpot-Pro ([MarkTechPost summary](https://www.marktechpost.com/2025/02/18/microsoft-ai-releases-omniparser-v2-an-ai-tool-that-turns-any-llm-into-a-computer-use-agent/)).
  - Native macOS OCR measured 220 ms at the fast level and about 620-760 ms at the default level ([mac-control-mcp #18](https://github.com/AdelElo13/mac-control-mcp/pull/18)).

#### Diffing observations between steps

- Region4Web measured 15,394 Mind2Web action pairs. 78% stay on the same page, and of those, 52.9% change zero DOM elements and 74.4% change under 5% ([arXiv 2605.07134](https://arxiv.org/abs/2605.07134)).
- Read More, Think More found character diffs of previous observations use about one third of the tokens of full history, and match or beat full history for some models ([arXiv 2604.01535](https://arxiv.org/html/2604.01535)).
- Practical implementations:
  - The Codex Linux port's "unchanged projection" suppression.
  - settled-computer, which omits an image if the screen is unchanged and the model saw one in the last 45 s ([listing](https://glama.ai/mcp/servers/Remote-Skills/settled-computer), unverified details).
  - OdoBot tracks progress by URL and network traffic instead of resending history, and uses 44-80% fewer tokens than Agent-E and WebVoyager ([arXiv 2609.13491](https://arxiv.org/abs/2609.13491)).

#### Making tree extraction fast

The 3-26 s OSWorld figure is an implementation problem, not a law. The fixes are known:

- **macOS:**
  - Read all of an element's attributes in one `AXUIElementCopyMultipleAttributeValues` call. One Chrome walk went from 3,774 IPC calls (about 65 ms) to 422 (about 26 ms). With caching fixes, `get_ui_tree` went from 1,177 ms to 31.5 ms ([mac-control-mcp #18](https://github.com/AdelElo13/mac-control-mcp/pull/18)). The open-source Cua driver batches attribute reads and ranged children for about 3x less IPC ([trycua/cua #1757](https://github.com/trycua/cua/pull/1757)).
  - Set a short `AXUIElementSetMessagingTimeout`, cap nodes and depth, and track visited nodes, since the AX graph has cycles.
  - Electron and Chromium apps need `AXManualAccessibility` set once.
  - Unbounded walks can freeze the target app. One report has Codex's traversal freezing IntelliJ for 10-13 s ([openai/codex #38873](https://github.com/openai/codex/issues/38873)).
- **Windows:** UIA `CacheRequest` bulk-fetches properties and patterns for a subtree in one cross-process call instead of one call per property ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-cachingforclients)). Microsoft's winapp CLI measured 170 ms median for `invoke`, 163 ms for `set-value`, 198 ms for `search` and 230 ms for `screenshot`, including process start ([winappCli #1053](https://github.com/microsoft/winappCli/pull/1053)). A persistent helper avoids that process start.
- **Events instead of polling:** UIA StructureChanged/PropertyChanged events and macOS AXObserver notifications can refresh only what changed. Both have gaps (missing or spurious events, Chromium floods), so use them as hints that trigger a scoped re-read, not as the source of truth ([UIA events overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-eventsoverview)).

#### When screenshots are actually needed

From the evidence:

- **Canvas, custom-drawn, game or DirectX UIs** where the tree is empty or wrong. PreAct's BrowserDraw failed because the canvas is absent from the tree ([arXiv 2606.17929](https://arxiv.org/html/2606.17929)). UFO2 recovered 10-25% of UIA failures with vision.
- **Visual state the tree doesn't encode:** chart contents, image editing, layout checks, CAD geometry. OSWorld 2.0 lists FreeCAD and video timelines as failure domains.
- **Dynamic content:** video, toasts, animations. AOI added continuous keyframe capture plus narration and gained 9-48 points on dynamic browser tasks ([arXiv 2606.29472](https://arxiv.org/pdf/2606.29472)). It also lowered token cost 15-50% because steps fell about 50%, but wall time rose for fast models.
- **Verification of visual outcomes** and the first look at an unfamiliar app.
- **Do not go code-only.** StateAct's code-only variant scored 45.9% partial vs 54.8% for the screenshot baseline and 61.6% for the hybrid ([arXiv 2607.22798](https://arxiv.org/abs/2607.22798)). Its GUI subagent was needed on 28 of 108 tasks but only for 1.1% of steps.

### 3. Action

#### Code as action and batching

- **CodeAct** ([arXiv 2402.01030](https://arxiv.org/abs/2402.01030)): code actions beat JSON or text tool calls for 12 of 17 LLMs. GPT-4 scored 74.4% vs 53.7% on M3ToolEval with up to 30% fewer turns. Open models gained much less, so code mode is not a fix for weak reasoning.
- **Anthropic, "Code execution with MCP"** (Nov 2025, [post](https://www.anthropic.com/engineering/code-execution-with-mcp)): a Drive-to-Salesforce workflow went from 150,000 to 2,000 tokens. Their techniques: progressive tool discovery, filtering large results in code, loops and polling in code, state in files, saved skills.
- **Cloudflare Code Mode** ([post](https://blog.cloudflare.com/code-mode/)): one TypeScript-executing tool instead of many tools, an 81% token cut. The whole Cloudflare API fits in two tools and under 1,000 tokens ([Dynamic Workers](https://blog.cloudflare.com/dynamic-workers/)). V8 isolates start in a few ms, about 100x faster than containers.
- **OpenAI** now says "For GPT-6 Astra, we recommend code execution." The native `computer` tool also takes an ordered `actions` array per call ([guide](https://developers.openai.com/api/docs/guides/tools-computer-use)).
- **Anthropic's `computer_toolset_20260801`** supports batch actions. Blocks run in order, stop at the first failure, and later blocks are marked not executed. The docs suggest attaching a screenshot to the last result of a batch to save a round trip ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- **OSWorld 2.0, batched vs single tool calls** (500 steps):
  - Opus 4.8: 103 vs 190.5 turns, binary 20.6 vs 18.5, partial 54.8 vs 49.3, about $72 vs $76 per task.
  - Opus 4.7: 160.7 vs 318.4 turns, binary 18.2 vs 13.9.
  - The paper says the turn-efficiency frontier is "set by batching, not by taking more steps" ([Table 3](https://arxiv.org/html/2606.29537v1)).
- **UFO2's speculative multi-action** (several predicted actions per LLM call, each checked against live control state) cut steps 10-51.5% with equal or slightly better success ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v1)).
- **Inside a CU agent:** CoAct-1 averaged 10.15 steps vs 15.22 for GTA-1 by handing file and data work to a coding agent ([arXiv 2508.03923](https://arxiv.org/html/2508.03923v1)). UI-TARS-2 with its GUI-SDK scored 29.6% on BrowseComp-en vs 7.0% GUI-only ([arXiv 2509.02544](https://arxiv.org/html/2509.02544v1)).

Codex's design (persistent Node REPL, a `cua` API, element-index clicks, several actions per call) matches all of this. The key behaviors to keep: the model can loop, branch and assert in one call, and large data stays in REPL variables instead of the context.

#### Semantic actions vs coordinate clicks

Accessibility patterns act on the control directly: UIA Invoke/Value/Toggle/ExpandCollapse, AX press/setValue, AT-SPI actions. So they don't depend on focus, occlusion or DPI ([windows-mcp-server README](https://github.com/deploymenttheory/windows-mcp-server)). The Codex Linux port prefers native AT-SPI click/press/toggle for plain left clicks to avoid toolkit scaling guesswork.

Measured per-op latency is about 150-200 ms on Windows including process start ([winappCli #1053](https://github.com/microsoft/winappCli/pull/1053)). I found no controlled study comparing task success for pattern actions vs synthetic clicks. That gap is worth filling with our own eval.

Caveats:

- Some apps expose no patterns.
- Invoke on a menu item can behave differently from a real click.
- In winapp's agent benchmark, a minimized window broke the UIA path. The UIA run took 36.9 s and 10 turns vs 15.0 s and 3 turns without it.

So keep a fallback chain: pattern action, then keyboard, then coordinate click with optional grounding.

#### Keyboard-first

- Anthropic's docs advise keyboard shortcuts for dropdowns and scrollbars that are hard to manipulate with the mouse ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- In OSWorld 2.0, hotkeys were 14% of agent actions.
- The only controlled evidence I found is for mobile "shortcuts" (predefined app actions, not keyboard hotkeys). They raised success from 35.2% to 63.3% and pushed step counts below the human path ([MAS-Bench, arXiv 2509.06477](https://arxiv.org/pdf/2509.06477)).
- Keyboard-first is plausible and cheap to support (expose `key()` with chords and repeat), but unmeasured on desktop.

#### API, CLI and MCP shortcuts instead of GUI

- **UFO2 GUI+API** on 27 Office tasks: GPT-4o went from 16.3% to 22.4% and o1 from 16.3% to 24.5%. o1's steps fell from 16.0 to 6.6. Exporting a CSV took 5 GUI steps vs 1 API call ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v1)).
- **OSWorld-MCP** (ICLR 2026; 158 tools, 25 of them distractors) ([arXiv 2510.24563](https://arxiv.org/html/2510.24563v2)):
  - o3 at 15 steps went from 8.3% to 20.4%. Claude 4 Sonnet at 50 steps went from 40.1% to 43.3%, with average steps falling from 24.7 to 20.1.
  - Even the best model used tools on only 36.3% of tool-beneficial tasks.
  - Listing all 158 tools without retrieval dropped Gemini's accuracy from 20.5% to 15.5%.
  - Multi-round tool tasks stayed hard.
  - The ICLR version reports slightly different numbers.
- **AXIS** (ACL 2025): API-first in Word cut task time by 65-70% ([arXiv 2409.17140](https://arxiv.org/abs/2409.17140)).
- **StateAct** (Opus 4.8 on OSWorld 2.0): acting on files, backends and DOM through code with a GUI subagent gave 26.9% binary / 61.6% partial vs 20.6% / 54.8% screenshot-only, at about 9x lower cost ([arXiv 2607.22798](https://arxiv.org/abs/2607.22798)).
- **GPT-5.5 already does this on its own.** It used code, API or file actions for 78% of its OSWorld 2.0 work vs 37% for Opus 4.7. The paper also flags that 33% of trajectories bypassed the visible UI, which matters for safety.

Implication: a code-mode server should expose the shell, the filesystem, and per-OS scripting bridges (AppleScript/JXA, PowerShell/COM, CDP for browsers) as part of the same API. Don't rely on separate MCP tools that models under-use. Tool selection gets worse as tool lists grow, so prefer discoverable namespaces in code over a long flat tool list.

### 4. Grounding

#### Small grounding models (ScreenSpot-Pro unless noted)

| Model | Size | ScreenSpot-Pro | OSWorld-G | Notes / source |
|---|---|---|---|---|
| OmniParser v2 + GPT-4o | 0.23B parser + LLM | 39.6 | n/a | 0.6 s/frame on A100 ([summary](https://www.marktechpost.com/2025/02/18/microsoft-ai-releases-omniparser-v2-an-ai-tool-that-turns-any-llm-into-a-computer-use-agent/)) |
| Jedi-7B | 7B | 39.5 | 54.1 | GPT-4o OSWorld 5% to 27% ([arXiv 2505.13227](https://arxiv.org/abs/2505.13227)) |
| GUI-Actor-7B (+verifier) | 7B | 44.6 (47.7) | n/a | Attention head, coordinate-free ([repo](https://github.com/microsoft/GUI-Actor)) |
| GTA1-7B / 32B | 7B / 32B | 50.1 (repo update 55.5) / 63.6 | 67.7 / n/a | Click-reward RL ([arXiv 2507.05791](https://arxiv.org/abs/2507.05791), [repo](https://github.com/Yan98/GTA1)) |
| Phi-Ground | under 10B | 55.0 agent setting, 43.2 end-to-end | n/a | ([arXiv 2507.23779](https://arxiv.org/html/2507.23779v1)) |
| Qwen3-VL-8B Instruct / Thinking | 8B | 54.6 / 46.6 | 58.2 / 56.7 | Thinking hurts grounding (measured by [VenusBench-GD](https://arxiv.org/pdf/2512.16501)) |
| Qwen3-VL-235B-A22B | 22B active | 61.8 | 68.3 | ([arXiv 2511.21631](https://arxiv.org/pdf/2511.21631)) |
| Holo2 4B / 8B / 30B-A3B | 4-30B | 57.2 / 58.9 / 66.1 | 69.4 / 70.1 / 76.1 | ([H Company](https://www.hcompany.ai/blog/holo2)) |
| Holo2-235B-A22B | 22B active | 70.6, 78.5 in 3-step mode | 79.0 | ([model card](https://huggingface.co/Hcompany/Holo2-235B-A22B)) |
| MAI-UI 2B / 8B / 32B | 2-32B | 57.4 / 65.8 / 67.9 (73.5 with zoom) | 70.9 (32B, zoom) | Tongyi Lab ([arXiv 2512.22047](https://arxiv.org/pdf/2512.22047)) |
| UI-Venus-1.5 2B / 8B / 30B-A3B | 2-30B | 57.7 / 68.4 / 69.6 (74.8 with zoom, secondary) | 59.4 / 69.7 / 70.6 | Apache-2.0 ([README](https://github.com/inclusionAI/UI-Venus/blob/UI-Venus-1.5/README.md)) |
| Qwen-UI-Agent | 4B / 27B (secondary) | 81.5 headline (76.6 for 27B without zoom, secondary) | n/a | Jul 2026 ([arXiv 2607.28227](https://arxiv.org/abs/2607.28227)) |
| Fara-7B (full agent) | 7B | n/a | n/a | WebVoyager 73.5%, 16.5 steps/task vs about 41 for UI-TARS-1.5-7B, about $0.025/task ([arXiv 2511.19663](https://arxiv.org/html/2511.19663)) |
| Frontier models, native | n/a | Gemini 3 Pro 72.7, GPT-5.4 85.4, Opus 4.8 87.9, GPT-6 Astra 92.7 | n/a | Aggregator, mixed provenance ([BenchLM](https://benchlm.ai/benchmarks/screenspot-pro)) |

Licenses vary. Holo1.5 3B/72B and some UI-TARS releases are research-only, while UI-Venus-1.5 and Holo1.5-7B are Apache-2.0. Check each model card before bundling anything.

#### Planner/grounder split

- **When it helps:** when the planner can't ground. GPT-4o went from 5% to 27% on OSWorld with Jedi-7B, and o3 from 23% to 51% ([Jedi](https://arxiv.org/abs/2505.13227)). Agent S2's mixture of grounding experts (visual, OCR-textual, structural) added 3-5 points on a 65-task subset ([arXiv 2504.00906](https://arxiv.org/pdf/2504.00906)).
- **Latency cost is small** when the grounder is local: 1.8-3.9% of task time, about 12 output tokens per call ([OSWorld-Human](https://arxiv.org/html/2506.16042)).
- **The trend is toward native grounding.** Frontier models now ground better than any open 8B model (table above), and Agent S3 dropped hierarchical planning entirely. For our server: support a pluggable `locate(description)` backed by a local grounder for text-only or weak-vision models, but don't put it on the default path for frontier models.

#### Zoom and crop refinement

- **Claude's `zoom` member tool** captures a region at full resolution, scaled to normal screenshot size. Claude keeps coordinates in full-screen space ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)). Steel's leaderboard notes Anthropic's revised Opus 4.8 harness included a "zoom-tool fix" ([Steel](https://leaderboard.steel.dev/leaderboards/osworld/)).
- **Training-free zoom on open grounders:**
  - ZoomClick took UI-Venus-72B up 19.1 points to 73.1% ([arXiv 2512.05941](https://arxiv.org/html/2512.05941)).
  - MAI-UI-32B went from 67.9 to 73.5.
  - Holo2-235B's 3-step mode went from 70.6 to 78.5.
  - UI-Zoomer reported up to +13.4 by zooming only when uncertain ([arXiv 2604.14113](https://arxiv.org/pdf/2604.14113)).
- **Costs and caveats:**
  - RegionFocus needed up to 100 inference steps per sample (about 5.7 s, about 10x slower), and a re-run by the GUI-Cursor authors got only 32.1% with a 7B model ([arXiv 2509.21552](https://arxiv.org/pdf/2509.21552), secondary).
  - DiMo-GUI's iterative cropping lowered ScreenSpot-V2 accuracy from 81.8% to 77.2% and stretched inference from 36 minutes to 6h43m ([UI-Zoomer, arXiv 2604.14113](https://arxiv.org/html/2604.14113)).
  - Zoom helps on high-resolution, dense screens and can hurt on easy ones. Make it on-demand or confidence-gated, never automatic on every click.

### 5. Verification and waiting

- **Fixed sleeps are the default and they waste time.** OSWorld 2.0 uses 3 s after every action. Anthropic's reference loop suggests `time.sleep(0.5)` after clicks.
- **Pixel settle detection** works without app cooperation. Record a baseline, act, wait for the frame to change, then wait for two consecutive unchanged frames under a noise threshold, capped by a timeout. Quern's version used a 0.001 pixel-fraction threshold, about 17 ms per diff and about 114 ms per capture ([quern #101](https://github.com/quern-dev/quern/pull/101)).
  - Typing landed 5/5 after a 0.65-0.69 s settle, 5/5 after a 1.0 s sleep, and 1/5 after a 0.2 s sleep.
  - Scroll settling took about 1.1 s, so the 0.3 s sleep it replaced was too short.
  - Limitation: it detects "drawing stopped", not "content arrived". A blank stalled page reported settled.
- **Event-driven settle:**
  - Android's `UiAutomation.waitForIdle` waits for a quiet accessibility event stream with a global timeout ([docs](https://learn.microsoft.com/en-us/dotnet/api/android.app.uiautomation.waitforidle)).
  - The Windows equivalent is UIA StructureChanged/PropertyChanged or WinEvent hooks plus a short debounce. Practitioners suggest about 50-150 ms of quiet with a floor and a hard timeout, plus per-app handling for Chromium, which never goes quiet (practitioner guidance, [Windows-Hinting #71](https://github.com/knausj85/Windows-Hinting/issues/71)).
  - For browsers, network-idle plus DOM-quiet windows replace sleeps ([Automattic issue #670](https://github.com/Automattic/data-liberation-agent/issues/670)).
- **Return what changed:** Agent-E's skills report the DOM mutations each action caused, via MutationObserver, e.g. "a popup appeared with these elements". That tells the model a click opened a menu instead of navigating, without another observation ([arXiv 2407.13032](https://arxiv.org/html/2407.13032v1)).
- **Act-then-verify beats blind chains, but verification can live in code:**
  - PreAct checks a state predicate (AX/XPath pattern with timeout) before firing each replayed transition ([arXiv 2606.17929](https://arxiv.org/html/2606.17929)). EchoPath rejects a replay step if template matching is ambiguous (score under 0.78 or margin under 0.02) ([arXiv 2609.16635](https://arxiv.org/html/2609.16635v1)).
  - Verification-aware tool interfaces cut incorrect "done" claims by 27.8 points in controlled tests ([arXiv 2608.23628](https://arxiv.org/abs/2608.23628)).
  - OSWorld 2.0 names skipped verification as a main failure mode.
  - Anthropic's batch semantics (stop at first failure, mark the rest not executed) are the right default for blind chains.
- **Timing-critical UIs:** if decoding is slower than the UI event window, agents are "correct but late". AAPT precomputes a small policy tree while idle and fires the matching branch when a change-gated observer sees the event. Success in contested windows rose from 0.50 to 0.79 ([arXiv 2607.28399](https://arxiv.org/abs/2607.28399)). In code mode, the model can write the handler itself: `await cua.waitFor(cond).then(act)`.

### 6. Caching and replay

| System | What it caches | Measured effect | Caveats |
|---|---|---|---|
| [PreAct](https://arxiv.org/html/2606.17929) (2026) | Compiles a successful trace into a state-machine program with AX predicates and parameters, then replays with CUA fallback | Warm replays 8.5-13x faster (WebArena). One-time compile and verify costs +162-217% wall time | All 48 ungated WebArena warm replays scored 0. The verify-before-store gate rejected about 83% of compiles. Corpus did not transfer to unseen tasks. With fallback it tied Muscle-Mem |
| [EchoPath](https://arxiv.org/html/2609.16635v1) (2026) | Validated trajectories as parameterized callable memories, with image-crop re-aiming | OSWorld-Verified replay: median 20k vs 586k tokens, 127.5 vs 315.7 s, same success (91-93%) | Re-aiming fails on near-duplicate targets. The state gate let about 1 in 5 incompatible starts through |
| [ActionEngine](https://arxiv.org/html/2602.20502) (2026) | Offline-crawled state-machine model of the app. One LLM call writes a full program | WebArena 91.2% vs 82.7% for Claude Code. 27 s vs 87 s per task, $0.05 vs $0.40 | Crawl cost $12-37 per site, break-even after 39-101 tasks. Web only |
| [AppAgentX](https://arxiv.org/abs/2503.02268) | Evolves high-level shortcut actions from repeated sequences | Steps 9.1 to 5.7, about 23 to 16 s per step, tokens 9.3k to 4.9k (secondary) | Mobile only |
| [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) | Induced text workflows in the prompt | +51.1% relative on WebArena, about 2 fewer steps | [Budget-matched study](https://arxiv.org/abs/2606.15017): vanilla with equal tokens ties or wins in aggregate |
| [SkillWeaver](https://arxiv.org/abs/2504.07079) | Self-discovered Playwright functions as APIs | WebArena 25% to 38%, +31.8% relative | Web only, needs exploration time |
| [Stagehand](https://docs.stagehand.dev/v3/best-practices/caching) | Resolved selectors and agent steps keyed by instruction and URL, self-healing on miss | "10-100x faster", 0 tokens on hit (vendor claim) | Self-heal re-runs the LLM |
| [Skyvern code caching](https://www.skyvern.com/docs/developers/features/code-caching) | Generated Playwright per workflow block, AI fallback | 2.3x faster, 2.7x cheaper ([blog](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/)), or 3-5x faster and up to 70% cheaper (product page). Both vendor claims | Re-record on UI change |
| [muscle-mem](https://github.com/pig-dot-dev/muscle-mem) | Tool-call trajectories with user-written cache-validation checks | No published numbers. 50-67% cache-miss rate in PreAct's WebArena test | Repo inactive since Jun 2025 |
| [DeltaReplay](https://arxiv.org/html/2610.11707) (Oct 2026) | Transition-graph paths, replaying steps with swapped parameters | +10.3 to +25.0 pts success on AndroidWorld / SPA-Bench | Mobile. Speed numbers not in the abstract |

**My read:**

- Replay is the single largest speedup for repeated work. Its correctness hinges on two things: state checks before each step, and an external success check before saving a program.
- Code mode makes this easy. The model's successful JS is already the program. We only need to parameterize literals, add guards from the tree (role and name of the target, window title), and store it.
- Keep it opt-in. Some tasks (e.g. reading dynamic values) don't replay well.

### 7. Model-side levers

#### Image downscaling and provider budgets

- **Claude:**
  - Recommends 1024x768 or 1280x720 for desktop and 1280x800 or 1366x768 for web, and says to avoid going above 1920x1080.
  - Older models are capped near 1568 px or 1.15 MP. Opus 4.7 and later accept up to 2576 px or 4,784 tokens, and the toolset API now rejects oversize images instead of resizing them.
  - Retina screens need 2x downscale or coordinate halving.
  - Source: [docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool).
- **OpenAI:** says use `detail: "original"` for CU and map coordinates back if you downscale ([guide](https://developers.openai.com/api/docs/guides/tools-computer-use)). GPT-5.4's original detail supports up to 10.24 MP or 6000 px ([GPT-5.4 launch](https://openai.com/index/introducing-gpt-5-4/)).
- **Gemini 3:** sets 280-2240 tokens per image via `media_resolution` ([docs](https://ai.google.dev/gemini-api/docs/media-resolution)).
- **Evidence that resolution matters:**
  - In 2024 OSWorld, higher resolution improved screenshot-only GPT-4V, while SoM worked better at 0.4 scale ([arXiv 2404.07972](https://arxiv.org/html/2404.07972)).
  - Phi-Ground found accuracy collapses below an image-token threshold on ScreenSpot-Pro ([arXiv 2507.23779](https://arxiv.org/html/2507.23779v1)).
  - Opus 4.7's higher resolution reportedly added +4.4 points on ScreenSpot-Pro (secondary). Anthropic's own post only says dense screenshots are a target use and that you can downsample to save tokens ([Anthropic](https://www.anthropic.com/news/claude-opus-4-7)).
- **Cheaper capture:** a 1280-wide JPEG capture took 38 ms vs 100-220 ms for full PNG ([mac-control-mcp #18](https://github.com/AdelElo13/mac-control-mcp/pull/18)).
- **Visual token pruning inside open models:** ShowUI dropped 33% of visual tokens for a 1.4x training speedup ([CVPR 2025](https://openaccess.thecvf.com/content/CVPR2025/papers/Lin_ShowUI_One_Vision-Language-Action_Model_for_GUI_Visual_Agent_CVPR_2025_paper.pdf)). Only relevant if we serve our own grounder.

Implication: the server should own coordinate scaling and offer per-provider presets. The model should never do resize math.

#### Prompt caching

- **Anthropic:** up to 85% lower latency and 90% lower cost on long prompts. Cache reads cost 0.1x ([announcement](https://www.anthropic.com/news/prompt-caching)).
- **OpenAI:** up to 80% lower time-to-first-token. The discount is up to 90%, now up to 95% on newer models ([cookbook](https://developers.openai.com/cookbook/examples/prompt_caching_201), [docs](https://developers.openai.com/api/docs/guides/prompt-caching)).
- **CU-specific guidance from Anthropic** ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)):
  - Put breakpoints after the tools and on the latest tool results.
  - Prune old screenshots in batches (e.g. keep 3, prune every 25 turns) so the prefix stays byte-identical.
  - For the 5.x models, don't prune on the client at all. Use server-side tool-result clearing, because pruning invalidates later thinking blocks.
- **Browser Use** puts history before the fresh browser state so history stays cached ([post](https://browser-use.com/posts/speed-matters)).
- **ActionEngine** cut cost from $0.16 to $0.05 per task with prefix caching alone ([arXiv 2602.20502](https://arxiv.org/html/2602.20502)).

Our server can't set cache breakpoints. What it can do:

- Keep the tool description and API docs byte-stable across sessions, with no timestamps or random ordering.
- Return deterministic, sorted output.
- Avoid huge per-step results that push old content out of the cache window.

#### Reasoning effort tradeoffs

- **OSWorld 2.0:**
  - Sonnet 4.6 at medium effort had higher binary success (9.3%) than at max (8.3%), though lower partial (33.9 vs 41.5). Run cost was about $1,550 vs $2,410.
  - GPT-5.5 plateaued near 14% regardless of step budget.
  - The extra points from more thinking cost about 25-30k tokens each ([arXiv 2606.29537](https://arxiv.org/html/2606.29537v1)).
- **Anthropic** says `low` effort uses fewer output tokens than disabling thinking, and suggests `low` for throughput ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- **Thinking can hurt grounding specifically:** Qwen3-VL-8B Thinking scored 46.6 vs 54.6 for Instruct ([VenusBench-GD](https://arxiv.org/pdf/2512.16501)). "Think Twice, Click Once" slow mode doubled time per decision, 2.6 s to 5.4 s (via [survey](https://arxiv.org/html/2609.02309v1)).
- **Output length matters:** on Browser Use's served model, 10 output tokens took 62.6 ms vs 29.1 ms for 1,000 input tokens, about 215x more per token ([post](https://browser-use.com/posts/speed-matters)). A terse API reduces output tokens per action. `cua.click(42)` beats verbose JSON.

#### Streaming tool calls

Anthropic's fine-grained tool streaming (`eager_input_streaming: true`) streams tool input as it is generated, without server-side JSON validation. LangChain reports first-fragment delay dropping from about 15 s to about 3 s for large parameters ([Claude docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming), [LangChain](https://docs.langchain.com/oss/python/integrations/chat/anthropic)). The legacy beta header can't be combined with the computer-use toolset. For a code-mode tool, the client could in principle start parsing early, but MCP servers receive the complete call. I found no evidence of anyone executing partial code. This is client-side and low priority.

#### Speculative and parallel actions

- **UFO2 speculative multi-action** is the practical form: predict several actions, validate each against live state. Up to 51.5% fewer calls ([arXiv 2504.14603](https://arxiv.org/html/2504.14603v1)). Code mode with assertions gives the same thing.
- **Speculative Actions** pre-executes a fast model's guess while the slow model thinks. Up to 55% prediction accuracy and up to 20% latency reduction ([arXiv 2510.04371](https://arxiv.org/abs/2510.04371)). A follow-up measured a 40% hit rate but only 1.05x end-to-end ([arXiv 2607.12236](https://arxiv.org/html/2607.12236)). Side effects make speculation hard for GUI actions.
- **PastForward** reuses past outputs as speculative drafts and starts next-step inference on a predicted next screen while the app is still responding. Step speedup was 1.4-2.4x with lossless decoding ([arXiv 2609.32166](https://arxiv.org/html/2609.32166)). This only applies if we serve our own model.
- **Parallel rollouts for accuracy:** Agent S3 with Behavior Best-of-N went from 62.6% to 69.9% on OSWorld with N=10, at about $0.72 per rollout ([arXiv 2510.02250](https://arxiv.org/html/2510.02250)). That is the opposite of fast.

#### Fast model for routine steps, strong model for hard ones

- **AVR** routes each action to the cheapest VLM whose predicted accuracy clears a threshold. Projected up to 78% cost savings within 2 points ([arXiv 2603.12823](https://arxiv.org/abs/2603.12823)).
- **iSHIFT** switches between a fast path and a slow perception path inside one 2.5B model ([CVPR 2026](https://openaccess.thecvf.com/content/CVPR2026/papers/Mehrotra_iSHIFT_Lightweight_Slow-Fast_GUI_Agent_with_Adaptive_Perception_CVPR_2026_paper.pdf)).
- **Cheaper models are often good enough.** PreAct used Gemini 3 Flash as its Android CUA, "about 10x cheaper" than Sonnet 4.6 at equal success. MacStories found the Cerebras-hosted Codex-Spark model "dramatically faster" for simple CU tasks (anecdotal).
- **Small dedicated agents:** Fara-7B finished WebVoyager tasks in about 16 steps at about $0.025 each vs about $0.30 for frontier SoM agents ([Microsoft](https://www.microsoft.com/en-us/research/blog/fara-7b-an-efficient-agentic-model-for-computer-use/)).
- For an MCP server, routing mostly lives in the client. The server can still offer cheap helpers the client's model calls from code. Examples: `extract(question)` over a big page, which Browser Use found critical for 50+ step tasks, or `locate()` with a local grounder. MCP sampling could run those on a client-chosen fast model (design idea, untested).

## Implications for our project

Our MCP server controls the observation format, the action API, waits, image handling, and how much one call can do. It does not control the model, effort level or cache breakpoints. So the priorities are server-side levers that cut turns and failed steps.

**Build first (P0)**

1. **Code-mode tool, like Codex.**
   - One `js` tool backed by a persistent sandboxed runtime, with a typed `cua` API. Multiple actions, loops, waits and assertions go in one call. Large data (full trees, OCR, page text) stays in variables, and only what the code logs or returns goes to the model.
   - Ship a short, byte-stable API reference in the tool description for cache hits, plus `cua.help(topic)` for progressive disclosure.
   - Batch semantics: run in order, stop at first failure, report which step failed and the current state.
   - Evidence: OSWorld 2.0 batching, Agent S3, CodeAct, Anthropic and Cloudflare code mode, OpenAI's recommendation for GPT-6 Astra.
2. **A fast native accessibility snapshot as the default observation.**
   - Scoped to a window, visible elements first, capped (about 2,000 nodes), with a compact text format: role, name, value, state, ref. Refs stay stable within a snapshot generation.
   - Implement with bulk reads: UIA CacheRequest on Windows, `AXUIElementCopyMultipleAttributeValues` plus messaging timeouts on macOS, AT-SPI with caps on Linux, CDP AX tree for browsers. Target well under 100 ms for a typical window.
   - Return "unchanged" or a diff when nothing changed.
   - Evidence: OSWorld-Human (tree cost), mac-control-mcp (31 ms), Region4Web (52.9% zero-change steps).
3. **Semantic-first actions with an automatic fallback chain.**
   - `el.press()`, `el.setValue()`, `el.select()`, `el.expand()` through accessibility patterns. Then keyboard. Then a coordinate click at the element's center. Then a coordinate click on raw screen coordinates.
   - Every action returns a small change summary (new windows, focused element, added or removed nodes near the target), like Agent-E.
4. **Settle-aware actions, no fixed sleeps.**
   - Each action waits by default for accessibility events (debounced) and a pixel-settle check, with a short cap.
   - Expose `cua.waitFor({text | role/name | gone | changed}, timeoutMs)` so verification happens in code, not in another model turn.
   - Evidence: quern, Android waitForIdle, OSWorld 2.0's 3 s sleeps.
5. **A screenshot pipeline the model never has to reason about.**
   - Screenshots on request, or auto-attached at the end of a batch. Provider presets for size and format (JPEG by default) and a `zoom(region)` that returns full-resolution crops.
   - All coordinate scaling (DPI, Retina, downscale) handled inside the API.
   - Evidence: Claude, OpenAI and Gemini docs, zoom results.

**Next (P1)**

6. **Program-state escape hatches in the same API:** shell, filesystem, AppleScript/JXA, PowerShell/COM, CDP. Keep them visible in the API reference, because models under-use separate tools. Evidence: UFO2 APIs, StateAct, CoAct-1, OSWorld-MCP.
7. **Hybrid perception fallback** for apps with bad trees: OCR (native OS OCR is about 200-700 ms) and optionally a detector like OmniParser. Merge with tree elements by overlap, as UFO2 does.
8. **Instrumentation and an end-to-end eval harness from day one.**
   - Log per call: model think time (time between tool calls), tool time, tokens in and out, images sent, actions per call.
   - Run a fixed OSWorld-Verified subset plus our own desktop tasks, and report success, wall time, turns and the OSWorld-Human WES efficiency score.
   - Save trajectories and screenshots as inspectable artifacts. Without this we can't tell whether we beat Codex.
9. **Guarded record and replay ("muscle memory").** Save successful code with literals lifted to parameters and pre-step guards (window, role and name of the target, expected text). Run it as `cua.replay(name, params)` with step-local fallback to the model, and only store programs that pass a re-run plus a success check. Evidence: PreAct, EchoPath, and the failures of ungated replay.

**Later (P2)**

10. **Optional grounding backend** (`cua.locate(text)`) using a local open model for text-only or weak-vision clients. Check licenses. Candidates: UI-Venus-1.5-8B (Apache-2.0), Holo2-8B, MAI-UI-8B, GTA1-7B. Add confidence-gated zoom.
11. **Cheap helper calls via MCP sampling** (`extract`, `summarizeTree`) so the client's model can push bulky reading to a fast model.
12. **Speculation and event-triggered precomputed handlers** for timing-critical UIs. Do this only after the measurements in item 8 show we're bottlenecked there.

A sketch of the intended call shape, illustrative only:

```js
const w = await cua.window({ app: "Excel" });           // compact tree + refs, diffed
await w.find({ role: "edit", name: "Name Box" }).setValue("B2");
await cua.key("ctrl+s");
const ok = await cua.waitFor({ text: "Saved", timeoutMs: 3000 });
return ok ? "saved" : await cua.screenshot({ zoom: w.bounds });
```

## Open questions

- **How well does code mode work for open-weight models?** CodeAct found open models gained much less. In OSWorld 2.0, the models that emitted pyautogui code (Kimi, MiniMax, Qwen) scored 21-22% partial. We need our own measurements across Claude, GPT, Gemini and Qwen-class models on the same API.
- **Do semantic pattern actions actually beat synthetic clicks on task success?** I found per-op latency and anecdotes, not a controlled comparison. Our eval should A/B this.
- **What is the best default observation mix per model?** Read More, Think More says stronger models benefit from richer observations, while compaction helps weaker ones. Should verbosity be a per-client setting?
- **Ref stability:** how should element refs survive between calls when the tree changes? Re-resolve by role, name and path, or fail loudly?
- **Auto-attached screenshots:** should every batch end with one (Anthropic's suggestion) or only on request? There's a token/latency tradeoff and a client-specific cache tradeoff. Some MCP clients may handle image content poorly. Another research topic should confirm client support.
- **Settle thresholds** for apps that never go quiet (Chromium, video, spinners): region-scoped pixel diffs? Per-app profiles?
- **Replay safety:** when are guards strong enough to skip the model? PreAct's results suggest dynamic-content tasks should never replay blindly.
- **Safety under batching:** consequential actions inside a code block need confirmation hooks before they run. Anthropic's docs say to check before each block. OSWorld 2.0 found about a third of trajectories bypassed the visible UI.
- **Benchmarks:** there's no standard wall-clock benchmark for CU. OSWorld-Human's WES counts steps, not seconds, and leaderboard times (e.g. "about 40 min per task" for GPT-6 Astra on OSWorld 2.0, from a latency simulation) are not comparable across harnesses. We will likely need to publish our own timing methodology.
- **Unverified numbers to recheck before relying on them:**
  - Frontier ScreenSpot-Pro scores from aggregators.
  - Qwen-UI-Agent model sizes.
  - The settled-computer implementation details.
  - Vendor speed claims from Stagehand, Skyvern and Browser Use.
