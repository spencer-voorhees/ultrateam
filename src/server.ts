// The MCP server is the single integration surface: every agent connects to it
// the same way and gets the same three tools. Attribution comes from the MCP
// initialize handshake (client name), overridable per call.
//
// NOTE: this runs over stdio — stdout belongs to the protocol. Log to stderr only.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { createEntry, type AgentInfo } from './schema.js';
import { findProjectRoot, appendEntry } from './store/jsonl.js';
import { Index } from './store/db.js';
import { currentBranch } from './git.js';
import { normalizeAgentName } from './agents/registry.js';
import { formatEntry } from './format.js';
import { VERSION } from './version.js';

const NUDGE =
  '\n\n---\nultrateam protocol: checkpoint after each meaningful unit of work; call handoff with open_threads before the session ends.';

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
  model: z.string().optional().describe('Model id doing the work, e.g. "claude-fable-5"'),
};

export async function startServer(cwd: string = process.cwd()): Promise<void> {
  const root = findProjectRoot(cwd) ?? cwd;
  const project = path.basename(root);
  const index = new Index();
  try {
    index.indexProject(root);
  } catch (err) {
    console.error(`[ultrateam] initial index failed: ${String(err)}`);
  }

  const server = new McpServer({ name: 'ultrateam', version: VERSION });

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
    });
    appendEntry(root, entry);
    index.upsert(entry, root);
    return entry.id;
  }

  server.registerTool(
    'recall',
    {
      title: 'Recall shared session history',
      description:
        'Search the shared cross-agent session diary for this project. Call this at session start or when resuming a task, with a short query describing the work (and the files involved, if known). Returns the most relevant past entries from any agent.',
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
      try {
        index.indexProject(root); // pick up entries written by other agents since startup
      } catch (err) {
        console.error(`[ultrateam] reindex failed: ${String(err)}`);
      }
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
              text: `No matching entries in the shared diary for ${project}.${query ? ' Try a broader query or all_projects: true.' : ''} This may be a fresh project — proceed, and checkpoint as you work.${NUDGE}`,
            },
          ],
        };
      }
      const body = results.map((r) => formatEntry(r.entry, { withId: true })).join('\n\n');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Shared diary — ${results.length} most relevant entr${results.length === 1 ? 'y' : 'ies'} for ${project}:\n\n${body}${NUDGE}`,
          },
        ],
      };
    },
  );

  server.registerTool(
    'checkpoint',
    {
      title: 'Checkpoint progress to the shared diary',
      description:
        'Record a completed unit of work in the shared cross-agent session diary. Call this after each meaningful step so other agents (and future sessions) can pick up the trail.',
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
            text: `Checkpointed "${args.title}" (${id}) to the shared diary for ${project}.`,
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
        'Write the wrap-up entry before the session ends. open_threads is the briefing the next agent reads first: list every unfinished item, untested change, and known issue.',
      inputSchema: {
        ...entryFields,
        open_threads: z
          .array(z.string())
          .min(1)
          .describe('Unfinished items the next agent must know — at least one'),
      },
    },
    async (args) => {
      const id = writeEntry('handoff', args);
      return {
        content: [
          {
            type: 'text' as const,
            text: `Handoff "${args.title}" (${id}) recorded. The next agent's recall will surface its open threads.`,
          },
        ],
      };
    },
  );

  await server.connect(new StdioServerTransport());
  console.error(`[ultrateam] v${VERSION} serving ${project} (${root})`);
}
