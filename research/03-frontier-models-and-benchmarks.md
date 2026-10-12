# Frontier computer-use models and how they are measured

Snapshot date: 2026-10-11. Every number has a link. "Self-reported" means the lab ran its own model. "Verified" means the OSWorld maintainers ran it. **Unverified** marks claims I could only find in secondary sources (aggregators, press, blogs), or in a primary page I could not read in full.

## TL;DR

- **OSWorld-Verified is saturated.** The maintainers' verified board tops out at 90.19% for an agent framework built on Opus 4.7 and 85.96% for a single model, Claude Fable 5. The human baseline is 72.36%. Self-reported single-model scores now sit between 83% and 86% for Claude Fable/Mythos 5, Opus 4.8, Qwen3.8-Max, Kimi K3 and Gemini 3.6 Flash. ([verified sheet](http://osworld-v1.xlang.ai/static/data/osworld_verified_results.xlsx), [OSWorld site](http://osworld-v1.xlang.ai/))
- **Labs moved to OSWorld 2.0/2.1 for headline claims.** It has 108 long workflows with a median human time of about 1.6 hours and a 500-step budget. Strict completion is still low: the best official binary score is 44.33% (Claude Opus 5, max effort, v2.1). Labs mostly quote the "partial" score instead, for example GPT-6 Astra at 72.6%, Opus 5.5 at 81.8% and Sonnet 5.5 at 80.1%. Partial and binary scores are not comparable. ([OSWorld 2.0 site](https://osworld-v2.xlang.ai/), [official results JSON](https://osworld-v2.xlang.ai/static/data/leaderboard/official-results.json))
- **The frontier is three closed labs plus open-weight models that are close behind.** OpenAI claims the best computer-use model, GPT-6 Astra, launched 2026-09-03 with ScreenSpot-Pro at 92.7%. Anthropic's Opus 5.5 and Sonnet 5.5 lead on OSWorld 2.1 partial. Google's Gemini 3.8 Flash and 3.5 Flash-Lite are the cheap, fast option. Among open weights, Qwen3.8-27B (Apache-2.0) self-reports 84.3% on OSWorld-Verified, and H Company's Holo4-35B-A3B (Apache-2.0, 3B active) claims 80.8% at about $0.05 per task.
- **All three closed APIs now batch actions per turn.** Anthropic (`computer_toolset_20260801`), OpenAI (`computer` tool with an `actions[]` array) and Google (`computer_use`, "batch tool enabled") each emit several actions per model call. OpenAI also recommends "code mode" for GPT-6 Astra, where the model writes Playwright or PyAutoGUI scripts. Fewer model round trips is the biggest speed lever.
- **Coordinate conventions split two ways.** Claude and OpenAI use pixels in the space of the screenshot you send. Gemini, Qwen3-VL and newer, Holo3+ and GLM use normalized 0-999 or 0-1000. UI-TARS-1.5 uses pixels in its internal resized image. An MCP server for any model has to own this mapping.
- **Speed is measured badly but it is measurable.** OSWorld-Human found that LLM planning and reflection calls take 75-96% of wall-clock time and grounding takes only 2-4%. Agents also take 2.7-4.3x more steps than humans. On OSWorld 2.0, OpenAI reports about 40 minutes per task for Astra versus about 75 for GPT-5.6 Sol. Official per-task API cost runs from about $2.40 (MiniMax M3) to about $36 (Opus 4.7, max effort). ([OSWorld-Human](https://arxiv.org/abs/2506.16042), [GPT-6 Astra](https://openai.com/index/gpt-6-astra/))
- **Grounding is close to solved for big models but still matters for small ones.** On the official ScreenSpot-Pro board, open 8B grounders reach 73-81% with zoom-in, and a two-model cascade hits 85.1%. Closed frontier models self-report up to 92.7%. A local 4-9B grounder is cheap insurance for weak-vision agents, not the main path.
- **Recommended benchmark for us:** OSWorld-Verified via the official harness, using `test_small.json` (39 tasks) for daily runs and the 361-task no-Google-Drive set for milestones. Log wall-clock, steps, tokens and dollars per task alongside success. Add OSWorld 2.1 offline (82 tasks) for occasional long-horizon checks, and WindowsAgentArena once we target Windows natively.

## How to read the numbers

Three things change scores more than the model does.

1. **Benchmark version.** OSWorld (2024, 369 tasks) became OSWorld-Verified on 2025-07-28 after task fixes and AWS support. OSWorld 2.0 shipped on 2026-06-26 as a different benchmark, with releases `v2026.06.24`, `v2026.08.08` and `v2.1` (2026-09-16). Anthropic and OpenAI quote 2.0/2.1 for new models and mostly stopped quoting Verified. ([OSWorld site](http://osworld-v1.xlang.ai/), [OSWorld-V2 repo](https://github.com/xlang-ai/OSWorld-V2))
2. **Metric.** OSWorld 2.0 reports a binary completion rate and a "partial" checkpoint score, with an average of 27.25 checkpoints per task. Vendor pages almost always quote partial. Simular's "73% on OSWorld 2.0" for Sai matches partial-style numbers; the official v2.1 board lists Sai with Opus 5 at 79.38% partial and 41.67% binary. ([OSWorld 2.0](https://osworld-v2.xlang.ai/), [Simular](https://www.simular.ai/articles/sai-tops-osworld-2-0))
3. **Harness and budget.** Step limits (15/50/100 on Verified, 150/300/500 on 2.0), effort level, batching, zoom tools, 1M context, task subset (361 vs 369; full vs offline) and runs averaged all move scores by 5-20 points. Anthropic's Opus 4.8 number used a "revised harness (zoom-tool fix, 128K tokens/turn)" per the Steel tracker (**unverified** against Anthropic's own text). ([Steel OSWorld tracker](https://leaderboard.steel.dev/leaderboards/osworld/)) Image resolution alone moved GPT-5.3-Codex from 64.7% to 74.0% once OpenAI added `detail: "original"`. ([GPT-5.4 post](https://openai.com/index/introducing-gpt-5-4/))

One more warning. An audit of 150 failure verdicts across five CUA benchmarks found that 15.3% were wrong: 10.7% evaluator false negatives and 4.7% broken tasks. Scores above about 85% on OSWorld-Verified are probably within evaluator noise. ([How Benchmarks Mis-Score Computer-Use Agents](https://arxiv.org/abs/2607.28367))

## Leaderboards

### OSWorld-Verified, official verified board (maintainer-run)

Pulled from the maintainers' spreadsheet on 2026-10-11. All rows are 100 steps unless noted. "Code" means the agent also had a coding-based action, for example running Python or a shell.

| Score | System | Org | Type | Code | Date |
|---:|---|---|---|---|---|
| 90.19 | Intelligence-Indeed Agent (core model `claude-opus-4-7`) | Intelligence Indeed | Framework | Yes | 2026-07-25 |
| 85.96 | claude-fable-5 [1m] | Anthropic | General model | No | 2026-08-01 |
| 83.64 | Pointer Agent w/ Opus 4.7 | Pointer | Framework | Yes | 2026-05-21 |
| 83.39 | claude-opus-5 [1m] | Anthropic | General model | No | 2026-08-01 |
| 82.81 | Coasty CUA v1 | Coasty | "General model" | Yes | 2026-07-01 |
| 82.56 | Holo3-35B-A3B (open, Apache-2.0) | H Company | Specialized | No | 2026-04-20 |
| 81.45 | Pointer Agent w/ Sonnet 4.6 | Pointer | Framework | Yes | 2026-05-21 |
| 80.67 | Muse Spark 1.1 | Meta Superintelligence Labs | General model | No | 2026-07-09 |
| 78.34 | OpenAPA w/ Gemini 3.1 Pro | Laiye | Framework | Yes | 2026-04-17 |
| 75.19 | MiniMax M3 | MiniMax | General model | No | 2026-06-08 |
| 73.30 | Qwen 3.7 Plus | Alibaba Qwen | General model | No | 2026-05-25 |
| 73.06 | Kimi K2.6 | Moonshot AI | General model | No | 2026-04-20 |
| 72.58 | Agent S3 w/ Opus 4.5 + GPT-5, best-of-10 | Simular | Framework | Yes | 2025-12-11 |
| 72.11 | claude-sonnet-4-6 | Anthropic | General model | No | 2026-03-08 |
| 61.87 | Seed-1.8 | ByteDance Seed | General model | No | 2025-12-18 |
| 56.73 | EvoCUA (50 steps) | Meituan LongCat | General model | No | 2026-01-06 |
| 55.44 | GUI-Owl-1.5 32B (50 steps) | Alibaba Tongyi | Specialized | No | 2026-03-27 |
| 53.10 | UI-TARS-2-2509 | ByteDance Seed | Specialized | No | 2025-10-14 |
| 48.03 | autoglm-os-9b (50 steps) | Tsinghua and Zhipu | Specialized | Yes | 2025-09-25 |
| 46.10 | OpenCUA-72B-preview | HKU and Moonshot | Specialized | No | 2025-10-01 |
| 31.40 | computer-use-preview (OpenAI CUA) | OpenAI | Specialized | No | 2025-07-28 |
| 29.60 | UI-TARS-1.5-7B | ByteDance | Specialized | No | 2025-07-28 |

Source: [osworld_verified_results.xlsx](http://osworld-v1.xlang.ai/static/data/osworld_verified_results.xlsx), with the human baseline of 72.36% from the [OSWorld site](http://osworld-v1.xlang.ai/). There are no GPT-5.x or Gemini general-model rows on the verified board. OpenAI and Google numbers below are self-reported.

### OSWorld-Verified, self-reported by labs (newer models)

| Score | Model | Open weights | Date | Source |
|---:|---|---|---|---|
| 86.1 | Qwen3.8-Max | Base reportedly open under a custom license (**unverified**) | 2026-08 | [Steel tracker](https://leaderboard.steel.dev/leaderboards/osworld/) (**unverified**) |
| 85.0 | Claude Fable 5 / Mythos 5 | No | 2026-06 | [Steel tracker](https://leaderboard.steel.dev/leaderboards/osworld/); verified board shows Fable 5 at 85.96 |
| 85.2 | Holo4-27B ("OSWorld", version not stated) | CC BY-NC 4.0 | 2026-09-28 | [Holo4-27B card](https://huggingface.co/Hcompany/Holo4-27B), [H models page](https://hcompany.ai/research/models) |
| 84.8 | Kimi K3 (2.8T total, 104B active) | Kimi K3 License | 2026-07 | [Lindy summary](https://www.lindy.ai/blog/kimi-k3) (**unverified**) |
| 84.3 | Qwen3.8-27B (dense, 27B) | Apache-2.0 | 2026-08 | [HF model card](https://huggingface.co/Qwen/Qwen3.8-27B) |
| 83.4 | Claude Opus 4.8 | No | 2026-05-28 | [Steel tracker](https://leaderboard.steel.dev/leaderboards/osworld/) (**unverified**) |
| 83.0 | Gemini 3.6 Flash | No | 2026-07-21 | [Google blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/) |
| ~83 | GPT-5.6 Sol | No | 2026-07-09 | Only in competitor tables (83.0 or 83.2). [OpenAI's GPT-5.6 page](https://openai.com/index/gpt-5-6/) quotes OSWorld 2.0 instead (**unverified**) |
| 82.0 / 80.8 | MiMo-V2.6-Pro / Flash | MIT (reported) | 2026-09-22 | [secondary](https://computingforgeeks.com/xiaomi-mimo-v2-6-pro-flash/) (**unverified**) |
| 81.2 | Claude Sonnet 5 | No | 2026-06 | [Steel tracker](https://leaderboard.steel.dev/leaderboards/osworld/) (**unverified**) |
| 80.8 | Holo4-35B-A3B (3B active) | Apache-2.0 | 2026-09-28 | [H models page](https://hcompany.ai/research/models) |
| 79.5 | Qwen-UI-Agent | Not stated | 2026-07-30 | [arXiv 2607.28227](https://arxiv.org/abs/2607.28227) |
| 78.7 | GPT-5.5 | No | 2026-04-23 | [OpenAI](https://openai.com/index/introducing-gpt-5-5/) |
| 78.4 | Gemini 3.5 Flash (first Flash with built-in CU) | No | 2026-06 | [Google blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-computer-use-gemini-3-5-flash/) |
| 78.0 | Claude Opus 4.7 | No | 2026 | Cited in Google's and OpenAI's comparison tables |
| 77.8 | Holo3-35B-A3B (verified board: 82.56) | Apache-2.0 | 2026-03-31 | [Holo3 post](https://hcompany.ai/holo3) |
| 75.0 | GPT-5.4 | No | 2026-03-05 | [OpenAI](https://openai.com/index/introducing-gpt-5-4/) |
| 74.0 | Gemini 3.5 Flash-Lite | No | 2026-07-21 | [Google blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/) |
| 65.9 | Muse Glimmer-30B | Apache-2.0 | 2026-08-10 | [HF card](https://huggingface.co/meta-models/Muse-Glimmer-30B) |
| 62.3 | GLM-5V-Turbo | Not stated | 2026-04-02 | [arXiv 2604.26752](https://arxiv.org/abs/2604.26752) |

Conflicts worth knowing: Qwen3.6-27B is 63.9 in Qwen's own card but 75.6 in Meta's Glimmer card ([Qwen3.8-27B card](https://huggingface.co/Qwen/Qwen3.8-27B), [Muse Glimmer card](https://huggingface.co/meta-models/Muse-Glimmer-30B)). Holo3-35B-A3B is 77.8 in H's post and 82.56 on the verified board.

### OSWorld 2.0 and 2.1

Official maintainer-run rows. The JSON was updated 2026-10-05. All rows use 500 steps. Cost per task is the board's total estimated cost divided by 108 tasks, and only covers full-set rows that report a cost.

| Release | Set | Model | Effort | Binary | Partial | Output tok/task | ~$/task |
|---|---|---|---|---:|---:|---:|---:|
| v2.1 | full | Claude Opus 5 (batch tool) | max | 44.33 | 77.67 | 107,919 | n/a |
| v2.1 | full | Sai w/ Claude Opus 5 (Simular) | max | 41.67 | 79.38 | n/a | 14.34 |
| v2.1 | full | Claude Opus 5 | high | 36.89 | 68.92 | 65,555 | n/a |
| v2.1 | full | Claude Opus 5 | low | 18.81 | 59.09 | 29,242 | n/a |
| v2.1 | offline | Claude Opus 5 | max | 48.65 | 79.20 | 113,319 | n/a |
| v2026.08.08 | full | GPT-5.6 Sol (batch tool) | max | 27.34 | 62.72 | n/a | n/a |
| v2026.08.08 | offline | GPT-5.6 Sol | none / low / medium / max | 3.41 / 7.32 / 17.56 / 28.10 | 16.43 / 29.63 / 49.01 / 64.13 | n/a | see note |
| v2026.06.24 | full | Claude Opus 4.8 (batched tool) | max | 20.6 | 54.8 | n/a | n/a |
| v2026.06.24 | full | Claude Opus 4.7 (standard tool) | max | 13.9 | 49.1 | n/a | 35.8 |
| v2026.06.24 | full | GPT-5.5 (batch tool) | xhigh | 13.0 | 49.5 | n/a | 25.5 |
| v2026.06.24 | full | Claude Sonnet 4.6 | medium | 9.3 | 33.9 | n/a | 14.4 |
| v2026.06.24 | full | Kimi 2.6 | on | 4.6 | 22.1 | n/a | 6.6 |
| v2026.06.24 | full | Qwen 3.7-Plus | thinking | 2.8 | 21.5 | n/a | 3.8 |
| v2026.06.24 | full | MiniMax M3 | on | 4.6 | 22.3 | n/a | 2.4 |

Source: [official-results.json](https://osworld-v2.xlang.ai/static/data/leaderboard/official-results.json). For GPT-5.6 Sol on the 82-task offline set, total cost runs from $96 (no reasoning) to $1,117 (max), roughly $1.2 to $13.6 per task. ([offline task list](https://github.com/xlang-ai/OSWorld-V2/blob/main/evaluation_examples/test_v2_offline_no_internet.json))

Lab-reported OSWorld 2.x partial scores, each on the lab's own harness:

| Model | Score | Setting | Source |
|---|---:|---|---|
| Claude Opus 5.5 | 81.8% | OSWorld 2.1, partial, max effort | [Anthropic](https://www.anthropic.com/claude-opus-5-5) |
| Claude Fable 5.1 | 80.7% | OSWorld 2.1, partial | [Anthropic](https://www.anthropic.com/claude-opus-5-5) |
| Claude Sonnet 5.5 | 80.1% (83.9% offline) | OSWorld 2.1, partial | [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5), [Haiku 5.5 page](https://www.anthropic.com/claude-haiku-5-5) |
| Claude Haiku 5.5 | 72.4% | OSWorld 2.1 offline | [Anthropic](https://www.anthropic.com/claude-haiku-5-5) |
| GPT-6 Astra | 72.6% | OSWorld 2.0 v2026.08.08 offline, partial | [OpenAI](https://openai.com/index/gpt-6-astra/) |
| GPT-6.1 Sol | about 70.5% (within 2.1 pts of Astra at about 1/7 the cost) | same | [OpenAI](https://openai.com/index/introducing-gpt-6-1-sol/) |
| Gemini 4 Argon | 69.2% | OSWorld 2.0 offline, partial, best of 3 runs, 1080p | [DeepMind blog](https://deepmind.google/blog/gemini-4-argon-our-next-era-of-frontier-intelligence/) (number via search summary, **unverified**) |
| GPT-6 Sol | 60.5% | OSWorld 2.0 offline, xhigh | [OpenAI](https://openai.com/index/introducing-gpt-6-sol-and-luna/) |
| Holo4-27B / 35B-A3B | 61.7% / 30.9% | "OSWorld 2.0", $1.22 / $0.61 per task | [HF card](https://huggingface.co/Hcompany/Holo4-27B) |
| Gemini 3.8 Flash | 59.0% | OSWorld-2.0 partial, batch tool | [model card](https://deepmind.google/models/model-cards/gemini-3-8-flash/) |
| GPT-6 Luna | 48.9% | OSWorld 2.1 offline (Anthropic's run) | [Haiku 5.5 page](https://www.anthropic.com/claude-haiku-5-5) |

### Grounding: ScreenSpot-Pro

Official board, from the maintainers' JSON as of 2026-10-11. These are mostly open models. Closed labs self-report separately.

| Score | Model | Size | Notes |
|---:|---|---|---|
| 85.1 | GroundCascade (Indeed-UI-32B + KV-Ground-8B) | 32B + 8B | Training-free cascade, about 2.6 model calls per example |
| 82.7 | Indeed-UI-32B, zoom-in | 32B | [repo](https://github.com/intelligence-indeed/Indeed-UI) |
| 81.0 | Indeed-UI-8B, zoom-in (73.4 single pass) | 8B | [ModelScope](https://www.modelscope.cn/models/IntellgenceIndeed/Indeed-UI-8B) |
| 80.5 | KV-Ground-8B (GUI-Owl-1.5 base), zoom-in (73.2 single pass) | 8B | [HF](https://huggingface.co/vocaela/KV-Ground-8B-BaseGuiOwl1.5-0315) |
| 78.5 | Holo2-235B-A22B, agentic | 235B / 22B active | CC BY-NC |
| 77.5 | MAI-UI-32B (MVP) | 32B | Alibaba Tongyi |
| 72.9 | Duvo Eye-1 (Holo3.1-35B-A3B + LoRA) | 35B / 3B active | [HF](https://huggingface.co/duvoai/duvo-eye-1) |
| 71.4 | Holo2-8B, agentic | 8B | CC BY-NC |
| 71.9 / 65.7 | MAI-UI-8B, zoom / single pass | 8B | [arXiv 2512.22047](https://arxiv.org/abs/2512.22047) |
| 63.6 | GTA1-32B | 32B | Salesforce |
| 61.6 | UI-TARS-1.5 | n/a | ByteDance |

Source: [gui-agent.github.io/grounding-leaderboard](https://gui-agent.github.io/grounding-leaderboard/) (data at `results/screenspot_pro.json`). Closed self-reports: GPT-6 Astra 92.7%, Claude Fable 5 87.3% (OpenAI's footnote says this figure comes from Mythos), GPT-5.6 Sol 76.9% ([OpenAI Astra post](https://openai.com/index/gpt-6-astra/)); Gemini 3 Pro 72.7% (**unverified**, secondary). Meta reports Muse Glimmer-30B at 75.4% with an iterative crop-and-zoom tool ([card](https://huggingface.co/meta-models/Muse-Glimmer-30B)). Qwen-UI-Agent reports 81.5% ([arXiv 2607.28227](https://arxiv.org/abs/2607.28227)).

### Other benchmarks

| Benchmark | What it tests | Top results | Status |
|---|---|---|---|
| OSWorld-MCP (ICLR 2026) | GUI plus 158 MCP tools over 7 apps; reports accuracy, tool invocation rate and average steps | Best is still Agent-S2.5 at 49.5% acc and 35.3% TIR (50 steps). Gemini 3.1 Pro: 34.1% at 15 steps | Stale. Few 2026 entries. [leaderboard](https://osworld-mcp.github.io/), [repo](https://github.com/X-PLUG/OSWorld-MCP) |
| WindowsAgentArena | 150+ Windows 11 tasks; human 74.5% | GPT-5.5 70.4%, Opus 4.8 69.3%, Sonnet 5 68.8%, UI-Mate-27B 66.2% (open), Kimi-K2.6 63.3% | No maintained leaderboard. Numbers from [UI-Mate, arXiv 2608.15930](https://arxiv.org/abs/2608.15930) (via search summary, **unverified**). [repo](https://github.com/microsoft/WindowsAgentArena) |
| macOSWorld | 202 tasks, 30 apps, 5 languages | Original paper: Claude CUA 37.1%, OpenAI CUA 33.8%. MacArena (421 tasks, 2026): OpenAI CUA 31.8% | No current frontier numbers. [arXiv 2506.04135](https://arxiv.org/abs/2506.04135), [MacArena 2606.06560](https://arxiv.org/abs/2606.06560) |
| AndroidWorld | 116 tasks, 20 apps; human 80% | Agent systems 97.4% (self-reported). Single models: Holo4-27B 85.1%, Qwen3.8-27B 81.9% | Saturated. [Qwen3.8-27B card](https://huggingface.co/Qwen/Qwen3.8-27B), [Holo4 coverage](https://www.marktechpost.com/2026/09/29/h-company-releases-holo4-open-weight-computer-use-models-that-click-code-and-call-tools-across-desktop-web-android-and-apis/) |
| Online-Mind2Web | 300 live-web tasks, human-judged | Hark Handoff 97.7%, Yutori Navigator n1.5 97.3%; GPT-5.4 self-reports 92.8% | Saturated. [Yutori board](https://yutori.com/leaderboards/online-mind2web) (secondary), [GPT-5.4](https://openai.com/index/introducing-gpt-5-4/) |
| WebVoyager | Live web | Fara1.5-27B 89.3%, Fara1.5-9B 86.6% | Saturated. [microsoft/fara](https://github.com/microsoft/fara) |
| Agents' Last Exam (2026) | Professional tasks in real software | GPT-6 Astra 59.3%, GPT-6 Sol 56.4%, Opus 5 55.5% | New, vendor-run. [OpenAI](https://openai.com/index/gpt-6-astra/) |
| AutomationBench (Zapier) | Business workflows across apps | Gemini 4 Argon 51.3%, Holo4-27B 45.4%, GPT-6 Astra 41.4% | New, vendor-run. [Google](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/), [OpenAI](https://openai.com/index/gpt-6-astra/) |

## Lab by lab

### Anthropic

- **Models.** Opus 5.5 (2026-09-22, $4/$20 per MTok), Sonnet 5.5 (2026-09-28, $2/$10), Haiku 5.5 (2026-10-07, $0.10/$0.50 up to 100k-token prompts), Fable 5.1 and Mythos 5.1, Opus 5 (2026-07-24). All closed. ([Opus 5.5](https://www.anthropic.com/claude-opus-5-5), [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5), [Haiku 5.5](https://www.anthropic.com/claude-haiku-5-5), [Opus 5](https://www.anthropic.com/news/claude-opus-5))
- **Scores.** OSWorld 2.1 partial: Opus 5.5 81.8%, Sonnet 5.5 80.1%, Haiku 5.5 72.4% (offline subset). Verified board: Fable 5 85.96%, Opus 5 83.39%. Fable 5.1 on OSWorld 2.0 is reported as 77.9% partial and 41.7% strict on modified tasks, per secondary write-ups of the [system card](https://www-cdn.anthropic.com/0339e6a7c5c7b87f5c07798616dc32c215d14235/Claude%20Fable%205.1%20&%20Claude%20Mythos%205.1%20System%20Card.pdf) (**unverified**).
- **Speed.** Opus 5.5 generates output more than 30% faster than Opus 5. Fast mode costs $8/$40 per MTok for "up to 2.5x speed". Sonnet 5.5 is "30%+ faster than Sonnet 5". Haiku 5.5 is "our fastest model to date". No per-step CU latency is published.
- **Tool.** `computer_toolset_20260801` is GA on the Claude API and Vertex with no beta header. 5.5-series models accept only this toolset there and reject `computer_20251124`. Bedrock and other platforms still offer only the beta tools. The toolset has 17 member tools, including `zoom`, and batches ordered actions per turn. ([computer use tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool))
- **Products.** Claude in Chrome went GA on all paid plans on 2026-08-26, with autonomous actions checked by a safety classifier. Computer use in the desktop app is in beta for Pro and Max, and runs in background windows on macOS 15+. ([Claude in Chrome GA](https://claude.com/blog/claude-in-chrome-generally-available), [Cowork computer use](https://support.claude.com/en/articles/14128542-let-claude-use-your-computer-in-cowork))

### OpenAI

- **Lineage.** Operator/CUA (Jan 2025, OSWorld 38.1%) led to ChatGPT agent (Jul 2025). The `computer-use-preview` API model scores 31.4% on the verified board. Then came GPT-5.3-Codex (74.0% with original-resolution images), GPT-5.4 (2026-03-05, 75.0%, the first mainline model with native CU), Codex computer use on Mac (April 2026), GPT-5.5 (2026-04-23, 78.7%), GPT-5.6 Luna/Terra/Sol (preview 2026-06-26, GA 2026-07-09, OSWorld 2.0 62.6%), GPT-6 Astra (2026-09-03), GPT-6 Sol and Luna (2026-09-22) and GPT-6.1 Sol (2026-09-29). ([research index](https://openai.com/research/index/release/), [GPT-5.4](https://openai.com/index/introducing-gpt-5-4/), [GPT-5.5](https://openai.com/index/introducing-gpt-5-5/), [GPT-5.6](https://openai.com/index/gpt-5-6/))
- **GPT-6 Astra.** OpenAI calls it "the world's best computer use model": OSWorld 2.0 offline partial 72.6%, ScreenSpot-Pro 92.7%, Agents' Last Exam 59.3%. Price is $10/$50 per MTok. Fast mode gives 2x speed at 2x price. ([OpenAI](https://openai.com/index/gpt-6-astra/))
- **GPT-6.1 Sol.** Within 2.1 points of Astra on OSWorld 2.0 offline at about one-seventh the cost per task. Price is $2/$10, or $0.10 for cached input. An "Ultrafast" mode with up to 8x faster token generation in Codex was announced. ([OpenAI](https://openai.com/index/introducing-gpt-6-1-sol/))
- **GPT-6 Luna** costs $0.10/$0.50, the same price point as Claude Haiku 5.5. ([OpenAI](https://openai.com/index/introducing-gpt-6-sol-and-luna/))
- **Codex computer use** (the product we are benchmarking against) runs as a plugin in the ChatGPT/Codex desktop app on macOS and Windows. On macOS it works in the background with its own cursor and needs Screen Recording and Accessibility permissions. On Windows it is foreground-only. ([Codex computer use docs](https://developers.openai.com/codex/app/computer-use)) MacStories reports it reads the macOS accessibility tree and grew out of the Sky app that OpenAI acquired. ([MacStories](https://www.macstories.net/notes/openais-new-codex-app-has-the-best-computer-use-feature-ive-ever-tested/))
- **Codex speed claims.** Astra plus an updated Codex harness gives "1.9x faster task completion compared to the current GPT-5.6 Sol experience, on the Mind2Web benchmark". On OSWorld 2.0, Astra takes about 40 minutes per task versus about 75 for 5.6 Sol. A demo task took 2 min 54 s. ([OpenAI](https://openai.com/index/gpt-6-astra/))

### Google

- **Models.** Gemini 3.8 Flash (2026-09-02, the recommended CU model), Gemini 3.5 Flash-Lite ("low-latency", 350 output tok/s per Artificial Analysis, $0.30/$2.50), Gemini 3.6 Flash ($1.50/$7.50) and Gemini 4 Argon (2026-09-30, restricted to vetted cyber defenders; $2/$10 introductory). Computer use is a built-in client-side tool from 3.5 Flash onward. All closed. ([CU docs](https://ai.google.dev/gemini-api/docs/computer-use), [3.8 Flash card](https://deepmind.google/models/model-cards/gemini-3-8-flash/), [3.6 Flash blog](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/), [Argon](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-4-argon/))
- **Scores.** OSWorld-Verified: 3.6 Flash 83.0%, 3.5 Flash 78.4%, 3.1 Pro 76.2%, 3.5 Flash-Lite 74.0%, 3 Flash 65.1%. OSWorld-2.0 partial: 3.8 Flash 59.0%, Argon 69.2% (offline).
- **Project Mariner** shut down on 2026-05-04. Its technology moved into Gemini Agent, AI Mode and Chrome Auto Browse. ([Wikipedia](https://en.wikipedia.org/wiki/Project_Mariner), secondary)
- **Takeaway for us.** 3.5 Flash-Lite at 74% Verified, 350 tok/s and $0.30 input is the best published speed-to-accuracy ratio among closed models.

### Microsoft

- **Fara1.5** (2026-07-22): 4B, 9B and 27B, built on Qwen3.5, MIT-licensed repo, browser-only. WebVoyager 80.8/86.6/89.3% and Online-Mind2Web 57.3/63.4/72.3%. Fara-7B (Nov 2025) is the predecessor. ([microsoft/fara](https://github.com/microsoft/fara), [MSR article](https://www.microsoft.com/en-us/research/articles/fara1-5-computer-use-agent/))
- **UFO3** is the open framework. UFO2 drives Windows through UIA, Win32 and COM and batches actions, which cuts LLM calls by 51% per its docs. ([microsoft/UFO](https://github.com/microsoft/UFO))
- **Copilot Actions and Agent Workspace** run agents in a separate Windows session under a separate account (Insider preview from Nov 2025). Microsoft Execution Containers reportedly went GA on 2026-10-07 (**unverified**). ([Windows Insider blog](https://blogs.windows.com/windows-insider/2025/11/17/copilot-on-windows-copilot-actions-begins-rolling-out-to-windows-insiders/))
- **WindowsAgentArena** is Microsoft's Windows benchmark (see below).

### ByteDance Seed

- **UI-TARS-1.5-7B** is open (Apache-2.0) and old: 29.6% on the verified board. UI-TARS-2 (Sep 2025) reports 47.5% OSWorld, 50.6% WAA, 73.3% AndroidWorld and 88.2% Online-Mind2Web ([arXiv 2509.02544](https://arxiv.org/abs/2509.02544)). Seed-1.8 scores 61.87% verified.
- **Seed2.0** (2026-02-14) and Seed 2.1 Pro (about 78.8% OSWorld-Verified per the UI-Venus-2 paper) are closed. ([Seed2.0](https://seed.bytedance.com/en/seed2); 2.1 figure **unverified**)

### Alibaba

- **Qwen3.8-27B** (Apache-2.0, released Aug 2026): 84.3% OSWorld-Verified, 64.8% WebArena-Verified and 81.9% AndroidWorld, all self-reported. The card gives no CU tool schema or coordinate format. Qwen3.8-Max self-reports 86.1%. ([HF](https://huggingface.co/Qwen/Qwen3.8-27B))
- **Tongyi Lab GUI specialists.** GUI-Owl-1.5 32B scores 55.44% verified at 50 steps. MAI-UI comes in 2B/8B/32B/235B, with strong ScreenSpot-Pro results and MCP-tool support. Qwen-UI-Agent (Jul 2026) reports 79.5% Verified and 81.5% ScreenSpot-Pro and emits batched actions plus CLI. ([MAI-UI](https://arxiv.org/abs/2512.22047), [Qwen-UI-Agent](https://arxiv.org/abs/2607.28227))
- **Base models.** Most open specialist models in 2026 (Holo3/4, Fara1.5, KV-Ground, MAI-UI) are fine-tunes of Qwen3.5 through Qwen3.8.

### Zhipu (Z.ai)

- autoglm-os-9b scores 48.03% verified ([ComputerRL](https://arxiv.org/abs/2508.14040)). GLM-5V-Turbo (2026-04-02) reports 62.3% OSWorld and 75.7% AndroidWorld ([arXiv 2604.26752](https://arxiv.org/abs/2604.26752)). GLM-4.6V is open as 106B-A12B and 9B Flash. GLM-5.3-Flash (2026-08-26) is described as their first open natively multimodal model. ([GLM-V repo](https://github.com/zai-org/GLM-V))

### H Company

- **Holo4** (2026-09-28): the 27B dense model (Qwen3.8-27B base, CC BY-NC) scores 85.2% "OSWorld" at $0.08/task and 61.7% OSWorld 2.0. The 35B-A3B model (Apache-2.0) scores 80.8% at $0.05/task. Both ship BF16, FP8, NVFP4 and Q4 GGUF. API prices are $0.40/$3.00 and $0.30/$2.00. ([Holo4-27B card](https://huggingface.co/Hcompany/Holo4-27B), [models page](https://hcompany.ai/research/models), [coverage](https://www.marktechpost.com/2026/09/29/h-company-releases-holo4-open-weight-computer-use-models-that-click-code-and-call-tools-across-desktop-web-android-and-apis/))
- **Holo3.1** (2026-06-01): 0.8B, 4B, 9B and 35B-A3B, Apache-2.0, built for local use. On a DGX Spark the 35B-A3B with NVFP4 runs at 568 tok/s total throughput, and harness changes cut the average step from 6.8 s to 3.3 s. AndroidWorld: 79.3% for 35B, 71% for 4B and 9B. ([Holo3.1](https://hcompany.ai/newsroom/holo3.1))
- **Surfer-H** was not mentioned on the current models page.

### Amazon

- **Nova Act** went GA on 2025-12-02 as an AWS service (US East only at launch) on a custom Nova 2 Lite model. Amazon claims ">90% task reliability" on customer workflows. No 2026 public benchmarks. Its SDK exposes natural-language `act()` steps rather than coordinates. ([AWS blog](https://aws.amazon.com/blogs/aws/build-reliable-ai-agents-for-ui-workflow-automation-with-amazon-nova-act-now-generally-available/))

### Simular

- **Agent S3** is open source (Apache-2.0) and model-agnostic. It reached 72.58% on the verified board with Opus 4.5 + GPT-5 and best-of-10 rollouts, which is not cheap. ([Agent-S](https://github.com/simular-ai/Agent-S))
- **Sai** is commercial (GA 2026-09-23) and available as an MCP server. It scores 79.38% partial and 41.67% binary on OSWorld 2.1 at $14.34/task ([official JSON](https://osworld-v2.xlang.ai/static/data/leaderboard/official-results.json), [Simular](https://www.simular.ai/articles/sai-tops-osworld-2-0)).
- **Replay.** "Neuro-Symbolic Computer Use" learns reusable policies for recurring workflows. It reports 15-217x lower per-run cost and 3.4-5.1x lower latency, with higher Pass^3 on OSWorld-Verified. ([arXiv 2609.36927](https://arxiv.org/abs/2609.36927))

### xLang (HKU)

- They maintain OSWorld, OSWorld-Verified, OSWorld 2.0/2.1, OSWorld-G and OpenCUA. OpenCUA-7B/32B/72B score up to 46.1% verified and are now supported in vLLM ([OpenCUA](https://opencua.xlang.ai/)). CUA-Gym (May 2026) is an Apache-2.0 pipeline with 32k verified RL tasks across 110 environments; models are "coming soon" ([CUA-Gym](https://github.com/xlang-ai/CUA-Gym)).

### Moonshot, Meta, MiniMax, Xiaomi, Meituan

- **Kimi K2.6** scores 73.06% verified. **Kimi K3** (Jul 2026, open weights, 2.8T total and 104B active) self-reports 84.8% (**unverified**, secondary).
- **Meta Muse Spark 1.1** (closed API) scores 80.67% verified. **Muse Glimmer-30B** is Apache-2.0 and runs on a 24 GB GPU at 4-bit: 65.9% OSWorld-Verified, 75.4% ScreenSpot-Pro ([HF](https://huggingface.co/meta-models/Muse-Glimmer-30B)).
- **MiniMax M3** scores 75.19% verified and 22.3% partial on OSWorld 2.0 at about $2.40/task.
- **Xiaomi MiMo-V2.6-Pro/Flash** (MIT, reported) self-report 82.0/80.8 (**unverified**).
- **Meituan EvoCUA** scores 56.73% verified at 50 steps; the 8B scores 46.06%.

### Other agent frameworks on the verified board

Intelligence Indeed (90.19%, Apache-2.0 snapshot, Opus 4.7 core plus static and dynamic "skills"; [repo](https://github.com/intelligence-indeed/intelligence-indeed)), Pointer (83.64%), Coasty (82.81%), Laiye OpenAPA (78.34% with Gemini 3.1 Pro; [repo](https://github.com/laiye-ai/open-apa)), VLAA-GUI, Lenovo HIPPO and UiPath Screen Agent. Most top frameworks add a coding action. Prepared knowledge per app ("skills") seems to be the main way frameworks beat the raw model.

## Speed, steps and cost

### What has been measured

- **OSWorld-Human (MLSys 2026).** On 39 OSWorld tasks:
  - LLM planning, reflection and judging take 75-96% of wall-clock time. Grounding takes 1.8-3.9%, screenshots 0.4-1.7% and actions 0.7-1.6%.
  - Later steps take up to 3x longer than early ones because history grows.
  - Generating an accessibility tree took 3-26 s per step in their setup.
  - Agents take 2.7-4.3x more steps than the human minimum.
  - GTA1 (o3 planner) averaged $2.43 per task, 87% of it planning.
  - One Chrome loop cost $8.47 and 27 minutes over 18 steps. An SSH task took Agent S2 over 40 minutes.
  - The proposed Weighted Efficiency Score cut a 41.4% success agent to 15.6%.
  ([arXiv 2506.16042](https://arxiv.org/abs/2506.16042), [MLSys PDF](https://proceedings.mlsys.org/paper_files/paper/2026/file/5edb57c05c81d04beb716ef1d542fe9e-Paper-Conference.pdf))
- **UI-CUBE.** Agents need 1.5-3.3x more steps than humans on simple tasks (human: 5.6 steps) and 1.2-2.1x on complex ones (human: 41.4). ([arXiv 2511.17131](https://arxiv.org/abs/2511.17131))
- **OSWorld 2.0.** The primary protocol allows 500 steps, and agents average more than 250. Opus 4.7 at max effort used about 318 tool calls per task, versus about 30 on OSWorld 1.0. Output tokens per task for Opus 5 run from 29k at low effort to 108k at max. GPT-5.6 Sol used 85% fewer output tokens than Opus 4.8. ([OSWorld 2.0](https://osworld-v2.xlang.ai/), [JSON](https://osworld-v2.xlang.ai/static/data/leaderboard/official-results.json), [GPT-5.6](https://openai.com/index/gpt-5-6/))
- **Multi-agent.** MACU (manager plus parallel sub-agents over a DAG) reports +3.4-25.5% success and about 1.5x faster average completion on Odysseys. It was slower on serial web tasks. ([arXiv 2606.01533](https://arxiv.org/abs/2606.01533)) GPT-5.6 "ultra" runs 4 agents in parallel to reach results sooner ([OpenAI](https://openai.com/index/gpt-5-6/)).
- **Small/large routing.** One method runs a cheap policy by default and escalates to a large model only when "stuck" or "milestone" monitors fire. The abstract gives no numbers. ([arXiv 2604.27151](https://arxiv.org/abs/2604.27151))
- **Replay of learned workflows.** 3.4-5.1x lower latency and 15-217x lower cost per run, paying back after 3-27 runs ([arXiv 2609.36927](https://arxiv.org/abs/2609.36927)).

### Vendor speed and cost claims

| Claim | Source |
|---|---|
| GPT-6 Astra: OSWorld 2.0 in about 40 min/task vs about 75 for GPT-5.6 Sol; Codex harness update gives 1.9x faster completion on Mind2Web | [OpenAI](https://openai.com/index/gpt-6-astra/) |
| GPT-6.1 Sol: about 1/7 of Astra's cost per OSWorld 2.0 task; Ultrafast mode up to 8x token speed | [OpenAI](https://openai.com/index/introducing-gpt-6-1-sol/) |
| GPT-5.4 customer: 95% first-try success on about 30K portals, "~3x faster" and "~70% fewer tokens" than earlier CUA models | [OpenAI](https://openai.com/index/introducing-gpt-5-4/) |
| GPT-5.5: same per-token latency as 5.4; Fast mode 1.5x tokens/s at 2.5x cost | [OpenAI](https://openai.com/index/introducing-gpt-5-5/) |
| Opus 5.5 Fast mode up to 2.5x speed at $8/$40; Sonnet 5.5 30%+ faster than Sonnet 5 | [Opus 5.5](https://www.anthropic.com/claude-opus-5-5), [Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5) |
| Gemini 3.5 Flash-Lite: 350 output tok/s | [Google](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-6-flash-3-5-flash-lite-3-5-flash-cyber/) |
| Holo3.1-35B-A3B on DGX Spark: step time 6.8 s to 3.3 s; 18.1 requests/min with NVFP4 | [H Company](https://hcompany.ai/newsroom/holo3.1) |
| Holo4: $0.05-0.08 per OSWorld task | [HF card](https://huggingface.co/Hcompany/Holo4-27B) |

What I could not find: an independent, like-for-like seconds-per-step or minutes-per-task comparison of Claude, GPT and Gemini computer use, or any published per-step latency for Codex computer use. We will have to measure these ourselves.

## Action spaces and conventions

| Model / API | Tool schema | Coordinates | Screenshot guidance | Multiple actions per turn | Structure input | Source |
|---|---|---|---|---|---|---|
| Claude 5.x on Claude API / Vertex | `{"type":"computer_toolset_20260801"}` gives 17 tools (`left_click`, `type`, `key`, `scroll`, `zoom`, `left_click_drag`, `wait`, ...), dispatched on `toolset_name` + `name` | Pixels in the screenshot you return, top-left origin. No display size param. After `zoom`, still full-screenshot space | Opus 4.7+: up to 2576 px long edge and 4784 visual tokens (about 3.75 MP). Docs suggest 1024x768 or 1280x720 for desktop. The API rejects oversized images rather than resizing. About 1,000-1,800 tokens per screenshot | Yes, ordered blocks; stop at first failure | Screenshots only | [docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) |
| Claude 4.5-4.8, or any Claude on Bedrock | `computer_20251124` (beta), one `computer` tool with an `action` field | Pixels in declared display size | 1568 px long edge, about 1.15 MP | Parallel tool use | Screenshots only | same |
| OpenAI GPT-5.4+, GPT-6.x | Responses API `{"type":"computer"}` returns `computer_call` with `actions[]` (`click`, `double_click`, `drag`, `move`, `scroll`, `keypress`, `type`, `wait`, `screenshot`) | Pixels in screenshot space | Use `detail:"original"`; 1440x900 or 1600x900 when downscaling. GPT-6/5.6: up to 30,000 patches | Yes, `actions` array | Optional "code mode": a function tool that runs Playwright or PyAutoGUI code. Recommended for `gpt-6-astra` | [CU guide](https://developers.openai.com/api/docs/guides/tools-computer-use), [recipes](https://developers.openai.com/api/docs/guides/tools-computer-use-integration) |
| Gemini 3.5 Flash+, 3.8 Flash, 3.5 Flash-Lite | Interactions API `{"type":"computer_use","environment":"browser"\|"desktop"\|"mobile"}`; actions include `click`, `type`, `scroll`, `hotkey`, `drag_and_drop`, `navigate`, `take_screenshot` | Normalized 0-999. Docs say 0-999 but samples divide by 1000 | Examples use 1440x900 | "Batch tool enabled" in model cards | Browser env returns the URL; you can exclude built-in functions and add custom ones | [docs](https://ai.google.dev/gemini-api/docs/computer-use) |
| Qwen3-VL, Qwen3.5-3.8 | OpenAI-style function calling; `computer_use` in the Qwen cookbook | Relative 0-1000. Qwen2.5-VL used absolute pixels | Cookbook applies `smart_resize`; usage is inconsistent across examples | Not documented | Not documented | [ms-swift guide](https://swift.readthedocs.io/en/latest/BestPractices/Qwen3-VL-Best-Practice.html), [issue 1640](https://github.com/QwenLM/Qwen3-VL/issues/1640) |
| UI-TARS-1.5 | Text output, e.g. `Action: click(start_box='(197,525)')` | Pixels in the `smart_resize` image (multiples of 28), rescaled to the screen | `MAX_PIXELS = 16384*28*28` | One action per step | No | [README_coordinates](https://github.com/bytedance/UI-TARS/blob/main/README_coordinates.md) |
| Holo3, 3.1, 4 | OpenAI-compatible. Agent mode returns `{note, thought, tool_call}` or native tool calls. Localization mode returns `{x, y}` | 0-1000 normalized. Holo1 and 1.5 used pixels | Not stated | Holo4 also does code and tool calls | Screenshots | [H quickstart](https://hub.hcompany.ai/quickstart), [Holo4 card](https://huggingface.co/Hcompany/Holo4-27B) |
| GLM-4.5V/4.6V, AutoGLM | Boxes inside `<\|begin_of_box\|>...<\|end_of_box\|>`; AutoGLM taps | 0-1000 (GLM-V), 0-999 (AutoGLM tooling) | Not stated | Not stated | No | [GLM-V](https://github.com/zai-org/GLM-V) |
| Fara1.5 | Mouse, keyboard, web search and memory actions via function calls | "Directly predicted coordinates" (space not stated) | Not stated | Not stated | No a11y tree | [microsoft/fara](https://github.com/microsoft/fara) |
| Nova Act | SDK `act("...")` natural-language steps | Hidden | Browser only | n/a | Browser | [AWS](https://aws.amazon.com/blogs/aws/build-reliable-ai-agents-for-ui-workflow-automation-with-amazon-nova-act-now-generally-available/) |
| Codex desktop CU (product) | Plugin invoked with `@Computer` / `@Chrome` | n/a | n/a | n/a | macOS AX tree plus screenshots (per MacStories) | [docs](https://developers.openai.com/codex/app/computer-use) |

On Retina (2x) displays, Anthropic says to downscale the screenshot by 2x or halve the coordinates. Every adapter needs the same handling. ([Anthropic docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool))

## Grounding vs planning

- **Planning is the bottleneck, not grounding.** In decomposed agents, grounding is 2-4% of latency and under 1% of cost ([OSWorld-Human](https://arxiv.org/abs/2506.16042)). Grounding errors still cause 23% of GTA1 failures and long loops, so accuracy matters even though speed does not.
- **Frontier general models now ground well on their own.** Single-model scores on the verified board (Fable 5, Opus 5, Muse Spark) match or beat planner-plus-grounder frameworks such as Agent S3. The best framework (Intelligence Indeed) wins by adding app knowledge, not a grounder.
- **Small and open models still benefit from a grounder or zoom.** On ScreenSpot-Pro, a zoom-in second pass adds 6-8 points for 8B models: Indeed-UI-8B goes from 73.4 to 81.0 and KV-Ground-8B from 73.2 to 80.5 ([official board](https://gui-agent.github.io/grounding-leaderboard/)). Claude's `zoom` tool is the same idea inside a frontier API.
- **Long-horizon planning** is what separates models on OSWorld 2.0. Strict completion collapses above about 163 minutes of human task length for every model ([OSWorld 2.0](https://osworld-v2.xlang.ai/)).

### Candidate local grounders and fast local agents

| Model | Params | License | Evidence | Fit on a 24 GB GPU |
|---|---|---|---|---|
| Holo3.1-4B / 9B | 4B / 9B | Apache-2.0 | AndroidWorld 71% | Yes, easily |
| Holo3.1-35B-A3B / Holo4-35B-A3B | 35B, 3B active | Apache-2.0 | 80.8% OSWorld (Holo4, self-reported) | Q4 GGUF should fit (about 18-20 GB, my estimate). NVFP4 needs Blackwell |
| Indeed-UI-8B | 8B | Not checked | ScreenSpot-Pro 73.4, 81.0 with zoom | Yes |
| KV-Ground-8B | 8B | Not checked | ScreenSpot-Pro 73.2, 80.5 with zoom | Yes |
| MAI-UI-2B / 8B | 2B / 8B | Not checked | ScreenSpot-Pro 57.4 / 65.7 | Yes |
| Fara1.5-4B / 9B | 4B / 9B | MIT (repo) | Browser agent; WebVoyager 80.8 / 86.6 | Yes |
| UI-TARS-1.5-7B | 7B | Apache-2.0 | Older; 29.6% verified | Yes |
| Muse Glimmer-30B | 30B | Apache-2.0 | ScreenSpot-Pro 75.4 (with zoom tool) | 4-bit, under 20 GB |
| Qwen3.8-27B | 27B dense | Apache-2.0 | 84.3% OSWorld-Verified (self-reported) | 4-bit should fit (my estimate) |

Holo2 and Holo1.5 are CC BY-NC, so they are out for a commercial-friendly open-source default.

## Running the benchmarks ourselves

### OSWorld-Verified (OSWorld 1.x harness)

- **Providers.** VMware Workstation/Fusion, VirtualBox (weak parallelism), Docker with KVM, Modal, Daytona and AWS. AWS parallelism brings a full run under an hour. Windows and Linux hosts can use VMware Workstation Pro or Docker. Apple Silicon needs VMware Fusion. ([OSWorld repo](https://github.com/xlang-ai/OSWorld))
- **Task sets** (counted from the repo on 2026-10-11):
  - `test_small.json`: 39 tasks across all 10 domains (17 multi-app)
  - `test_nogdrive.json`: 361 tasks, the standard set
  - `test_all.json`: 369 tasks
  - `examples_windows`: Windows tasks (43 per the site)

  ([evaluation_examples](https://github.com/xlang-ai/OSWorld/tree/main/evaluation_examples))
- **Running it.** `scripts/python/run_multienv.py --num_envs N --provider_name docker` runs in parallel. Custom agents implement the `mm_agents` interface. Some tasks need Google OAuth or a proxy, or they fail.
- **Verified submission.** The maintainers run your agent code, or trusted institutions share trajectories. ([OSWorld site](http://osworld-v1.xlang.ai/))
- **Cost estimate.** API cost scales with steps × tokens per step. OSWorld-Human measured $2.43/task for an o3-planner agent ([arXiv 2506.16042](https://arxiv.org/abs/2506.16042)). A 39-task smoke run with a frontier model is plausibly $20-150 per run (my estimate, unverified).

### OSWorld 2.0 / 2.1

- **Setup.** 108 tasks, or 82 in the offline subset. Requirements:
  - Python 3.12+ and `uv`
  - Gated Hugging Face datasets (auto-approved)
  - Self-hosted mock websites and a self-hosted GitLab
  - Images for Docker (`xlangai/v2-image@osworld-v2.1`) and AWS only; other providers need a converted image
  - Pin `osworld-v2.1`
  - Included harnesses: Claude, GPT (Responses API) and Qwen (OpenAI-compatible)

  ([OSWorld-V2 repo](https://github.com/xlang-ai/OSWorld-V2))
- **Cost and time.** Expect $2.40-36 per task in model API cost and tens of minutes per task. A full 108-task frontier run is $1,500-3,900 on the official board's estimates. That is too expensive for routine iteration.

### WindowsAgentArena

- **Setup.** Docker plus KVM with a Windows 11 Enterprise Evaluation ISO (about 6 GB) and a 30 GB golden image, built once in about 20 minutes. The default VM uses 8 GB RAM and 8 cores. It runs on Linux or on Windows through WSL2.
- **Scale.** Azure ML can run 40 VMs in parallel. 2024 figures: about $8 in VMs plus $15-100 in model cost, roughly 30-35 minutes for the full set.
- **Stalled.** No release since 2024-11 (the "hard" mode), and no maintained leaderboard. ([repo](https://github.com/microsoft/WindowsAgentArena))

### Local hardware we have

Checked on this machine on 2026-10-11:

- WSL2 has `/dev/kvm`, 32 threads and about 15 GB RAM allocated.
- Docker is not installed inside WSL.
- The Windows host has an RTX 4090 with 24 GB.

That RAM is enough for one or two OSWorld Docker VMs or one WAA VM at default settings. For full-set runs, AWS (OSWorld) or Azure (WAA) parallelism is the practical path. The 4090 can serve a 4-9B grounder, or a 3B-active MoE at 4-bit, alongside.

### Lightweight options for fast iteration

- OSWorld `test_small.json` (39 tasks).
- The OSWorld-Human 39-task subset with per-task minimal human step counts, for an efficiency score ([arXiv 2506.16042](https://arxiv.org/abs/2506.16042)).
- OSWorld 2.1 offline (82 tasks), but only for occasional long-horizon checks.
- ScreenSpot-Pro for grounder A/B tests: offline, cheap and fast.

## Implications for our project

1. **Target the three native CU tools first and match their conventions in our MCP schema.** Claude (`computer_toolset_20260801`: Opus 5.5, Sonnet 5.5, Haiku 5.5), OpenAI (`computer` tool: `gpt-6.1-sol` for cost, `gpt-6-astra` for peak) and Gemini (`computer_use`: 3.8 Flash and 3.5 Flash-Lite). Claude and OpenAI already agree on "pixels in the screenshot you sent", so that is the right default for our MCP `click(x, y)`. Add an explicit `coord_space` option (`pixels` | `norm1000`) so Gemini, Qwen, Holo and GLM agents can pass their native outputs without doing math in the prompt.
2. **Make batching first-class.** All three labs moved to several actions per model turn, and OSWorld-Human shows model calls dominate wall-clock time. Our MCP tool should accept an ordered action list, stop at the first failure, and return one screenshot at the end. That copies Anthropic's semantics, which are the most precisely specified.
3. **Offer a `locate(description)` grounding tool backed by a local model.** This lets any agent, including text-heavy or weak-vision ones, act by description instead of emitting coordinates. Start with Holo3.1 (Apache-2.0, 4B/9B) or Holo4-35B-A3B (Apache-2.0, 3B active) on the 4090, with a zoom-in second pass. Check licenses for Indeed-UI-8B and KV-Ground-8B before considering them; they top the open ScreenSpot-Pro board.
4. **Build in the accessibility-tree fast path.** Codex's macOS CU reportedly reads the AX tree. UFO2 mixes UIA and COM calls with clicks and cuts LLM calls by 51%. OSWorld-Human shows screenshots and actions are cheap while model calls are expensive. A11y data should be an optional, size-capped observation, never a required one, since tree generation took 3-26 s in OSWorld's Linux setup.
5. **Treat open weights as a serious tier.** Qwen3.8-27B (84.3%) and Holo4-35B-A3B (80.8% at $0.05/task) are close enough to frontier on OSWorld-Verified that a fully local mode is realistic, if those self-reported numbers hold in our harness.
6. **Adopt OSWorld-Verified as the e2e benchmark, but score efficiency, not just success.** Success above about 85% is in evaluator-noise territory. Our run artifact should include, per task: success, wall-clock time, steps, model calls, input/output tokens, dollars, and a WES-style ratio against OSWorld-Human's minimal steps. That is how we show "as fast as Codex CU" with numbers. Use `test_small` (39) per change, the full 361 per milestone, and OSWorld 2.1 offline (82) per quarter.
7. **Get a Codex CU baseline on the same tasks.** OpenAI publishes no per-step latency for Codex CU, only relative claims (1.9x faster on Mind2Web with Astra). We need our own wall-clock measurements of Codex CU on a fixed task set, on macOS and on Windows, where it is foreground-only.

## Open questions

- How much accuracy do frontier models lose when they drive the computer through a generic MCP tool instead of their native CU tool, with its injected system prompt and trained action schema? I found no published measurement. This decides whether our MCP server should mirror each lab's schema exactly.
- What is Codex CU's real per-step latency and minutes per task? Its harness speedups (AX tree, background cursors, batching) are not documented in numbers.
- Do the self-reported open-weight scores (Qwen3.8-27B 84.3%, Holo4 80.8-85.2%) reproduce in the official harness? Harness effects cut both ways. Holo3's own blog number (77.8%) is about 5 points below its verified-board number (82.56%).
- Which OSWorld 2.x version will labs settle on? Anthropic quotes 2.1 while OpenAI and Google quote 2.0 `v2026.08.08` offline. Partial and binary also get mixed up.
- Licenses for Indeed-UI-8B, KV-Ground-8B and MAI-UI weights were not checked.
- Is there a maintained Windows benchmark with 2026 frontier results? WAA has stalled, and the best numbers come from one paper (UI-Mate). A Windows-native e2e suite may have to be ours.
- Gemini's coordinate range (0-999 in tables, /1000 in samples) needs a quick empirical check at screen edges.
