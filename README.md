# Context-Insight

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
- **Trajectory Scoring** — Six-dimension scorecard (completion veto / trust / quality / efficiency / redundancy / autonomy + custom dims), baseline comparison and scoring profiles; besides the web "Mate Agent review" (rule layer computed in-process + local claude/opencode CLI judging the LLM items), the same scoring can run standalone without the server: `ctxi score --session <taskId> --tool claude|opencode [--framework fw] [--out result.jsonl] [--no-store]` reads the local database directly, streams an NDJSON event log (meta / progress / done / error) to stdout or a file, and persists the same scorecard as the web path by default
- **Audit** — Workflow audit (flow chart + per-node findings + priorities) and Skill audit (real execution vs SKILL.md / agent definitions / workflow declarations, with a declaration-coverage overview that renders the **original declaration snapshot** verbatim and paints coverage directly onto the text: green = exercised, amber = declared but unverified, gray = no checkable instruction extracted; hover a colored run for that segment's instruction summary; instruction-coverage and text-coverage metrics reported side by side)
- **Key Redaction** (proxy captures) — API keys never touch disk: masked (`abcd…wxyz`) at the single write chokepoint
- **Data Lake Upload** — Upload sessions to the data lake from the home list row or the session page header: secrets are scrubbed before archiving into a paradigm directory, with a baseline slot and task-outcome annotation; proxy captures offer "also upload the native session on this machine" — the native record of the same conversation is located automatically (already-imported row, or on-disk discovery per framework: Claude / opencode / DSH by session id, Codex by capture time window + first-prompt anchor), imported first if needed, and pushed alongside the capture as the same-sid dual record under `<sid>.native/` (a Codex native session has its own id and lands under it); the CLI flag is `--with-native`; git-lfs is set up automatically when missing — any lake action prewarms the bootstrap in the background (the download falls back to public mirrors when GitHub is slow, sha256-pinned; a same-version binary left in the pre-rename data directory is reused as-is), so LFS-mode upload and import require no manual installation

The homepage Sessions list supports keyword / session-ID search; the import dialog offers one-click default paths.

**Run Observation** — A top-level Runs domain (next to Sessions) for Opsbot graph runs: import a workflow-bundle directory (`workflow.json` + `sessions/`) via the web "导入 Bundle" entry (same dialog flow as Import Session: browse directories, bundle dirs containing `workflow.json`/`manifest.json` are highlighted and import on click) or `ctxi import-bundle <dir>`; the same dialog also imports straight from the data lake (source toggle: local directory / data lake, with the same two-phase flow as Import Session — pick a top-level lake directory first, then filter and check bundles inside it, importing them in batch with per-item progress); all member sessions are imported immediately through the standard pipeline — **run-imported sessions live only inside the run detail view, never in the Sessions list** (deleting a run also deletes the sessions it imported; sessions that existed before the import are untouched). The run page renders the multi-generation DAG (rollback generation bands, retry history, carried / not-yet-run placeholders, generator subgraphs) as pure SVG in a workbench matching the site theme — orthogonal circuit-style edge routing (edges always flow rightward/downward, never leftward) with PCB hop bridges at crossings (crossing ≠ connection), click-to-light edge marquee (select a node to highlight its connected edges with status-colored flowing lights while the rest dim to static; click empty canvas to turn them off), Ctrl/⌘+wheel cursor-anchored zoom, drag panning and fit-to-view — with per-node attempt history (verification verdicts, Bash output) and click-through to member session turns; session pages show a run badge linking back to the run. `ctxi runs` lists imported runs. After importing, each run can be uploaded to the data lake from the runs list row (or the run page header): fill in submitter/description and the whole package — manifest, report and member sessions — is assembled from insight and pushed to the `opsbot-bundle/` zone of the data lake (member sessions re-exported from the local database, compressed uniformly, secrets scrubbed across the board; re-uploading the same runId replaces it atomically); the opsbot-bundle section in the data lake viewer sidebar browses lake-hosted bundles and imports them locally in one click.

**Run Logging** — Server-side process logs (import pipeline, lake sync, API errors) are written to `~/.context-insight/logs/insight-<date>.log` (daily rolling) and optionally mirrored to the startup terminal. Level, file output and screen output switches are adjustable live in Settings → Run Logging (log location shown there; no restart); env vars (`CONTEXT_LOG` / `CONTEXT_LOG_LEVEL` / `CONTEXT_LOG_FILE` / `CONTEXT_LOG_STDOUT` / `CONTEXT_LOG_DIR`) take precedence over the settings page.

## Install & Usage

### Option 0: npm install (Recommended)

```bash
npm install -g context-insight
context-insight            # first run: auto-build + migrate (~30s-2min), then start + open browser
```

- Requires Node.js >= 22.12; mainland-China networks can add `--registry=https://registry.npmmirror.com`
- Offline fallback: `npm install -g ./context-insight-<version>.tgz`
- Writable state lives in `~/.context-insight/`; default port 21025 (auto-increments if occupied)
- CLI subcommands pass through: `context-insight upload --file … --list` / `sessions`; short alias `ctxi`
- Python 3 optional (starts the smart-agent analysis backend when present)
- Alternate brand: `npm install -g cannbot-insight` — the same tool published under the CANNBot-Insight name (commands `cannbot-insight` / `cbi`, data dir `~/.cannbot-insight/`); session data is fully interchangeable with context-insight (shared format identity)

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
| `--with-native` | Also upload the native session found on this machine alongside the capture (`<sid>.native/` dual record) |
| `--yes` / `--json` | Skip confirmation / JSON output (script-friendly) |
| `--list` | List available sessions only |
