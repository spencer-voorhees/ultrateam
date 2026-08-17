// Derived SQLite index over every project's JSONL entries. Lives at
// ~/.ultrateam/index.db, powers cross-project queries and FTS5 ranked recall,
// and is disposable: `ultrateam reindex --all` rebuilds it from the JSONL
// files of every root in the projects.json registry.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Entry, EntrySchema } from '../schema.js';
import { canonicalAgentName } from '../agents/registry.js';
import { isUltrateamInstallDirectory, readEntries } from './jsonl.js';
import { defaultRootsPath, registerRoot, unregisterRoot } from './roots.js';
import { isWorkspaceId, workspaceIdentity } from '../workspace.js';

// Bump when the table shape changes: a mismatched index is dropped and
// rebuilt rather than migrated — it holds nothing original.
const SCHEMA_VERSION = 3;

export function defaultIndexPath(): string {
  return path.join(os.homedir(), '.ultrateam', 'index.db');
}

export interface RecallOptions {
  query?: string;
  files?: string[];
  branch?: string;
  /** Restrict to the logical workspace containing this root; omit for all workspaces. */
  projectPath?: string;
  /** Restrict directly to a logical workspace id (used by the viewer). */
  workspaceId?: string;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

export interface ScoredEntry {
  entry: Entry;
  projectPath: string;
  score: number;
}

export interface ProjectSummary {
  /** Stable logical workspace id. */
  id: string;
  /** Representative checkout root retained for API compatibility and diagnostics. */
  path: string;
  name: string;
  count: number;
  lastTs: string;
  roots: string[];
}

export interface AgentSummary {
  name: string;
  provider: string | null;
  models: string[];
  count: number;
  lastTs: string;
}

interface EntryRow {
  id: string;
  ts: string;
  project: string;
  project_path: string;
  workspace_id: string;
  branch: string | null;
  agent_name: string;
  agent_model: string | null;
  provider: string | null;
  kind: string;
  title: string;
  summary: string;
  files: string;
  decisions: string;
  open_threads: string;
  tags: string;
  resume: string | null;
  rank?: number;
}

const CANDIDATE_POOL = 200;
const DEFAULT_LIMIT = 8;

function sanitizeLimit(limit: number | undefined, fallback: number): number {
  return Number.isInteger(limit) && (limit as number) > 0 ? (limit as number) : fallback;
}

function ftsBody(e: Entry): string {
  return [
    e.project,
    e.title,
    e.summary,
    e.files.join(' '),
    e.decisions.join('\n'),
    e.open_threads.join('\n'),
    e.tags.join(' '),
    e.resume ? JSON.stringify(e.resume) : '',
    e.agent.name,
    e.agent.model ?? '',
    e.branch ?? '',
  ].join('\n');
}

/** Unicode-aware tokenizer shared by the FTS query builder and the fallback scorer. */
function tokenize(query: string): string[] {
  return query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function toFtsQuery(tokens: string[]): string {
  // Prefixes make search useful while the user is still typing ("auth" finds
  // "authentication") without relaxing FTS into an expensive substring scan.
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length > b.length) return editDistanceAtMostOne(b, a);

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length === b.length) {
      i++;
      j++;
    } else {
      j++;
    }
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

function wordMatchesQuery(word: string, queryToken: string): boolean {
  if (word.startsWith(queryToken)) return true;
  return queryToken.length >= 4 && editDistanceAtMostOne(word, queryToken);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function resolveWorkspaceScope(projectPath?: string, workspaceId?: string): string | undefined {
  if (workspaceId) return workspaceId;
  if (!projectPath) return undefined;
  return isWorkspaceId(projectPath) ? projectPath : workspaceIdentity(projectPath).id;
}

/** Overlap requires a path-segment boundary so "a.ts" never matches "schema.ts". */
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
}

function rowToEntry(row: EntryRow): Entry {
  return EntrySchema.parse({
    id: row.id,
    ts: row.ts,
    project: row.project,
    branch: row.branch,
    agent: {
      name: canonicalAgentName(row.agent_name),
      model: row.agent_model ?? undefined,
      provider: row.provider ?? undefined,
    },
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    files: JSON.parse(row.files),
    decisions: JSON.parse(row.decisions),
    open_threads: JSON.parse(row.open_threads),
    tags: JSON.parse(row.tags),
    resume: row.resume ? JSON.parse(row.resume) : null,
  });
}

export class Index {
  readonly db: DatabaseSync;
  readonly hasFts: boolean;
  private readonly rootsPath: string;

