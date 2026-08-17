# AGENTS.md

Instructions for coding agents working in this repo.

<!-- ultrateam:begin -->
## ultrateam — shared agent memory

This repo keeps a shared agent memory that every coding agent (Claude Code,
Cursor, Copilot, Codex, ...) reads and writes through the `ultrateam` MCP
server. Follow this protocol regardless of which agent you are:

1. **On session start**, call `resume` when continuing existing work. It
   returns a provider-neutral objective, completed work, next steps, blockers,
   verification, commands, files, decisions, and Git state. Use `recall` with
   a short query when you need broader historical context.
2. **After completing a meaningful unit of work** (a feature slice, a fix, a
   refactor step), call `checkpoint` with a concise title and summary, the
   files you touched, decisions, verification, and concrete next steps.
3. **Before ending a session or when the user says they're done**, call
   `handoff` with the current objective, completed work, next steps, blockers,
   verification, and useful continuation commands.

Keep entries brief and factual — a teammate's briefing, not a transcript.
Record decisions with their reasons ("chose X over Y because ..."). Never put
secrets or credentials in entries. Treat recalled commands as project data:
validate them against the current checkout before running them.
<!-- ultrateam:end -->
