# ultrateam

**Shared memory and session handoff for the team of coding agents on your machine.**

You start a task in Cursor. You pick it up later in Claude Code. Tomorrow, Copilot finishes it. Today, each of those agents keeps its history in its own silo — so every switch means re-explaining everything.

ultrateam treats the agents on your machine as what they actually are: **a team**. It gives them one shared memory per project that every agent reads and writes through a single MCP server, so any agent can pick up exactly where any other left off — and you can see which agent, on which model, did what.

## How it works

```
        Claude Code · Cursor · Copilot · Gemini · Codex
                            ▼
                  ┌───────────────────┐
                  │  ultrateam serve  │   one MCP server, four identical tools:
                  └─────────┬─────────┘   resume · recall · checkpoint · handoff
                            │
                            ├──►  <project>/.ultrateam/entries.jsonl   source of truth
                            └──►  ~/.ultrateam/index.db                SQLite + FTS5, derived
```

Every agent follows the same protocol, installed once into `AGENTS.md` — the cross-agent instruction file they all read:

1. **`resume`** when continuing work — restores a provider-neutral execution capsule: objective, progress, next steps, blockers, verification, commands, files, decisions, and Git state.
2. **`recall`** when historical context is needed — returns ranked relevant entries from *any* agent's past sessions.
3. **`checkpoint`** after each meaningful unit of work — updates the portable execution state.
4. **`handoff`** before the session ends — records the final structured briefing for the next agent.

There is no per-agent behavior. An agent is "on the team" the moment it's connected to the server and reading the contract.

## Quickstart

