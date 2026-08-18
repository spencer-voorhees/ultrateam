// The MCP server is the single integration surface: every agent connects to it
// the same way and gets the same three tools. Attribution comes from the MCP
// initialize handshake (client name), overridable per call.
//
// NOTE: this runs over stdio — stdout belongs to the protocol. Log to stderr only.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createEntry, type AgentInfo } from './schema.js';
import { findProjectRoot, appendEntry } from './store/jsonl.js';
import { Index } from './store/db.js';
import { currentBranch } from './git.js';
import { normalizeAgentName } from './agents/registry.js';
import { formatEntry, formatResume } from './format.js';
import { VERSION } from './version.js';
import { knownRoots } from './store/roots.js';
import { rootsInWorkspace } from './workspace.js';
import { createResumeState, resumableState } from './resume.js';

const NUDGE =
  '\n\n---\nultrateam protocol: use resume to restore execution state; checkpoint meaningful progress; hand off structured next steps before the session ends.';

// Delivered to every client in the initialize handshake. This is the one
// channel that reaches agents whose global instruction files we cannot write
// (Cursor has no file-based User Rules), so it carries the full usage nudge.
const SERVER_INSTRUCTIONS =
  'ultrateam is shared cross-agent memory for this project. At the start of a task, call recall ' +
  '(or resume) to load prior context from any agent. Call checkpoint after each meaningful step and ' +
  'handoff before the session ends so other agents can continue. When calling checkpoint or handoff, ' +
  'always pass the model argument with the exact model id you are running as (e.g. "claude-sonnet-4-6", ' +
  '"gpt-5.6") so entries are attributed to the right model.';

const entryFields = {
  title: z.string().min(1).max(200).describe('Short, specific title for this entry'),
  summary: z
    .string()
    .min(1)
    .describe('What happened and why — a briefing for the next agent, not a transcript'),
  files: z.array(z.string()).default([]).describe('Repo-relative paths touched'),
  decisions: z
    .array(z.string())
    .default([])
    .describe('Decisions made, with reasons ("chose X over Y because ...")'),
  tags: z.array(z.string()).default([]).describe('Freeform topic tags, e.g. ["auth"]'),
  agent_name: z
    .string()
    .optional()
    .describe('Override the auto-detected agent name (e.g. "claude-code", "cursor")'),
  model: z.string().optional().describe('Always set this to the model id you are running as, e.g. "claude-sonnet-4-6" or "gpt-5.6", so entries are attributed to the right model'),
  objective: z.string().optional().describe('The active user goal, stated independently of any agent'),
  completed: z.array(z.string()).default([]).describe('Concrete work completed so far'),
  next_steps: z.array(z.string()).default([]).describe('Ordered actions the next agent should take'),
  blockers: z.array(z.string()).default([]).describe('Anything preventing progress and what would unblock it'),
  verification: z.array(z.string()).default([]).describe('Tests or checks run, including their outcomes'),
  commands: z.array(z.string()).default([]).describe('Useful safe commands for continuing the work'),
};

