# CANNBot-Insight

Session-level observability for LLM coding agents: import agent session logs and analyze tokens, context, subagents, and skill usage turn by turn.

**[中文文档](README-zh.md)**

## Features

Import SQLite (opencode.db) or JSONL (native Claude Code / Codex `rollout-*.jsonl` / DSH `session.v4.jsonl(.zstd)` / cpx proxy captures; plaintext, `.jsonl.7z` and legacy `.jsonl.gz`, `cpx-` prefix handled) and explore the session detail tabs. A single "JSONL (auto)" entry detects Claude vs Codex vs DSH per file content — no per-framework picker:

- **Tokens & Cost** — 5-item per-turn token breakdown vs the model's context window, plus cost estimation
- **Active / Wall time** — session detail Wall Clock split (active + inactive = wall) and Active / Wall columns on the homepage: event-clustering semantics (gaps >5min count as inactive, in-flight API calls count as active)
- **Context Growth** — Per-subagent context growth curves with animated replay; `/compact` markers
- **Context Governance** — Per-turn LLM input composition: visible messages + stable System overhead
- **Subagent Tracking** — Subagent sessions and dispatch→response bridges, inline in the timeline
- **Turn Quick-Jump** — Type `#459` + Enter in the Turns timeline to jump to that turn
- **Wire Rounds** (proxy captures) — Per-round full wire input/output, cross-checked against the DB reconstruction; shown with `-a`
- **Skill Events / Coverage / Content** — Per-turn skill events, available-skills vs used comparison, SKILL.md full-text rebuild
- **Agent Definition Recovery** — One-click full text of dispatched agents' `.md` definitions: session system-injection first, disk scan fallback
- **Concept Tracing** — Cross-turn keyword search, propagation chains and DAG; filter by source/thinking/tool
- **File Read Analysis / Restore / Gather** — Duplicate-read detection, per-file line-by-line rebuild, whole-directory rebuild as zip
- **Session Compare** — Two sessions side by side: tokens / cost / latency / tools / subagents
- **Trajectory Scoring** — Six-dimension scorecard (completion veto / trust / quality / efficiency / redundancy / autonomy + custom dims), baseline comparison and scoring profiles
- **Audit** — Workflow audit (flow chart + per-node findings + priorities) and Skill audit (real execution vs SKILL.md / agent definitions / workflow declarations)
- **Key Redaction** (proxy captures) — API keys never touch disk: masked (`abcd…wxyz`) at the single write chokepoint

The homepage Sessions list supports keyword / session-ID search; the import dialog offers one-click default paths.

**Run Observation** — A top-level Runs domain (next to Sessions) for Opsbot graph runs: import a workflow-bundle directory (`workflow.json` + `sessions/`) via the web "导入 Bundle" entry (same dialog flow as Import Session: browse directories, bundle dirs containing `workflow.json`/`manifest.json` are highlighted and import on click) or `cbi import-bundle <dir>`; all member sessions are imported immediately through the standard pipeline — **run-imported sessions live only inside the run detail view, never in the Sessions list** (deleting a run also deletes the sessions it imported; sessions that existed before the import are untouched). The run page renders the multi-generation DAG (rollback generation bands, retry history, carried / not-yet-run placeholders, generator subgraphs) as pure SVG, with per-node attempt history (verification verdicts, Bash output) and click-through to member session turns; session pages show a run badge linking back to the run. `cbi runs` lists imported runs.

**Run Logging** — Server-side process logs (import pipeline, lake sync, API errors) are written to `~/.cannbot-insight/logs/insight-<date>.log` (daily rolling) and optionally mirrored to the startup terminal. Level, file output and screen output switches are adjustable live in Settings → Run Logging (log location shown there; no restart); env vars (`CANNBOT_LOG` / `CANNBOT_LOG_LEVEL` / `CANNBOT_LOG_FILE` / `CANNBOT_LOG_STDOUT` / `CANNBOT_LOG_DIR`) take precedence over the settings page.

## Install & Usage

### Option 0: npm install (Recommended)

```bash
npm install -g cannbot-insight
cannbot-insight            # first run: auto-build + migrate (~30s-2min), then start + open browser
```

- Requires Node.js >= 22.12; mainland-China networks can add `--registry=https://registry.npmmirror.com`
- Offline fallback: `npm install -g ./cannbot-insight-<version>.tgz`
- Writable state lives in `~/.cannbot-insight/`; default port 21025 (auto-increments if occupied)
- CLI subcommands pass through: `cannbot-insight upload --file … --list` / `sessions`; short alias `cbi`
- Python 3 optional (starts the smart-agent analysis backend when present)
- Alternate brand: `npm install -g context-insight` — the same tool published under the Context-Insight name (commands `context-insight` / `ctxi`, data dir `~/.context-insight/`); session data is fully interchangeable with cannbot-insight (shared format identity)

| Flag | Effect |
|------|--------|
| `-a`, `--advanced` | Show advanced tabs (wireRounds/replay) |
| `-k`, `--kill` | Stop all insight/smart-agent instances of this repo, then start on 21025 (falls back to the next free port if occupied by others) |
| `-f`, `--fresh` | Clear the build cache and rebuild |
| `-h`, `--help` | Print the full CLI reference — all subcommands and flags (incl. `-v, --version`) |

### Option 1: Web UI from source

```bash
./start.sh              # production mode (default): cached build + zero per-request compile
./start.sh -u           # update deps, then start
./start.sh -f           # force a fresh build
./start.sh -d           # dev mode (hot reload while editing source)
```

- Requires Node.js >= 22.12; `./start.sh` also installs the `cpx` capture command (see `../cpx/README.md`)
- Open `http://localhost:21025`

Log file locations:
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/` (directory auto-scan)
- Codex: `~/.codex/sessions/` (rollout files; subagent sessions merge into their parent)
- DSH: `~/.dsh/sessions/` (`session.v4.jsonl` / `.jsonl.zstd`; subagent sessions merge into their parent)

The Web UI also supports exporting sessions to standalone SQLite or Markdown. The LLM provider panel embeds a known-provider Base URL quick reference.

### Option 2: CLI Import + Web Analysis

For SSH remotes and other browser-less environments (one-time `npm install` + `npx prisma migrate deploy`; the import command auto-starts the backend afterwards):

```bash
# opencode: list / import specific / interactive
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --session-id <id> --yes --json

# Claude Code: directory scan / single file
npx tsx src/cli/index.ts upload --file ~/.claude/projects/ --list
npx tsx src/cli/index.ts upload --file ~/.claude/projects/<hash>/<uuid>.jsonl --session-id <uuid> --yes --json

# Codex: native rollout files (subagent sessions merge into their parent)
npx tsx src/cli/index.ts upload --file ~/.codex/sessions/ --source codex-jsonl --list
npx tsx src/cli/index.ts import --source codex-jsonl --dir ~/.codex/sessions/ --all --yes --json

# DSH: native session logs (subagent sessions merge into their parent)
npx tsx src/cli/index.ts upload --file ~/.dsh/sessions/ --source dsh-native --list
```

| Option | Description |
|--------|-------------|
| `--file <path>` | Source path (.db / .jsonl / directory; type auto-detected) |
| `--session-id <id>` | Pick a specific session (skip the interactive picker) |
| `--description <text>` | Upload description |
| `--yes` / `--json` | Skip confirmation / JSON output (script-friendly) |
| `--list` | List available sessions only |
