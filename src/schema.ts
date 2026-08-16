import { z } from 'zod';
import { monotonicFactory } from 'ulid';
import { canonicalAgentName, inferProvider } from './agents/registry.js';

const ulid = monotonicFactory();

export const AgentInfoSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
});

export const EntryKindSchema = z.enum(['session', 'handoff', 'note']);

export const GitStateSchema = z.object({
  branch: z.string().nullable().default(null),
  head: z.string().nullable().default(null),
  dirty: z.boolean().default(false),
  changed_files: z.array(z.string()).default([]),
});

/** Portable execution state another agent can use without understanding the authoring agent. */
export const ResumeStateSchema = z.object({
  version: z.literal(1).default(1),
  objective: z.string().min(1),
  completed: z.array(z.string()).default([]),
  next_steps: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  commands: z.array(z.string()).default([]),
  git: GitStateSchema.optional(),
});

export const EntrySchema = z.object({
  id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'must be a ULID'),
  ts: z.string().datetime(),
  project: z.string().min(1),
  branch: z.string().nullable().default(null),
  agent: AgentInfoSchema,
  kind: EntryKindSchema.default('session'),
  title: z.string().min(1).max(200),
  summary: z.string().min(1),
  files: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  open_threads: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  resume: ResumeStateSchema.nullable().default(null),
});

export type Entry = z.infer<typeof EntrySchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type EntryKind = z.infer<typeof EntryKindSchema>;
export type GitState = z.infer<typeof GitStateSchema>;
export type ResumeState = z.infer<typeof ResumeStateSchema>;

export type NewEntryInput = Omit<z.input<typeof EntrySchema>, 'id' | 'ts'>;

/** Build a complete, validated entry from caller-supplied fields, stamping id/ts/provider. */
export function createEntry(input: NewEntryInput): Entry {
  const agent = { ...input.agent, name: canonicalAgentName(input.agent.name) };
  if (!agent.provider) {
    agent.provider = inferProvider(agent.name, agent.model);
  }
  return EntrySchema.parse({
    ...input,
    agent,
    id: ulid(),
    ts: new Date().toISOString(),
  });
}

/** Parse one JSONL line into an Entry, or null if the line is corrupt/invalid. */
export function parseEntryLine(line: string): Entry | null {
  try {
    return EntrySchema.parse(JSON.parse(line));
  } catch {
    return null;
  }
}
