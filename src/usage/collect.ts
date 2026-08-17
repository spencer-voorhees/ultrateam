// On-demand usage collection. Reads what each tool already has locally — no
// daemon, no telemetry config, no credentials for the log-based providers.
// Claude Code and Codex write per-message token counts to local session logs;
// we parse those. Providers with no local log (Copilot, Cursor) are represented
// but marked unavailable until their API adapter is wired.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { estimateCost, type TokenBreakdown } from './pricing.js';

export interface ModelUsage {
  model: string;
  tokens: TokenBreakdown;
  cost: number | null;
  messages: number;
}
export interface DailyUsage { date: string; tokens: number; cost: number | null; }
export interface ProviderUsage {
  provider: string;
  label: string;
  available: boolean;
  note?: string;
  tokens: TokenBreakdown;
  cost: number | null;
  sessions: number;
  messages: number;
  models: ModelUsage[];
  daily: DailyUsage[];
  lastActivity: string | null;
}
export interface UsageReport {
  generatedAt: string;
  providers: ProviderUsage[];
}

const zeroTokens = (): TokenBreakdown => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
function addTokens(a: TokenBreakdown, b: TokenBreakdown): void {
  a.input += b.input; a.output += b.output; a.cacheWrite += b.cacheWrite; a.cacheRead += b.cacheRead;
}
const sumTokens = (t: TokenBreakdown): number => t.input + t.output + t.cacheWrite + t.cacheRead;

/** One parsed model call from any provider's local log. */
interface UsageRecord {
  model: string;
  tokens: TokenBreakdown;
  ts: string;        // ISO
  session: string;   // session id for unique-session counting
  dedupeKey: string; // stable per-call key so resumed-session duplicates aren't double-counted
}

function* walkJsonl(root: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) yield* walkJsonl(full);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield full;
  }
}

// Claude Code: ~/.claude/projects (recursive .jsonl); assistant lines carry message.usage.
function collectClaudeCode(home: string): UsageRecord[] {
  const root = path.join(home, '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  const records: UsageRecord[] = [];
  const seen = new Set<string>();
  for (const file of walkJsonl(root)) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"usage"') === -1) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const msg = row?.message;
      const usage = msg?.usage;
      if (row?.type !== 'assistant' || !usage) continue;
      // Claude Code injects <synthetic> assistant turns that carry no real spend.
      if (msg?.model === '<synthetic>' || !msg?.model) continue;
      const dedupeKey = `${msg?.id ?? ''}:${row?.requestId ?? row?.uuid ?? ''}`;
      if (dedupeKey !== ':' && seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      records.push({
        model: msg?.model ?? 'unknown',
        tokens: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
        },
        ts: row?.timestamp ?? '',
        session: row?.sessionId ?? file,
        dedupeKey,
      });
    }
  }
  return records;
}

// Codex writes session rollouts as JSONL. Two event types matter, in order:
//   turn_context  -> payload.model / payload.cwd (the model for the turns that follow)
//   event_msg/token_count -> payload.info.last_token_usage (that turn's token delta)
// last_token_usage is a per-turn delta, so summing it across a session equals the
// session total without the double-counting that total_token_usage would cause.
function collectCodex(home: string): UsageRecord[] {
  const roots = [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')];
  const records: UsageRecord[] = [];
  const seenSessions = new Set<string>();
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const file of walkJsonl(root)) {
      // A rollout can appear in both sessions/ and archived_sessions/; count it once.
      const base = path.basename(file);
      if (seenSessions.has(base)) continue;
      seenSessions.add(base);
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      let model = 'unknown';
      for (const line of text.split('\n')) {
        if (!line) continue;
        let row: any;
        try { row = JSON.parse(line); } catch { continue; }
        const payload = row?.payload;
        if (!payload) continue;
        if (row.type === 'turn_context' && payload.model) {
          model = payload.model;
          continue;
        }
        if (payload.type !== 'token_count') continue;
        const u = payload.info?.last_token_usage;
        if (!u) continue;
        const cacheRead = u.cached_input_tokens ?? 0;
        const input = Math.max(0, (u.input_tokens ?? 0) - cacheRead); // input_tokens includes cached
        const output = (u.output_tokens ?? 0) + (u.reasoning_output_tokens ?? 0);
        if (!input && !output && !cacheRead) continue;
        records.push({
          model,
          tokens: { input, output, cacheWrite: 0, cacheRead },
          ts: row?.timestamp ?? '',
          session: base,
          dedupeKey: `${base}:${row?.timestamp ?? ''}`,
        });
      }
    }
  }
  return records;
}

