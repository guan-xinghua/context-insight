# CANNBot-Insight

Session-level observability for LLM coding agents: import agent session logs and analyze tokens, context, subagents, and skill usage turn by turn.

**[中文文档](README-zh.md)**

## Features

Import SQLite (opencode.db) or JSONL (native Claude Code / cpx proxy captures; plaintext and `.jsonl.gz`, `cpx-` prefix handled) and explore the session detail tabs:

- **Tokens & Cost** — 5-item per-turn token breakdown vs the model's context window, plus cost estimation
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

## Install & Usage

### Option 0: npm install (Recommended)

```bash
npm install -g cannbot-insight
cannbot-insight            # first run: auto-build + migrate (~30s-2min), then start + open browser
```

- Requires Node.js >= 20; mainland-China networks can add `--registry=https://registry.npmmirror.com`
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

- Requires Node.js >= 20; `./start.sh` also installs the `cpx` capture command (see `../cpx/README.md`)
- Open `http://localhost:21025`

Log file locations:
- opencode: `~/.local/share/opencode/opencode.db`
- Claude Code: `~/.claude/projects/` (directory auto-scan)

The Web UI also supports: exporting sessions to standalone SQLite or Markdown; uploading to the CANNBay dataset repo (paradigm directory + operator-generation outcome annotation + optional baseline, with mandatory secret governance before push); on-demand import from the CANNBay list. The data-lake remote, auth, and branch are configurable in Settings (credentials stay in browser localStorage). The LLM provider panel embeds a known-provider Base URL quick reference. When the data repo has LFS enabled on the platform, set env `CANNBAY2_LFS=1` (or request config `lfs`) to store `.jsonl.gz` sessions as LFS pointers — capacity escapes the git repo quota, and the import path handles it transparently (meta stays a plain blob; session payloads are fetched from LFS storage on demand).

### Option 2: CLI Upload + Web Analysis

For SSH remotes and other browser-less environments (one-time `npm install` + `npx prisma migrate deploy`; the upload command auto-starts the backend afterwards):

```bash
# opencode: list / upload specific / interactive
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --list
npx tsx src/cli/index.ts upload --file ~/.local/share/opencode/opencode.db --session-id <id> --description "desc" --yes --json

# Claude Code: directory scan / single file
npx tsx src/cli/index.ts upload --file ~/.claude/projects/ --list
npx tsx src/cli/index.ts upload --file ~/.claude/projects/<hash>/<uuid>.jsonl --session-id <uuid> --yes --json
```

| Option | Description |
|--------|-------------|
| `--file <path>` | Source path (.db / .jsonl / directory; type auto-detected) |
| `--session-id <id>` | Pick a specific session (skip the interactive picker) |
| `--description <text>` | Upload description |
| `--yes` / `--json` | Skip confirmation / JSON output (script-friendly) |
| `--list` | List available sessions only |

After upload, click the **CANNBay** button in the Web UI to pick a paradigm directory and import — no manual clone needed.