export async function startServer(cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd) ?? cwd;
  const project = path.basename(root);
  const index = new Index();

  function indexCurrentWorkspace(): void {
    for (const workspaceRoot of rootsInWorkspace(root, knownRoots())) {
      if (!fs.existsSync(workspaceRoot)) continue;
      try {
        index.indexProject(workspaceRoot);
      } catch (err) {
        console.error(`[ultrateam] index failed for ${workspaceRoot}: ${String(err)}`);
      }
    }
  }
  indexCurrentWorkspace();

  const server = new McpServer(
    { name: 'ultrateam', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // Agents routinely skip optional params; a reminder in the tool result is the
  // one feedback channel every agent reads, so unattributed entries self-correct.
  function modelReminder(model?: string): string {
    return model ? '' : ' Entry has no model attribution — pass model: "<your model id>" next time.';
  }

  function callerAgent(explicitName?: string, model?: string): AgentInfo {
    const clientName = server.server.getClientVersion()?.name;
    const name = explicitName ?? normalizeAgentName(clientName) ?? clientName ?? 'unknown';
    return { name, model };
  }

  function writeEntry(
    kind: 'session' | 'handoff' | 'note',
    args: {
      title: string;
      summary: string;
      files: string[];
      decisions: string[];
      tags: string[];
      open_threads: string[];
      agent_name?: string;
      model?: string;
      objective?: string;
      completed: string[];
      next_steps: string[];
      blockers: string[];
      verification: string[];
      commands: string[];
    },
  ): string {
    const entry = createEntry({
      project,
      branch: currentBranch(root),
      agent: callerAgent(args.agent_name, args.model),
      kind,
      title: args.title,
      summary: args.summary,
      files: args.files,
      decisions: args.decisions,
      open_threads: args.open_threads,
      tags: args.tags,
      resume: kind === 'note' ? null : createResumeState(root, args),
    });
    appendEntry(root, entry);
    try {
      index.upsert(entry, root);
    } catch (err) {
      // JSONL is the source of truth and the append succeeded — never fail
      // the tool call (and provoke a duplicate retry) over the derived index.
      console.error(`[ultrateam] index update failed for ${entry.id} (entry is safe in JSONL): ${String(err)}`);
    }
    return entry.id;
  }

  server.registerTool(
    'recall',
    {
      title: 'Recall shared session history',
      description:
        'Search shared cross-agent memory for this project. Call this at session start or when resuming a task, with a short query describing the work (and the files involved, if known). Returns the most relevant past entries from any agent.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('Free-text description of the task, e.g. "auth refactor middleware"'),
        files: z
          .array(z.string())
          .default([])
          .describe('Files currently in play, used to boost entries that touched them'),
        limit: z.number().int().min(1).max(50).default(8),
        all_projects: z
          .boolean()
          .default(false)
          .describe('Search every project on this machine, not just the current one'),
      },
    },
    async ({ query, files, limit, all_projects }) => {
      indexCurrentWorkspace(); // pick up entries written in any checkout since startup
      const results = index.recall({
        query,
        files,
        limit,
        branch: currentBranch(root) ?? undefined,
        projectPath: all_projects ? undefined : root,
      });
      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No matching entries in shared memory for ${project}.${query ? ' Try a broader query or all_projects: true.' : ''} This may be a fresh project — proceed, and checkpoint as you work.${NUDGE}`,
            },
          ],
        };
      }
      const body = results.map((r) => formatEntry(r.entry, { withId: true })).join('\n\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Shared memory — ${results.length} most relevant entr${results.length === 1 ? 'y' : 'ies'} for ${project}:\n\n${body}${NUDGE}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'resume',
    {
      title: 'Resume the latest shared session',
      description:
        'Restore portable execution state from the latest checkpoint or handoff in this workspace. Returns the objective, completed work, next steps, blockers, decisions, verification, useful commands, files, and captured Git state regardless of which agent wrote it.',
      inputSchema: {
        handoff_id: z.string().optional().describe('Exact checkpoint or handoff ULID to restore'),
        query: z.string().optional().describe('Optional topic to find the most relevant resumable entry'),
        all_projects: z.boolean().default(false).describe('Search every workspace on this machine'),
      },
    },
    async ({ handoff_id, query, all_projects }) => {
      indexCurrentWorkspace();
      const current = currentBranch(root) ?? undefined;
      const result = handoff_id
        ? index.resumeById(handoff_id, { projectPath: all_projects ? undefined : root })
        : query
        ? index.recall({
            query,
            limit: 50,
            branch: current,
            projectPath: all_projects ? undefined : root,
          }).find((candidate) => candidate.entry.resume || candidate.entry.kind === 'handoff') ?? null
        : index.latestResume({ projectPath: all_projects ? undefined : root, branch: current });
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: `No resumable checkpoint or handoff found for ${project}.` }],
        };
      }
      const resume = resumableState(result.entry);
      return {
        content: [{ type: 'text' as const, text: formatResume(result.entry) + NUDGE }],
        structuredContent: {
          entry: result.entry,
          resume,
          project_path: result.projectPath,
        },
      };
    },
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'Checkpoint progress to shared memory',
      description:
        'Record a completed unit of work in shared cross-agent memory. Call this after each meaningful step so other agents (and future sessions) can pick up the trail.',
      inputSchema: {
        ...entryFields,
        open_threads: z
          .array(z.string())
          .default([])
          .describe('Known unfinished items, if any'),
      },
    },
    async (args) => {
      const id = writeEntry('session', args);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Checkpointed "${args.title}" (${id}) to shared memory for ${project}.${modelReminder(args.model)}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'handoff',
    {
      title: 'Write a session handoff',
      description:
        'Write the structured wrap-up before the session ends so any agent can continue. Include next_steps, blockers, verification, and useful commands; open_threads remains as a backward-compatible shorthand for next_steps.',
      inputSchema: {
        ...entryFields,
        open_threads: z
          .array(z.string())
          .default([])
          .describe('Backward-compatible shorthand for next_steps'),
      },
    },
    async (args) => {
      const id = writeEntry('handoff', args);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Handoff "${args.title}" (${id}) recorded. The next agent's recall will surface its open threads.${modelReminder(args.model)}`,
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`[ultrateam] v${VERSION} serving ${project} (${root})`);
}