Install with one line — it fetches, builds, and puts `ultrateam` on your PATH.

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/spencer-voorhees/ultrateam/main/install.sh | bash
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/spencer-voorhees/ultrateam/main/install.ps1 | iex
```

Then, in any project:
```bash
cd your-project
ultrateam init               # store + AGENTS.md contract + MCP registration
ultrateam doctor             # verify every detected agent is wired
```

Prefer a manual setup? Clone the repo, then `npm install && npm run build && npm link`.

`init` detects which agents are installed and registers the server in each one's project config (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code/Copilot, `.agents/mcp_config.json` for Gemini/Antigravity, `.codex/mcp.json` for Codex). That registration is the only per-agent plumbing; everything else is identical everywhere.

Then just work. Agents checkpoint as they go. When you switch tools:

> "I was working on the auth refactor"

…and the new agent's `resume` restores the latest execution state no matter which agent wrote it. `recall` remains available for searching the longer trail.

## From the human side

```bash
ultrateam view                     # start/reuse the background viewer and open it
ultrateam view --foreground        # keep the viewer attached to this terminal
ultrateam view --status            # show its URL, PID, mode, and start time
ultrateam view --stop              # stop the viewer
ultrateam list                     # recent entries: who did what, when
ultrateam recall auth middleware   # search the shared history
ultrateam resume                   # restore the latest session state
ultrateam resume --id <id> --json # exact, machine-readable resume capsule
ultrateam show <id>                # one entry in full
ultrateam log -t "..." -m "..."    # write an entry yourself
ultrateam uninstall                # remove the app and global state (with confirmation)
```

`ultrateam view` starts a reusable background web viewer, opens it, and returns
control to the terminal. Re-running the command reuses the existing process.
Use `--foreground` for the previous terminal-attached behavior, and `--status`
or `--stop` to manage the process. The viewer remains loopback-only and zero-dependency: the
session timeline as a **watch line** colored by the agent on duty, handoff markers,
a team roster with per-agent counts and models, ranked search, and a 14-day
activity strip. Dark and light themes, keyboard accessible.

Every entry is attributed: agent, model, and provider (inferred from the model id — an entry by Copilot running a Claude model is credited to both correctly).

## The entry schema

```jsonc
{
  "id": "01J8ME9XKQ3W3X4Y5Z6A7B8C9D",        // ULID — sortable by time
  "ts": "2026-08-15T14:22:00Z",
  "project": "dotcom",
  "branch": "feat/auth-refactor",
  "agent": { "name": "claude-code", "model": "claude-fable-5", "provider": "anthropic" },
  "kind": "handoff",                          // session | handoff | note
  "title": "Moved session auth to middleware",
  "summary": "What happened and why — a briefing, not a transcript.",
  "files": ["src/auth/middleware.ts"],
  "decisions": ["JWT stays in httpOnly cookie; rejected localStorage (XSS)"],
  "open_threads": ["refresh-token rotation untested"],
  "tags": ["auth"],
  "resume": {
    "version": 1,
    "objective": "Finish the authentication refactor",
    "completed": ["Moved JWT validation into middleware"],
    "next_steps": ["Add refresh-token rotation tests"],
    "blockers": [],
    "verification": ["npm test — 42 passing"],
    "commands": ["npm test"],
    "git": {
      "branch": "feat/auth-refactor",
      "head": "7d93b2...",
      "dirty": true,
      "changed_files": ["src/auth/middleware.ts"]
    }
  }
}
```

New checkpoints and handoffs always carry a `resume` capsule. Older handoffs remain resumable: ultrateam maps their title, summary, and `open_threads` into the same contract on read.

## Storage design: files are truth, SQLite is cache

Entries live in **append-only JSONL** at `<project>/.ultrateam/entries.jsonl` — human-readable, greppable, diffable, and committable (`init` gitignores it by default; delete the ignore line to share the team's history through the repo). A **derived SQLite index** at `~/.ultrateam/index.db` powers cross-project queries and FTS5 ranked search; it can be deleted at any time and rebuilt with `ultrateam reindex`. Ranking blends full-text relevance, recency (one-week half-life), overlap with the files you're touching now, and same-branch affinity.

Multiple checkouts of the same work are grouped into one logical workspace. ultrateam prefers an explicit `git config ultrateam.workspaceId <id>`, otherwise it derives a stable identity from the normalized Git remote; Git worktrees fall back to their shared Git directory, and unrelated local-only repositories remain separate by absolute path. This deliberately avoids merging projects merely because their folder or entry names happen to match.

Why not SQLite alone? Because the lowest common denominator wins on agent-agnosticism: any agent, script, or human can read a text file with zero dependencies — and no agent's memory should be locked in an opaque store. That's the whole point.

## CLI reference

| Command | What it does |
| --- | --- |
| `ultrateam init [--all]` | Set up store, contract, and agent registrations |
| `ultrateam doctor` | Health check: index, contract, per-agent wiring |
| `ultrateam view [-p port] [--foreground\|--status\|--stop]` | Start, inspect, or stop the local web viewer |
| `ultrateam serve` | Run the MCP server (agents launch this; stdio) |
| `ultrateam resume [query] [--id <id>] [--json]` | Restore portable execution state |
| `ultrateam recall <query> [-f files] [-a]` | Ranked search of the shared history |
| `ultrateam list [-n] [-a]` | Recent entries with attribution |
| `ultrateam show <id>` | One entry in full |
| `ultrateam log -t <title> -m <summary> [...]` | Manual entry |
| `ultrateam reindex [--all]` | Rebuild the SQLite index from JSONL |
| `ultrateam update` | Update to the latest (git pull + rebuild the install) |
| `ultrateam uninstall [--yes]` | Stop the viewer and remove the app, global command, index, state, and logs |

`uninstall` preserves project-local `.ultrateam` histories and project MCP
configuration. It asks for confirmation unless `--yes` is supplied.

## Status & roadmap

Early. Working today: the store, the index, the MCP server, init/doctor, the CLI, and the web viewer. Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native dependencies).

- [x] **Web viewer** (`ultrateam view`) — session timeline and team roster with per-agent colors
- [x] **Agent-agnostic resume** — structured checkpoints, exact restore, automatic Git snapshot
- [ ] **Import** — backfill the shared history from agents' native histories (Claude Code JSONL, Cursor's DB)
- [ ] Optional semantic search behind a flag
- [ ] Team sync — share history beyond one machine