// Gemini CLI: ~/.gemini/tmp/<project>/chats/session-*.jsonl. Model turns carry a
// tokens object {input, output, cached, thoughts, tool, total}; input includes the
// cached portion and thoughts are reasoning output.
function collectGemini(home: string): UsageRecord[] {
  const root = path.join(home, '.gemini', 'tmp');
  if (!fs.existsSync(root)) return [];
  const records: UsageRecord[] = [];
  for (const file of walkJsonl(root)) {
    if (path.basename(file).indexOf('session-') !== 0) continue;
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.indexOf('"tokens"') === -1) continue;
      let row: any;
      try { row = JSON.parse(line); } catch { continue; }
      const tk = row?.tokens;
      if (!tk || typeof tk !== 'object') continue;
      const cacheRead = tk.cached ?? 0;
      const input = Math.max(0, (tk.input ?? 0) - cacheRead);
      const output = (tk.output ?? 0) + (tk.thoughts ?? 0);
      if (!input && !output && !cacheRead) continue;
      records.push({
        model: row?.model ?? 'unknown',
        tokens: { input, output, cacheWrite: 0, cacheRead },
        ts: row?.timestamp ?? '',
        session: path.basename(file),
        dedupeKey: `${row?.id ?? path.basename(file)}:${row?.timestamp ?? ''}`,
      });
    }
  }
  return records;
}

function aggregate(provider: string, label: string, records: UsageRecord[], note?: string): ProviderUsage {
  const models = new Map<string, ModelUsage>();
  const daily = new Map<string, { tokens: number; cost: number | null }>();
  const sessions = new Set<string>();
  const total = zeroTokens();
  let lastActivity: string | null = null;

  for (const r of records) {
    addTokens(total, r.tokens);
    sessions.add(r.session);
    if (r.ts && (!lastActivity || r.ts > lastActivity)) lastActivity = r.ts;

    let mu = models.get(r.model);
    if (!mu) { mu = { model: r.model, tokens: zeroTokens(), cost: 0, messages: 0 }; models.set(r.model, mu); }
    addTokens(mu.tokens, r.tokens);
    mu.messages += 1;
    const c = estimateCost(r.model, r.tokens);
    mu.cost = mu.cost === null ? null : (c === null ? mu.cost : mu.cost + c);

    const day = (r.ts || '').slice(0, 10) || 'unknown';
    const du = daily.get(day) ?? { tokens: 0, cost: 0 };
    du.tokens += sumTokens(r.tokens);
    if (c !== null && du.cost !== null) du.cost += c;
    daily.set(day, du);
  }

  const modelList = [...models.values()].sort((a, b) => sumTokens(b.tokens) - sumTokens(a.tokens));
  const cost = modelList.some((m) => m.cost !== null)
    ? modelList.reduce((s, m) => s + (m.cost ?? 0), 0)
    : null;

  return {
    provider,
    label,
    available: records.length > 0,
    note: records.length === 0 ? (note ?? 'no local usage logs found') : undefined,
    tokens: total,
    cost,
    sessions: sessions.size,
    messages: records.length,
    models: modelList,
    daily: [...daily.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    lastActivity,
  };
}

function unavailable(provider: string, label: string, note: string): ProviderUsage {
  return {
    provider, label, available: false, note,
    tokens: zeroTokens(), cost: null, sessions: 0, messages: 0, models: [], daily: [], lastActivity: null,
  };
}

/** Collect usage for every supported provider (log-based today; API adapters slot in here). */
export function collectUsage(home: string = os.homedir()): UsageReport {
  return {
    generatedAt: new Date().toISOString(),
    providers: [
      aggregate('claude-code', 'Claude Code', collectClaudeCode(home)),
      aggregate('codex', 'Codex', collectCodex(home)),
      aggregate('gemini', 'Gemini', collectGemini(home)),
      unavailable('copilot', 'GitHub Copilot', 'no local token log — needs the GitHub Copilot usage API'),
      unavailable('cursor', 'Cursor', 'no local token log — needs the Cursor admin usage API'),
    ],
  };
}