  constructor(dbPath: string = defaultIndexPath(), rootsPath: string = defaultRootsPath()) {
    this.rootsPath = rootsPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // WAL lets other ultrateam processes read while one writes; the busy
    // timeout makes overlapping writers wait instead of failing with SQLITE_BUSY.
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');

    const versionRow = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version !== SCHEMA_VERSION) {
      this.db.exec('DROP TABLE IF EXISTS entries; DROP TABLE IF EXISTS entries_fts;');
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT NOT NULL,
        ts TEXT NOT NULL,
        project TEXT NOT NULL,
        project_path TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        branch TEXT,
        agent_name TEXT NOT NULL,
        agent_model TEXT,
        provider TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        files TEXT NOT NULL,
        decisions TEXT NOT NULL,
        open_threads TEXT NOT NULL,
        tags TEXT NOT NULL,
        resume TEXT,
        PRIMARY KEY (id, project_path)
      );
      CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
      CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_path);
      CREATE INDEX IF NOT EXISTS idx_entries_workspace ON entries(workspace_id);
    `);
    let fts = true;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, project_path UNINDEXED, body)`,
      );
    } catch {
      // SQLite build without FTS5: recall degrades to token matching in JS.
      fts = false;
    }
    if (version !== SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    this.hasFts = fts;
  }

  private withTx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // connection-level failure; the original error matters more
      }
      throw err;
    }
  }

  private upsertRow(entry: Entry, projectPath: string, workspaceId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO entries
         (id, ts, project, project_path, workspace_id, branch, agent_name, agent_model, provider,
          kind, title, summary, files, decisions, open_threads, tags, resume)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.ts,
        entry.project,
        projectPath,
        workspaceId,
        entry.branch,
        canonicalAgentName(entry.agent.name),
        entry.agent.model ?? null,
        entry.agent.provider ?? null,
        entry.kind,
        entry.title,
        entry.summary,
        JSON.stringify(entry.files),
        JSON.stringify(entry.decisions),
        JSON.stringify(entry.open_threads),
        JSON.stringify(entry.tags),
        entry.resume ? JSON.stringify(entry.resume) : null,
      );
    if (this.hasFts) {
      this.db
        .prepare(`DELETE FROM entries_fts WHERE id = ? AND project_path = ?`)
        .run(entry.id, projectPath);
      this.db
        .prepare(`INSERT INTO entries_fts (id, project_path, body) VALUES (?, ?, ?)`)
        .run(entry.id, projectPath, ftsBody(entry));
    }
  }

  upsert(entry: Entry, projectPath: string): void {
    if (isUltrateamInstallDirectory(projectPath)) {
      throw new Error('Refusing to index the ultrateam installation directory as a workspace.');
    }
    const workspaceId = workspaceIdentity(projectPath).id;
    this.withTx(() => this.upsertRow(entry, projectPath, workspaceId));
    registerRoot(projectPath, this.rootsPath);
  }

  /**
   * Drop and re-add all of one project's entries from its JSONL file — in a
   * single transaction, so concurrent readers never observe a half-indexed
   * project.
   */
  indexProject(projectRoot: string): { indexed: number; skipped: number } {
    if (isUltrateamInstallDirectory(projectRoot)) {
      this.removeProject(projectRoot);
      unregisterRoot(projectRoot, this.rootsPath);
      return { indexed: 0, skipped: 0 };
    }
    const { entries, skipped } = readEntries(projectRoot);
    const workspaceId = workspaceIdentity(projectRoot).id;
    this.withTx(() => {
      if (this.hasFts) {
        this.db.prepare(`DELETE FROM entries_fts WHERE project_path = ?`).run(projectRoot);
      }
      this.db.prepare(`DELETE FROM entries WHERE project_path = ?`).run(projectRoot);
      for (const entry of entries) this.upsertRow(entry, projectRoot, workspaceId);
    });
    registerRoot(projectRoot, this.rootsPath);
    return { indexed: entries.length, skipped };
  }

  removeProject(projectRoot: string): void {
    this.withTx(() => {
      if (this.hasFts) {
        this.db.prepare(`DELETE FROM entries_fts WHERE project_path = ?`).run(projectRoot);
      }
      this.db.prepare(`DELETE FROM entries WHERE project_path = ?`).run(projectRoot);
    });
  }

  projectPaths(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT project_path AS p FROM entries ORDER BY p`)
      .all() as unknown as Array<{ p: string }>;
    return rows.map((r) => r.p);
  }

  get(id: string): ScoredEntry | null {
    const row = this.db.prepare(`SELECT * FROM entries WHERE id = ? LIMIT 1`).get(id) as
      | EntryRow
      | undefined;
    if (!row) return null;
    return { entry: rowToEntry(row), projectPath: row.project_path, score: 0 };
  }

  list(opts: { projectPath?: string; workspaceId?: string; limit?: number } = {}): ScoredEntry[] {
    const limit = sanitizeLimit(opts.limit, 20);
    const workspaceId = resolveWorkspaceScope(opts.projectPath, opts.workspaceId);
    // GROUP BY id: a diary committed to git and indexed from two checkouts
    // exists under both roots — show the entry once.
    const rows = (
      workspaceId
        ? this.db
            .prepare(`SELECT * FROM entries WHERE workspace_id = ? GROUP BY id ORDER BY ts DESC LIMIT ?`)
            .all(workspaceId, limit)
        : this.db
            .prepare(`SELECT * FROM entries GROUP BY id ORDER BY ts DESC LIMIT ?`)
            .all(limit)
    ) as unknown as EntryRow[];
    return rows.map((r) => ({ entry: rowToEntry(r), projectPath: r.project_path, score: 0 }));
  }

  /** Latest portable execution state, preferring the current branch when timestamps tie in relevance. */
  latestResume(opts: { projectPath?: string; workspaceId?: string; branch?: string } = {}): ScoredEntry | null {
    const workspaceId = resolveWorkspaceScope(opts.projectPath, opts.workspaceId);
    const scope = workspaceId ? 'AND workspace_id = ?' : '';
    const params = workspaceId ? [workspaceId] : [];
    const branchOrder = opts.branch ? 'CASE WHEN branch = ? THEN 1 ELSE 0 END DESC,' : '';
    const branchParams = opts.branch ? [opts.branch] : [];
    // Prefer entries carrying a native resume capsule. A legacy handoff remains
    // resumable so upgrading never strands existing history.
    const row = this.db
      .prepare(
        `SELECT * FROM entries
         WHERE (resume IS NOT NULL OR kind = 'handoff') ${scope}
         ORDER BY ${branchOrder} (resume IS NOT NULL) DESC, ts DESC, id DESC
         LIMIT 1`,
      )
      .get(...params, ...branchParams) as EntryRow | undefined;
    if (!row) return null;
    return { entry: rowToEntry(row), projectPath: row.project_path, score: 0 };
  }

  resumeById(id: string, opts: { projectPath?: string; workspaceId?: string } = {}): ScoredEntry | null {
    const workspaceId = resolveWorkspaceScope(opts.projectPath, opts.workspaceId);
    const row = (
      workspaceId
        ? this.db.prepare(
            `SELECT * FROM entries
             WHERE id = ? AND workspace_id = ? AND (resume IS NOT NULL OR kind = 'handoff') LIMIT 1`,
          ).get(id, workspaceId)
        : this.db.prepare(
            `SELECT * FROM entries WHERE id = ? AND (resume IS NOT NULL OR kind = 'handoff') LIMIT 1`,
          ).get(id)
    ) as EntryRow | undefined;
    if (!row) return null;
    return { entry: rowToEntry(row), projectPath: row.project_path, score: 0 };
  }

  /**
   * Ranked retrieval: FTS5 relevance (or token matching without FTS) blended
   * with recency decay, file overlap, and branch affinity. Scope filters are
   * applied in SQL, before the candidate-pool LIMIT, so a busy sibling
   * project can never starve a scoped recall.
   */
  recall(opts: RecallOptions = {}): ScoredEntry[] {
    const limit = sanitizeLimit(opts.limit, DEFAULT_LIMIT);
    const queryGiven = opts.query !== undefined && opts.query.trim() !== '';
    const tokens = queryGiven ? tokenize(opts.query as string) : [];
    // A real query that yields no searchable tokens must not silently degrade
    // into a recency dump presented as "most relevant".
    if (queryGiven && tokens.length === 0) return [];

    const scope: string[] = [];
    const scopeParams: string[] = [];
    const workspaceId = resolveWorkspaceScope(opts.projectPath, opts.workspaceId);
    if (workspaceId) {
      scope.push('e.workspace_id = ?');
      scopeParams.push(workspaceId);
    }
    if (opts.since) {
      scope.push('e.ts >= ?');
      scopeParams.push(opts.since);
    }

    let rows: EntryRow[];
    if (tokens.length > 0 && this.hasFts) {
      const where = scope.map((c) => ` AND ${c}`).join('');
      rows = this.db
        .prepare(
          `SELECT e.*, bm25(entries_fts) AS rank
           FROM entries_fts
           JOIN entries e
             ON e.id = entries_fts.id AND e.project_path = entries_fts.project_path
           WHERE entries_fts MATCH ?${where}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(toFtsQuery(tokens), ...scopeParams, CANDIDATE_POOL) as unknown as EntryRow[];
      // FTS deliberately stays fast and strict. If it finds nothing, make one
      // bounded pass over recent scoped entries so a single typo does not turn
      // an otherwise useful search into an empty feed.
      if (rows.length === 0) {
        const fallbackWhere = scope.length > 0 ? ` WHERE ${scope.join(' AND ')}` : '';
        rows = this.db
          .prepare(`SELECT e.* FROM entries e${fallbackWhere} ORDER BY e.ts DESC LIMIT ?`)
          .all(...scopeParams, CANDIDATE_POOL) as unknown as EntryRow[];
      }
    } else {
      const where = scope.length > 0 ? ` WHERE ${scope.join(' AND ')}` : '';
      rows = this.db
        .prepare(`SELECT e.* FROM entries e${where} ORDER BY e.ts DESC LIMIT ?`)
        .all(...scopeParams, CANDIDATE_POOL) as unknown as EntryRow[];
    }

    const now = Date.now();
    const wantedFiles = (opts.files ?? []).map(normalizePath);

    const scored: ScoredEntry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);

      let score = 0;

      // Text relevance blends FTS ranking with human-meaningful signals. This
      // makes title/phrase and full-query matches beat incidental body hits.
      if (tokens.length > 0) {
        const query = (opts.query as string).trim().toLowerCase();
        const bodyWords = tokenize(ftsBody(entry));
        const title = entry.title.toLowerCase();
        const summary = entry.summary.toLowerCase();
        const titleWords = tokenize(entry.title);
        const matched = tokens.filter((token) => bodyWords.some((word) => wordMatchesQuery(word, token)));
        if (matched.length === 0) continue;

        score += matched.length * 2;
        if (matched.length === tokens.length) score += 3;
        if (title.includes(query)) score += 8;
        else if (summary.includes(query)) score += 4;
        if (tokens.every((token) => titleWords.some((word) => wordMatchesQuery(word, token)))) score += 4;
        // bm25() is negative-is-better; flip it positive when this row came
        // from the FTS candidate query. Fuzzy fallback rows have no rank.
        score += Math.max(0, -(row.rank ?? 0)) * 2;
      }

      // Recency: half-life of one week.
      const ageDays = Math.max(0, (now - Date.parse(entry.ts)) / 86_400_000);
      score += 4 * Math.pow(0.5, ageDays / 7);

      // File overlap with what the caller is touching now.
      if (wantedFiles.length > 0) {
        const entryFiles = entry.files.map(normalizePath);
        let overlap = 0;
        for (const w of wantedFiles) {
          if (entryFiles.some((f) => pathsOverlap(f, w))) overlap++;
        }
        score += Math.min(overlap * 1.5, 4.5);
      }

      // Same-branch affinity.
      if (opts.branch && entry.branch === opts.branch) score += 2;

      // Handoffs are written to be resumed from; nudge them upward.
      if (entry.kind === 'handoff') score += 1;

      scored.push({ entry, projectPath: row.project_path, score });
    }

    scored.sort((a, b) => b.score - a.score || b.entry.ts.localeCompare(a.entry.ts));

    // Dedup by id: the same committed entry indexed from two checkouts is one
    // piece of history, not two results.
    const seen = new Set<string>();
    const out: ScoredEntry[] = [];
    for (const s of scored) {
      if (seen.has(s.entry.id)) continue;
      seen.add(s.entry.id);
      out.push(s);
      if (out.length === limit) break;
    }
    return out;
  }

  projectSummaries(): ProjectSummary[] {
    // Latest-wins name (MAX(project) would pick the alphabetically-last name
    // a project ever had, not its current one).
    const rows = this.db
      .prepare(
        `SELECT workspace_id AS workspaceId, project_path AS root, project AS name, ts, id
         FROM entries ORDER BY ts ASC, id ASC`,
      )
      .all() as unknown as Array<{ workspaceId: string; root: string; name: string; ts: string; id: string }>;
    const byWorkspace = new Map<string, ProjectSummary & { _lastId: string; _entryIds: Set<string>; _roots: Set<string> }>();
    for (const r of rows) {
      const cur = byWorkspace.get(r.workspaceId);
      if (!cur) {
        byWorkspace.set(r.workspaceId, {
          id: r.workspaceId,
          path: r.root,
          name: r.name,
          count: 1,
          lastTs: r.ts,
          roots: [r.root],
          _lastId: r.id,
          _entryIds: new Set([r.id]),
          _roots: new Set([r.root]),
        });
      } else {
        if (!cur._entryIds.has(r.id)) {
          cur._entryIds.add(r.id);
          cur.count++;
        }
        cur._roots.add(r.root);
        if (r.ts > cur.lastTs || (r.ts === cur.lastTs && r.id >= cur._lastId)) {
          cur.lastTs = r.ts;
          cur._lastId = r.id;
          cur.name = r.name;
          cur.path = r.root;
        }
      }
    }
    return [...byWorkspace.values()]
      .map(({ _lastId, _entryIds, _roots, ...p }) => ({ ...p, roots: [..._roots].sort() }))
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs));
  }

  agentSummaries(projectPath?: string): AgentSummary[] {
    // Group per (agent, model, provider) in SQL, fold in JS: model ids are
    // arbitrary text (commas included), so GROUP_CONCAT round-trips corrupt
    // them; and provider must be latest-wins, not MAX().
    const workspaceId = resolveWorkspaceScope(projectPath);
    const sql = `SELECT agent_name AS name, agent_model AS model, provider,
                        COUNT(DISTINCT id) AS n, MAX(ts) AS lastTs, MAX(id) AS lastId
                 FROM entries ${workspaceId ? 'WHERE workspace_id = ?' : ''}
                 GROUP BY agent_name, agent_model, provider`;
    const rows = (
      workspaceId ? this.db.prepare(sql).all(workspaceId) : this.db.prepare(sql).all()
    ) as unknown as Array<{
      name: string;
      model: string | null;
      provider: string | null;
      n: number;
      lastTs: string;
      lastId: string;
    }>;
    const byAgent = new Map<string, AgentSummary & { _providerTs: string; _providerId: string }>();
    for (const r of rows) {
      const name = canonicalAgentName(r.name);
      let a = byAgent.get(name);
      if (!a) {
        a = { name, provider: null, models: [], count: 0, lastTs: '', _providerTs: '', _providerId: '' };
        byAgent.set(name, a);
      }
      a.count += r.n;
      if (r.lastTs > a.lastTs || (r.lastTs === a.lastTs && r.lastId >= a._providerId)) {
        a.lastTs = r.lastTs;
      }
      if (r.lastTs > a._providerTs || (r.lastTs === a._providerTs && r.lastId >= a._providerId)) {
        a._providerTs = r.lastTs;
        a._providerId = r.lastId;
        a.provider = r.provider;
      }
      if (r.model && !a.models.includes(r.model)) a.models.push(r.model);
    }
    return [...byAgent.values()]
      .map(({ _providerTs, _providerId, ...a }) => a)
      .sort((a, b) => b.count - a.count);
  }

  /** Scope-wide truthful counts, independent of any feed cap or ordering. */
  stats(projectPath?: string): { entries: number; handoffs: number; openThreads: number } {
    const workspaceId = resolveWorkspaceScope(projectPath);
    const where = workspaceId ? 'WHERE workspace_id = ?' : '';
    const params = workspaceId ? [workspaceId] : [];
    const counts = this.db
      .prepare(`SELECT COUNT(DISTINCT id) AS n, COUNT(DISTINCT CASE WHEN kind = 'handoff' THEN id END) AS h FROM entries ${where}`)
      .get(...params) as { n: number; h: number };
    const latest = this.db
      .prepare(
        `SELECT open_threads FROM entries ${where ? where + ' AND' : 'WHERE'} kind = 'handoff'
         ORDER BY ts DESC, id DESC LIMIT 1`,
      )
      .get(...params) as { open_threads: string } | undefined;
    let openThreads = 0;
    if (latest) {
      try {
        openThreads = (JSON.parse(latest.open_threads) as string[]).length;
      } catch {
        // corrupt index row; reindex will heal it
      }
    }
    return { entries: counts.n, handoffs: counts.h, openThreads };
  }

  /** Timestamps of scope entries since `sinceIso` (for client-side day bucketing). */
  recentTs(projectPath: string | undefined, sinceIso: string, limit = 5000): string[] {
    const workspaceId = resolveWorkspaceScope(projectPath);
    const sql = `SELECT MAX(ts) AS ts FROM entries ${workspaceId ? 'WHERE workspace_id = ? AND' : 'WHERE'} ts >= ?
                 GROUP BY id
                 ORDER BY ts DESC LIMIT ?`;
    const rows = (
      workspaceId
        ? this.db.prepare(sql).all(workspaceId, sinceIso, limit)
        : this.db.prepare(sql).all(sinceIso, limit)
    ) as unknown as Array<{ ts: string }>;
    return rows.map((r) => r.ts);
  }

  close(): void {
    this.db.close();
  }
}
