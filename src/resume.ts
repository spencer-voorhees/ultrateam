import type { Entry, ResumeState } from './schema.js';
import { captureGitState } from './git.js';

export interface ResumeInput {
  title: string;
  summary: string;
  open_threads?: string[];
  objective?: string;
  completed?: string[];
  next_steps?: string[];
  blockers?: string[];
  verification?: string[];
  commands?: string[];
}

/** Build a complete capsule even when an older caller only supplies handoff fields. */
export function createResumeState(root: string, input: ResumeInput): ResumeState {
  return {
    version: 1,
    objective: input.objective?.trim() || input.title,
    completed: input.completed?.length ? input.completed : [input.summary],
    next_steps: input.next_steps?.length ? input.next_steps : (input.open_threads ?? []),
    blockers: input.blockers ?? [],
    verification: input.verification ?? [],
    commands: input.commands ?? [],
    git: captureGitState(root),
  };
}

/** Convert pre-capsule handoffs into the same contract returned for new entries. */
export function resumableState(entry: Entry): ResumeState {
  return entry.resume ?? {
    version: 1,
    objective: entry.title,
    completed: [entry.summary],
    next_steps: entry.open_threads,
    blockers: [],
    verification: [],
    commands: [],
  };
}
