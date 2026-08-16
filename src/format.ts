import { type Entry } from './schema.js';
import { agentMeta } from './agents/registry.js';
import { resumableState } from './resume.js';

export function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms) || ms < 0) return iso;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

export function agentLabel(entry: Entry): string {
  const meta = agentMeta(entry.agent.name);
  const model = entry.agent.model ? ` (${entry.agent.model})` : '';
  return `${meta.icon} ${meta.display}${model}`;
}

/** Render one entry as compact markdown for tool responses and CLI output. */
export function formatEntry(entry: Entry, opts: { withId?: boolean } = {}): string {
  const lines: string[] = [];
  lines.push(`### ${entry.title}`);
  const facts = [agentLabel(entry), timeAgo(entry.ts), entry.kind];
  if (entry.branch) facts.push(`branch: ${entry.branch}`);
  lines.push(facts.join(' · '));
  lines.push('');
  lines.push(entry.summary.trim());
  if (entry.files.length > 0) lines.push(`\nFiles: ${entry.files.join(', ')}`);
  if (entry.decisions.length > 0) {
    lines.push(`\nDecisions:`);
    for (const d of entry.decisions) lines.push(`- ${d}`);
  }
  if (entry.open_threads.length > 0) {
    lines.push(`\nOpen threads:`);
    for (const t of entry.open_threads) lines.push(`- ${t}`);
  }
  if (entry.tags.length > 0) lines.push(`\nTags: ${entry.tags.join(', ')}`);
  if (opts.withId) lines.push(`\n(id: ${entry.id})`);
  return lines.join('\n');
}

/** Render a deterministic provider-neutral briefing suitable for direct session restoration. */
export function formatResume(entry: Entry): string {
  const resume = resumableState(entry);
  const lines = [
    `# Resume: ${entry.title}`,
    `${agentLabel(entry)} · ${timeAgo(entry.ts)}${entry.branch ? ` · branch: ${entry.branch}` : ''}`,
    '',
    `Objective: ${resume.objective}`,
  ];
  const section = (title: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push('', `${title}:`);
    for (const item of items) lines.push(`- ${item}`);
  };
  section('Completed', resume.completed);
  section('Next steps', resume.next_steps);
  section('Blockers', resume.blockers);
  section('Decisions', entry.decisions);
  section('Files in play', entry.files);
  section('Verification', resume.verification);
  section('Useful commands', resume.commands);
  if (resume.git) {
    lines.push('', 'Git state:');
    lines.push(`- Branch: ${resume.git.branch ?? 'detached/unknown'}`);
    lines.push(`- HEAD: ${resume.git.head ?? 'unknown'}`);
    lines.push(`- Working tree: ${resume.git.dirty ? 'dirty' : 'clean'}`);
    section('Changed files', resume.git.changed_files);
  }
  lines.push('', `Handoff id: ${entry.id}`);
  return lines.join('\n');
}
