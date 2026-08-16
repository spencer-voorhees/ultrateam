# ultrateam

**Shared memory and session handoff for the team of coding agents on your machine.**

You start a task in Cursor. You pick it up later in Claude Code. Tomorrow, Copilot finishes it. Today, each of those agents keeps its history in its own silo — so every switch means re-explaining everything.

ultrateam treats the agents on your machine as what they actually are: **a team**. It gives them one shared session diary per project that every agent reads and writes through a single MCP server, so any agent can pick up exactly where any other left off — and you can see which agent, on which model, did what.

## How it works

```
┌─────────────┐  ┌────────┐  ┌─────────┐  ┌───────┐
│ Claude Code │  │ Cursor │  │ Copilot │  │ Codex │   ← the team
└──────┬──────┘  └───┬────┘  └────┬────┘  └───┬───┘
       └─────────────┴─────┬──────┴───────────┘
                           │  identical MCP tools:
                           │  recall · checkpoint · handoff
                   ┌───────▼────────┐
                   │ ultrateam serve │
                   └───────┬────────┘
              ┌────────────┴─────────────┐
   <project>/.ultrateam/         ~/.ultrateam/index.db
      entries.jsonl                SQLite + FTS5 index
      (source of truth)            (derived, disposable)
```

Every agent follows the same three-step protocol, installed once into `AGENTS.md` — the cross-agent instruction file they all read:

1. **`recall`** at session start — "what has the team done on this?" Returns ranked relevant entries from *any* agent's past sessions.
2. **`checkpoint`** after each meaningful unit of work — title, summary, files touched, decisions made.
3. **`handoff`** before the session ends — with `open_threads`: the briefing the next agent reads first.

There is no per-agent behavior. An agent is "on the team" the moment it's connected to the server and reading the contract.

## Quickstart

```bash
npm install -g ultrateam     # (or: npm link, from a source checkout)
cd your-project
ultrateam init               # store + AGENTS.md contract + MCP registration
ultrateam doctor             # verify every detected agent is wired
```

`init` detects which agents are installed and registers the server in each one's project config (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor, `.vscode/mcp.json` for VS Code/Copilot). That registration is the only per-agent plumbing; everything else is identical everywhere.

Then just work. Agents checkpoint as they go. When you switch tools:

> "I was working on the auth refactor"

…and the new agent's `recall` pulls the trail — including the last handoff's open threads — no matter which agent wrote it.

## The diary from the human side

```bash
ultrateam list                     # recent entries: who did what, when
ultrateam recall auth middleware   # search the diary
ultrateam show <id>                # one entry in full
ultrateam log -t "..." -m "..."    # write an entry yourself
```

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
  "tags": ["auth"]
}
```

`open_threads` is what makes handoff work: it's the first thing the next agent sees.

## Storage design: files are truth, SQLite is cache

Entries live in **append-only JSONL** at `<project>/.ultrateam/entries.jsonl` — human-readable, greppable, diffable, and committable (`init` gitignores it by default; delete the ignore line to share the team diary through the repo). A **derived SQLite index** at `~/.ultrateam/index.db` powers cross-project queries and FTS5 ranked search; it can be deleted at any time and rebuilt with `ultrateam reindex`. Ranking blends full-text relevance, recency (one-week half-life), overlap with the files you're touching now, and same-branch affinity.

Why not SQLite alone? Because the lowest common denominator wins on agent-agnosticism: any agent, script, or human can read a text file with zero dependencies — and no agent's memory should be locked in an opaque store. That's the whole point.

## CLI reference

| Command | What it does |
| --- | --- |
| `ultrateam init [--all]` | Set up store, contract, and agent registrations |
| `ultrateam doctor` | Health check: index, contract, per-agent wiring |
| `ultrateam serve` | Run the MCP server (agents launch this; stdio) |
| `ultrateam recall <query> [-f files] [-a]` | Ranked search of the diary |
| `ultrateam list [-n] [-a]` | Recent entries with attribution |
| `ultrateam show <id>` | One entry in full |
| `ultrateam log -t <title> -m <summary> [...]` | Manual entry |
| `ultrateam reindex [--all]` | Rebuild the SQLite index from JSONL |

## Status & roadmap

Early. Working today: the store, the index, the MCP server, init/doctor, the CLI. Requires Node ≥ 22.5 (uses the built-in `node:sqlite`; no native dependencies).

- [ ] **Web viewer** (`ultrateam view`) — session timeline and team roster with provider icons
- [ ] **Import** — backfill the diary from agents' native histories (Claude Code JSONL, Cursor's DB)
- [ ] Optional semantic search behind a flag
- [ ] Team sync — share the diary beyond one machine
