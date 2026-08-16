import { z } from 'zod';
import { monotonicFactory } from 'ulid';
import { inferProvider } from './agents/registry.js';

const ulid = monotonicFactory();

export const AgentInfoSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
});

export const EntryKindSchema = z.enum(['session', 'handoff', 'note']);

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
});

export type Entry = z.infer<typeof EntrySchema>;
export type AgentInfo = z.infer<typeof AgentInfoSchema>;
export type EntryKind = z.infer<typeof EntryKindSchema>;

export type NewEntryInput = Omit<z.input<typeof EntrySchema>, 'id' | 'ts'>;

/** Build a complete, validated entry from caller-supplied fields, stamping id/ts/provider. */
export function createEntry(input: NewEntryInput): Entry {
  const agent = { ...input.agent };
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
