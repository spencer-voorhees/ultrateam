# AGENTS.md

Instructions for coding agents working in this repo.

<!-- ultrateam:begin -->
## ultrateam — shared agent memory

This repo keeps a shared session diary that every coding agent (Claude Code,
Cursor, Copilot, Codex, ...) reads and writes through the `ultrateam` MCP
server. Follow this protocol regardless of which agent you are:

1. **On session start or when resuming work**, call the `recall` tool with a
   short query describing the task (and the files involved, if known). Read the
   returned entries — especially `open_threads` from recent handoffs — before
   making changes.
2. **After completing a meaningful unit of work** (a feature slice, a fix, a
   refactor step), call `checkpoint` with a concise title and summary, the
   files you touched, and any decisions made.
3. **Before ending a session or when the user says they're done**, call
   `handoff` with `open_threads`: the specific unfinished items the next
   agent (or you, tomorrow) needs to know.

Keep entries brief and factual — a teammate's briefing, not a transcript.
Record decisions with their reasons ("chose X over Y because ..."). Never put
secrets or credentials in entries.
<!-- ultrateam:end -->
