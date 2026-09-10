# CANNBot-Insight

Session-level observability tool for LLM coding agents. Helps analyze long-context usage patterns, detect model hallucination issues, and govern context window growth across agent sessions.

**[中文文档](README-zh.md)**

## Features

Import SQLite (opencode.db or CANNBot-Insight archive, auto-detected) or JSONL (Claude Code / cpx proxy capture) logs, then analyze Agent sessions turn-by-turn. Both plaintext `.jsonl` and gzip-at-rest `.jsonl.gz` (cpx's compressed capture form) are accepted everywhere — file browser, typed path, and directory scan — with the proxy's `cpx-` filename prefix stripped automatically so manual imports land on the same taskId as capture-exit auto-import. Quick-jump buttons under File Path open common default directories in one click (no level-by-level browsing): JSONL source offers "cpx proxy capture → `~/.cannbot-insight/proxy`" and "Claude native → `~/.claude/projects`", SQLite source offers "opencode data → `~/.local/share/opencode`", plus a home-directory button; `~` is expanded server-side by the browse API; the homepage Sessions list supports keyword / session-ID search (`?q=` server-side filter over taskId/query/label, Enter or button to submit, Clear to reset, hit count shown as N of M); the session picker after SQLite load offers the same filtering (select-all applies to the filtered view):

- **Tokens & Cost** — 5-item token breakdown per turn with bar chart relative to model context window; cost estimation from token usage and model pricing
- **Context Growth** — Context growth chart per subagent session; animated replay of context window evolution with subagent spawn/death markers; `/compact` markers with context-drop annotations across multiple compactions
- **Context Governance** — View LLM input context composition: visible messages + stable "System (hidden)" overhead; input window correctly truncated at each `/compact` boundary
- **Subagent Tracking** — Identify subagent sessions and dispatch→response bridges; subagent turns surface inline in the Turns timeline with badges, and counts appear in the Overview cards
- **Turn Quick-Jump** — In the Turns timeline, type a turn number (e.g. `#459`) and press Enter to jump straight to that turn and scroll it into view; subagent turns auto-expand their ancestor dispatch lanes
- **Wire Rounds (proxy captures)** — Rebuild each wire round directly from the cpx capture file: full input (accumulated messages with new-of-this-round highlighted) plus output (raw response), to cross-check the DB-reconstructed LLM Input; tab hidden by default, shown with `./start.sh -a`
- **Key Redaction (proxy captures)** — API keys never touch disk: sensitive fields and vendor key shapes (`sk-ant-` / `AIza` / `gsk_` / `LTAI` / `Bearer` / env echoes / URL query params) are masked (`abcd…wxyz`) at the single write chokepoint before capture files are written; the cpx launch log is masked with the same rules
- **Round-Pair Turns (proxy captures)** — Proxy sessions split Turns into per-round input/output pairs (badged in the timeline): input turns list this round's new verbatim wire messages one by one; output turns store the accumulated request at import and serve it verbatim, preserving exact wire order (including tool_result vs system-injection interleaving) with no reconstruction
- **Skill Events** — Track skill load/invoke/use events per turn
- **Skill Coverage** — For claude-format sources (proxy captures of claude/opencode/codex + native claude-code sessions): compare the available-skills list from the persisted system injection (wire-verbatim system prompt for captures, system-line injection for native claude) against skills actually used in the session; unused skills are highlighted first (ring center count + lead position), then invoked / loaded-only / dispatched / not-in-list; native opencode sessions (system prompt never persisted) hide the card entirely
- **Proxy Capture Classification** — Single authoritative classifier (`src/lib/ingest/proxy-classify.ts`) for all proxy-capture detection: signal priority `cc-session-meta` (file-level) > line-level `source` marker > wire fingerprint (top-level `system`/`tools`, for early unmarked captures); agent attribution covers claude-code / opencode / codex / cannbot; all proxy captures (any agent) are claude-format jsonl for wire rounds / full-context / refresh. `cpx cannbot` captures the CANNBot CLI (opencode-based fork, gateway auto-discovery, see `../cpx/CANNBOT-DESIGN.md`) in one command
- **Skill Content (SKILL.md 全文)** — Per-skill button in Skill Summary and Skills per Agent reconstructs the skill's full SKILL.md content from the native Skill tool injection or Read-of-SKILL.md results; supports download
- **Agent Definition Recovery (agent .md 全文)** — Per-subagent row in Skill Summary offers **two side-by-side buttons** for comparing the dispatched agent's `.md` definition: **全文·磁盘** (disk scan via `AGENTS_SCAN_ROOT`, session-coverage disambiguation — the original path, current file state) and **全文·会话** (recovered **from the session itself**: subagents read their own agent `.md` at runtime, and those Read results are the definition that was actually in effect — byte-faithful even after the file has since been edited/deleted, multi-plugin name collisions resolve to the file the session actually read, latest read wins, multi-segment reads line-merged). Both panels can stay open simultaneously for diffing; each downloads separately
- **Concept Tracing** — Search keywords across turns, view propagation chain and DAG graph; refine results by source type, thinking, or tool; clicking a result's "View Turn" jumps to the Turns tab and auto-expands + highlights the keyword at its match location (content / tool args / result / error)
- **File Read Analysis** — Detect duplicate and unnecessary file reads
- **File Content Restore (循迹复卷)** — Per-file button reconstructs the full file content from collected read/write tool calls by timestamp (last-write-wins per line); uncovered lines marked `--line N not found --`; supports download
- **Gather & Rebuild Directory (重编汇册)** — One-click rebuild all read/written files in the session's working directory, preserving the path tree; download as a zip (pure-JS STORE, no deps)
- **Session Compare** — Compare two sessions on tokens, cost, latency, tool calls, and subagents
- **Trajectory Scoring v2 (six-dimension framework)** — the Score tab in the session detail page (also at `/scoring/<taskId>`) scores the session on outcome-oriented dimensions: **D1 Completion** (veto; three-state 完成/未完成/无法判定 from end-reason gate, TodoWrite self-report, plan reconciliation and verified test runs, plus LLM acceptance-checklist / goal-coverage reconciliation that upgrades 无法判定 only; **unfinished vetoes the total to 0** — a sanction, not a measurement, excluded from baseline corpora — while every other dimension still scores normally for diagnosis; truncated sessions abort the whole card), **D2 Trust** (weighted 15%; rule layer with a self-built lightweight shell parser for destructive ops, secret detection that only counts write-to-file & outbound, and out-of-bounds path access; LLM layer for declared redlines and authorization/evasion review — a confirmed violation zeroes the dimension itself instead of the total, suspected findings deduct 0.2 each and are disclosed), **D3 Quality** (35%; a user-entered CANN-Bench score (from cannbench.com, 0-100 converted to 0/10, defaulting to the clearly-labeled on-par 80 band until filled) + test-result and naked-write rules + five LLM rubric items; "correctness floor" caps the dimension at 4/10 when correctness ≤ 2), **D4 Efficiency** (15%; token 30% / parallelism 30% / LLM-time 15% / tool-time 15% / turns 10% — the four ratio items compare against the same-task baseline session (one exemplar per task type, set via the「设为基线」button; 25% leaner than baseline tops out at 1.0, twice the baseline scores 0; until a baseline is set they default to 80, the "on-par" band, clearly labeled), parallelism is an absolute curve (union-of-intervals, serial = 0.8, 1.75× = 1.0, reward-only); waste attribution is diagnostic-only), **D5 Redundancy** (15%; **subagent redispatch 55%** — same-task dispatches cluster by id in the description (Task29 / Task15.1, ordinal words like 重新/第二次 tolerated), each redispatch costs 50 call-equivalents so one is noticeable and five floor it; env-failure retries (timeout/network/rate-limit) are exempt — plus verbatim repeats 15% (same tool+args fired ≥3 times consecutively), avoidable tool-call errors 10% (env failures exempt; identical-refire segments count only the first error, refires belong to verbatim repeats — each error is wasted work once; its cost is already charged in the D4 ratios), intra-request duplicate injection / stale tool results / project-doc relevance / process proficiency 5% each; unused tool descriptions and unused skills are **statistics-only**, not scored — the lists are fully injected every session so one session's non-use proves nothing), **D6 Autonomy** (20%; interrupts and repeated-message deductions + LLM nine-class message classification where genuine-ambiguity clarifications never deduct), and **D7 user-defined custom dimensions** (optional; managed as groups with one-click export/import; LLM-scored and rule-judged kinds with try-on-this-session; see the D7 bullet in the tab). A **scoring profile** overlay (「评分配置」) sits on top of the built-in rubric: toggle which sub-items participate (D1's four rule items stay fixed to protect the veto evidence chain; deselected items leave the coverage denominator), override item and dimension weights (engine-normalized, no need to sum to 1), add custom LLM/rule items inside any dimension (score-only, never verdicts; D2/D6 targets render display-only), switch built-in presets (default / quick no-LLM / operator-heavy / minimal core), import/export profiles as JSON, and reset to the default rubric — the card snapshots the active profile, and totals scored under different profiles are flagged incomparable. Aggregation: D1-unfinished veto → weighted average (D2 15 / D3 35 / D4 15 / D5 15 / D6 20) × coverage discount. Every judge call follows the forced-CoT contract (reason fields are written before score fields; parser is key-based so nothing to migrate), is cost-accounted on the card, and parse failures become explicit error records. Scorecards persist as self-contained JSON under `~/.cannbot-insight/scorecards/`; judge process logs (every LLM attempt verbatim, per-item subagent streams, human-readable run header/footer with `cc-judge-run` payloads) land under `~/.cannbot-insight/score-judge-logs/<sessionId>/` and re-import as subagent rounds.
- **Audit** — Paste or import the workflow-analysis JSON (produced by the Audit prompt + Claude Code) to render the actual flow chart with per-node problems, the G/S 8-dimension skill-quality board, and optimization priorities. `§N` turn refs in evidence are clickable to jump to that turn; parallel branches (same `parallel` id) render in one row; the 3 slowest nodes are highlighted in red; supports importing JSON from a file and exporting the rendered analysis back to a file. Generation state survives tab switches (cross-tab resume); failed generations also persist as refresh-safe, exportable reports with the error, elapsed time, and complete progress trail, instead of leaving the previous report looking current. **v4**: agent-centric 3-dimension audit (completion / efficiency / quality) — deterministically extracts each agent's input/output/envelope first, then LLM judges completion & quality while efficiency is computed from the envelope; renders an agent tree. The agent tree hides fully-passing subagents by default (toggle to reveal them); cross-agent issues and optimization priorities each cite evidence (`agent:<name> #turn`) with clickable turn jumps, and the audit header shows the audit's total token consumption. The Audit tab is split into two sub-tabs: **Workflow audit** (the v1-v4 analysis above) and **Skill audit** — run sift's `audit` against the current session to reconcile real execution vs each invoked skill's SKILL.md (no re-run), vs each dispatched agent's `.md` (two-tier declaration recovery: proxy subagent system injection [the copy actually in effect at runtime — remote version at the time, naturally unambiguous across plugins] as the primary path, local `AGENTS_SCAN_ROOT` disk scan as fallback; audit slicing matches role names — bridge.subagentType / dispatch role sentence — task titles no longer used as agent names), and vs the main agent's combined workflow declaration (`--kind root` — audits the top-level main agent's orchestration; the declaration is a layered concatenation of a regulation layer (skill resources / SKILL.md body / turn0 ≥500-char injected orchestration rules) and a plan layer (task commitments from STATE.md-like plan-file Reads; todowrite / Write artifacts / content-scan fallbacks are excluded by design), surfaced when either layer is recoverable, auditing both orchestration discipline and task completion in one run). The deterministic extraction of the combined declaration is **plugin-based** (`workflow-extract-plugins.json`, schema in `workflow-extract-plugins.json.example`): the built-in cann-ops plugin keeps all existing recognition heuristics (plan filename whitelist / skill-packaged dirs / thresholds) as defaults, and other domains switch in zero code by copying the example and adjusting the conventions; there is also an **llm-root generalization path** (domain-plugin-free): candidates are collected deterministically (turn0 injection / skill bodies / plan-file snapshots, zero domain heuristics), then the claude CLI outputs only a JSON picking which candidate per layer — body text always comes verbatim from the DB, and normalization plus assembly share the same function as the deterministic path (`assembleCombinedDeclaration`), so "extract-and-concatenate yes, tamper no" holds by construction, and when recognition is correct both paths produce byte-identical output, with per-target summary + a native report view (no iframe): five-state verdict badges, layer badges on findings under the root combined declaration (regulation = teal orchestration discipline / plan = purple task commitment, matched by instruction text), filterable findings (by verdict / category / method / instruction-or-evidence text), multi-transcript by-instruction tables, collapsible per-instruction grouping with FAIL-first sort, a verdict/method legend, and a "open raw sift HTML" escape hatch. A real-time progress bar with percentage streams during the run (parsed from sift's on_progress output); results persist across tab switches; requires the `sift` + `claude` CLIs; `AGENTS_SCAN_ROOT` env (defaults to auto-detected skills-dev repo root) for agent audit.

## Option 0: npm install (Recommended)

No source clone, no manual env setup, no file transfer. One command from the public npm registry:

```bash
npm install -g cannbot-insight
cannbot-insight            # first run: auto-build + migrate (~30s-2min), then start + open browser
```

- Runtime deps (next/prisma/better-sqlite3/...) auto-fetch from the public npmjs registry; first install compiles the `better-sqlite3` native module (~1-2 min, needs `python3`/`make`/`g++` or a prebuild hit). Requires Node.js >= 20.
- For mainland-China networks, use the npmmirror registry: `npm install -g cannbot-insight --registry=https://registry.npmmirror.com` (mirror auto-syncs from npmjs).
- `npx cannbot-insight` also works (no global install needed).

**Offline / air-gapped fallback: tgz file install** (obtain `cannbot-insight-<version>.tgz` from the maintainer / GitCode Release):

```bash
npm install -g ./cannbot-insight-<version>.tgz
```

All writable state lives in `~/.cannbot-insight/` (SQLite DB + `.next/` build cache); the installed package dir stays read-only. Port 21025 by default (auto-finds a free port if occupied).

| Flag | Effect |
|------|--------|
| `-a`, `--advanced` | Show advanced tabs (wireRounds/replay) |
| `-k`, `--kill` | Kill any process on port 21025, reuse it |
| `-f`, `--fresh` | Clear `.next` build cache and rebuild |

CLI subcommands pass straight through (same as Option 2, but no `cd`/`npx tsx` prefix):

```bash
cannbot-insight upload --file ~/.local/share/opencode/opencode.db --list
cannbot-insight sessions
cannbot-insight --help
```

**Requires Node.js >= 20.** Python 3 is optional (auto-detected): if present, the smart-agent backend (breather/v2 analysis) starts on port 21026; if absent, it gracefully degrades and the rest works normally.

## Option 1: Web UI

**Requires Node.js >= 20.x** (v18.19.x fails to install better-sqlite3 / Prisma 6). If you have nvm, `start.sh` auto-switches to Node 20 LTS.

Log file locations:
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/<hash>/sessions/<id>.jsonl`, or point to a directory to scan all .jsonl files

Linux (for Windows systems, use start.bat instead):

```bash
./start.sh          # Auto install + migrate + start Web UI on port 21025
./start.sh -u       # Update dependencies + migrate + start Web UI
./start.sh -f       # Fresh build (clear .next cache, rebuild from scratch)
```

`./start.sh` also installs the `cpx` capture command (`cpx claude` / `cpx cannbot` / `cpx codex` capture plaintext agent↔model traffic); cpx installs standalone too — `../cpx/install.sh` — and capture works without insight running; `cpx list` browses captures (mtime descending) and import is insight's own job: its Web UI import (JSONL source covers the proxy dir) or the automatic import that fires when insight is running at capture exit (see `../cpx/DESIGN.md`).

Open `http://localhost:21025`. After importing a log file, click a session to explore 9 analysis tabs.

Web UI also supports: exporting sessions to standalone SQLite or hierarchical Markdown; uploading sessions to CANNBay v2 (an atomgit dataset repo) with a description dialog plus a mandatory paradigm-directory picker (the repo's top-level dirs are the paradigm registry — 25 operator-compute paradigm categories + `others`; adding a paradigm = creating a top-level dir in the data repo, zero insight-side knowledge; legacy `sessions/` stays as the unlabeled area, and re-uploading with a different paradigm moves the session folder atomically in one commit; an **operator-generation outcome** annotation (success / failure) is mandatory at upload time — it rides the session's `cc-session-meta` optional field `opGen` into the repo and shows up as the "算子生成" column in the CANNBay session list; the session detail page header (next to Export HTML) also offers an upload entry sharing the same dialog); an optional "set as paradigm baseline" checkbox moves the session into `<paradigm>/baseline/` (the scoring baseline — position is identity, and replacing it atomically swaps the old baseline back to the paradigm's normal directory in one commit)). Uploads use the proxy-capture claude-jsonl folder format (main session + subagents); opencode sessions are exported to jsonl from the DB automatically. Every upload passes mandatory data governance (secret redaction + residue circuit-breaker — no keys leave the public repo); jsonl streams are gzip-at-rest (compressed at capture time, stored as .jsonl.gz in the repo, transparently decompressed by readers — plain `zcat` works, see ../cpx/COMPRESSION-DESIGN.md). CANNBay listing/download uses a partial-clone (`--filter=blob:none`) persistent mirror: listing reads metadata only (instant, including the session type column read in bulk from `cc-session-meta`; `producer=cpx` captures also show the proxy badge), importing one session fetches just its blobs on demand — fast even with thousands of sessions. The legacy .db-snapshot upload/parse (gitcode CANNBay) remains available at the API level for reading historical data, hidden from the UI. All upload/capture/export jsonl now also carries a declarative `x_cannbay` extension namespace (envelope frozen, `{schema, version, data}` pockets — spec: docs/cannbay-schema-spec.md) with 6 export losses fixed (reasoningTokens/ttftMs/ToolCall details/framework/model params/wire status); a column-exhaustive round-trip IT proves DB → export → re-import loses nothing.

Since v1.88 the data-lake remote is configurable in Settings: a single address input (default value = the built-in data-lake repo; any git URL can be pasted, e.g. `https://ai.gitcode.com/cann_corpus/trace_corpus` — `ai.gitcode.com` is normalized to `gitcode.com` automatically; when the address equals the default it is omitted from requests so backend env semantics are preserved), auth via none (anonymous) / account+password / token (gitcode has removed password-based git auth — PAT only; the "Test connection" button sits right after the credential fields and actually validates the address plus password/token: choosing an auth mode with empty fields fails immediately, and success distinguishes "credentials verified" from "anonymous access")), plus optional branch (default main; pickable from the remote's branch list) and directory (replaces the default `sessions/` prefix for listing/import scope and upload target alike; pickable from a drill-down browser instead of typed). Config resolution: request body > env vars (`CANNBAY2_REMOTE_URL/PUSH_URL/BRANCH/CACHE_DIR`) > built-in defaults — unconfigured deployments behave exactly as before, and mirror caches are isolated per address+branch. Credentials live in browser localStorage only and are sent per-request to the local backend for git auth (never stored in the DB or logs; error messages are credential-redacted). Note: existing flat-layout files in trace_corpus (`<category>/<month>/<submitter>/<uuid>.jsonl`, no per-session folder) are not listed — list/import understand the `<dir>/<sid>/` folder convention only. Since v1.98 the LLM provider panel embeds a quick reference of known provider Base URLs (Alibaba DashScope / Zhipu GLM Plan coding endpoint & pay-as-you-go endpoint / Volcengine Ark / DeepSeek / OpenAI / Moonshot / local Ollama·vLLM) — click a row to fill the address and sample model. Rule of thumb: fill up to the version segment (/v1, /v3, /api/paas/v4…) and /chat/completions is appended automatically; leading/trailing whitespace is trimmed (a pasted trailing space once produced a malformed `/v4%20/v1/…` path and a 404).

## Option 2: CLI Upload + Web Analysis

Designed for SSH remote servers, Web IDEs, and other environments without a browser. CLI imports and uploads in one step, then analyze in Web UI.

Log file locations:
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/<hash>/sessions/<id>.jsonl`, or point to a directory to scan all .jsonl files

### One-time Setup (first run in a new environment)

```bash
cd cannbot-insight
npm install
echo 'DATABASE_URL="file:./dev.db"' > .env
npx prisma generate
npx prisma migrate deploy
```

Takes ~1 minute. No need to repeat unless dependencies change. The upload command auto-starts the backend — no need to run `start.sh` manually.

### Upload a Session

**opencode:**

```bash
# List available sessions
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list

# Upload a specific session (non-interactive, script-friendly)
npx tsx src/cli/index.ts upload \
  --file ~/.local/share/opencode/opencode.db \
  --session-id <session-id> \
  --description "description" \
  --yes --json

# Interactive session picker + description prompt
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db
```

**Claude Code:**

```bash
# List available sessions (point to projects dir, auto-scans .jsonl recursively)
npx tsx src/cli/index.ts upload --file ~/.claude/projects/ --list

# Upload a specific session (session-id = .jsonl filename without extension)
npx tsx src/cli/index.ts upload \
  --file ~/.claude/projects/ \
  --session-id <uuid> \
  --description "description" \
  --yes --json

# Or point directly to a single .jsonl file
npx tsx src/cli/index.ts upload --file ~/.claude/projects/<hash>/<uuid>.jsonl --list
```

| Option | Description |
|--------|-------------|
| `--file <path>` | Source path: opencode `.db` file / Claude Code `.jsonl` file or directory; source type auto-detected |
| `--session-id <id>` | Upload a specific session (skip interactive picker) |
| `--description <text>` | Upload description (skip interactive prompt) |
| `--yes` | Skip confirmation prompt |
| `--json` | JSON output (non-interactive, script-friendly) |
| `--list` | List available sessions without uploading |
| `--framework <name>` | Framework type (auto-inferred: opencode-db → opencode, claude-jsonl → claude-code) |

After upload, view analysis in Web UI: click the **CANNBay** button during import, pick a paradigm directory (top-level dirs are the registry, with per-paradigm session counts and a baseline marker) and then select session folders under it to import (the baseline session is badged and pinned to the top; blobs fetched on demand) — no manual clone needed.

## Option 3: Zero-dependency Session Export

Extract a single session (with subagents) from opencode.db or Claude Code JSONL into a standalone file. **Zero dependencies** — requires only Node.js >= 22 (built-in `node:sqlite`); no `npm install`, no Prisma, no backend. Auto-detects framework from `--file`: `.db` → opencode, `.jsonl`/directory → Claude Code.

```bash
# List available sessions (auto-detect source)
node export-db.mjs --list
node export-db.mjs -f ~/.claude/projects/ --list

# Interactive session picker
node export-db.mjs
node export-db.mjs -f ~/.claude/projects/

# Export a specific session
node export-db.mjs -s ses_xxx                          # opencode
node export-db.mjs -f ~/.claude/projects/ -s <uuid>     # Claude Code

# Export to a custom path
node export-db.mjs -s ses_xxx -o ~/my-session.db
node export-db.mjs -f ~/.claude/projects/ -s <uuid> -o ~/my-session.jsonl

# JSON output (script-friendly)
node export-db.mjs -s ses_xxx --json
```

When `-o` is omitted, output defaults to the script directory:
- opencode → `dbfile/session_<id>.db`
- Claude Code → `jsonlfile/<id>.jsonl`

The exported file can be re-imported into Insight or uploaded to CANNBay via Option 2's `upload --file` command:

```bash
npx tsx src/cli/index.ts upload --file /abs/path/to/session_xxx.db  --session-id ses_xxx --yes --json
npx tsx src/cli/index.ts upload --file /abs/path/to/<uuid>.jsonl    --session-id <uuid>  --yes --json
```

| Option | Description |
|--------|-------------|
| `-f, --file <path>` | Source path (auto-detected: opencode.db or ~/.claude/projects/) |
| `-s, --session-id <id>` | Export a specific session (skip interactive picker) |
| `-o, --output <path>` | Output file path (default: `dbfile/` or `jsonlfile/`) |
| `-l, --list` | List available sessions without exporting |
| `-j, --json` | JSON output |
| `-h, --help` | Show help |
