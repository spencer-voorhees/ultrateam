// Derived SQLite index over every project's JSONL entries. Lives at
// ~/.ultrateam/index.db, powers cross-project queries and FTS5 ranked recall,
// and is disposable: `ultrateam reindex` rebuilds it from the JSONL files.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Entry, EntrySchema } from '../schema.js';
import { readEntries } from './jsonl.js';

export function defaultIndexPath(): string {
  return path.join(os.homedir(), '.ultrateam', 'index.db');
}

export interface RecallOptions {
  query?: string;
  files?: string[];
  branch?: string;
  /** Restrict to one project root; omit for all projects. */
  projectPath?: string;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

export interface ScoredEntry {
  entry: Entry;
  projectPath: string;
  score: number;
}

interface EntryRow {
  id: string;
  ts: string;
  project: string;
  project_path: string;
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
  rank?: number;
}

const CANDIDATE_POOL = 200;
const DEFAULT_LIMIT = 8;

function ftsBody(e: Entry): string {
  return [
    e.title,
    e.summary,
    e.files.join(' '),
    e.decisions.join('\n'),
    e.open_threads.join('\n'),
    e.tags.join(' '),
    e.agent.name,
    e.agent.model ?? '',
    e.branch ?? '',
  ].join('\n');
}

/** Turn free text into a safe FTS5 OR-query; null when no usable tokens. */
function toFtsQuery(query: string): string | null {
  const tokens = query.toLowerCase().match(/[a-z0-9_]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function rowToEntry(row: EntryRow): Entry {
  return EntrySchema.parse({
    id: row.id,
    ts: row.ts,
    project: row.project,
    branch: row.branch,
    agent: {
      name: row.agent_name,
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
  });
}

export class Index {
  readonly db: DatabaseSync;
  readonly hasFts: boolean;

  constructor(dbPath: string = defaultIndexPath()) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        project TEXT NOT NULL,
        project_path TEXT NOT NULL,
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
        tags TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entries_ts ON entries(ts);
      CREATE INDEX IF NOT EXISTS idx_entries_project ON entries(project_path);
    `);
    let fts = true;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(id UNINDEXED, body)`,
      );
    } catch {
      // SQLite build without FTS5: recall degrades to token matching in JS.
      fts = false;
    }
    this.hasFts = fts;
  }

  upsert(entry: Entry, projectPath: string): void {
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO entries
           (id, ts, project, project_path, branch, agent_name, agent_model, provider,
            kind, title, summary, files, decisions, open_threads, tags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.ts,
          entry.project,
          projectPath,
          entry.branch,
          entry.agent.name,
          entry.agent.model ?? null,
          entry.agent.provider ?? null,
          entry.kind,
          entry.title,
          entry.summary,
          JSON.stringify(entry.files),
          JSON.stringify(entry.decisions),
          JSON.stringify(entry.open_threads),
          JSON.stringify(entry.tags),
        );
      if (this.hasFts) {
        this.db.prepare(`DELETE FROM entries_fts WHERE id = ?`).run(entry.id);
        this.db
          .prepare(`INSERT INTO entries_fts (id, body) VALUES (?, ?)`)
          .run(entry.id, ftsBody(entry));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Drop and re-add all of one project's entries from its JSONL file. */
  indexProject(projectRoot: string): { indexed: number; skipped: number } {
    const { entries, skipped } = readEntries(projectRoot);
    this.db.exec('BEGIN');
    try {
      if (this.hasFts) {
        this.db
          .prepare(
            `DELETE FROM entries_fts WHERE id IN (SELECT id FROM entries WHERE project_path = ?)`,
          )
          .run(projectRoot);
      }
      this.db.prepare(`DELETE FROM entries WHERE project_path = ?`).run(projectRoot);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    for (const entry of entries) this.upsert(entry, projectRoot);
    return { indexed: entries.length, skipped };
  }

  removeProject(projectRoot: string): void {
    this.db.exec('BEGIN');
    try {
      if (this.hasFts) {
        this.db
          .prepare(
            `DELETE FROM entries_fts WHERE id IN (SELECT id FROM entries WHERE project_path = ?)`,
          )
          .run(projectRoot);
      }
      this.db.prepare(`DELETE FROM entries WHERE project_path = ?`).run(projectRoot);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  projectPaths(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT project_path AS p FROM entries ORDER BY p`)
      .all() as Array<{ p: string }>;
    return rows.map((r) => r.p);
  }

  get(id: string): ScoredEntry | null {
    const row = this.db.prepare(`SELECT * FROM entries WHERE id = ?`).get(id) as
      | EntryRow
      | undefined;
    if (!row) return null;
    return { entry: rowToEntry(row), projectPath: row.project_path, score: 0 };
  }

  list(opts: { projectPath?: string; limit?: number } = {}): ScoredEntry[] {
    const limit = opts.limit ?? 20;
    const rows = (
      opts.projectPath
        ? this.db
            .prepare(`SELECT * FROM entries WHERE project_path = ? ORDER BY ts DESC LIMIT ?`)
            .all(opts.projectPath, limit)
        : this.db.prepare(`SELECT * FROM entries ORDER BY ts DESC LIMIT ?`).all(limit)
    ) as unknown as EntryRow[];
    return rows.map((r) => ({ entry: rowToEntry(r), projectPath: r.project_path, score: 0 }));
  }

  /**
   * Ranked retrieval: FTS5 relevance (or token matching without FTS) blended
   * with recency decay, file overlap, and branch affinity.
   */
  recall(opts: RecallOptions = {}): ScoredEntry[] {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const ftsQuery = opts.query ? toFtsQuery(opts.query) : null;

    let rows: EntryRow[];
    if (ftsQuery && this.hasFts) {
      rows = this.db
        .prepare(
          `SELECT e.*, bm25(entries_fts) AS rank
           FROM entries_fts
           JOIN entries e ON e.id = entries_fts.id
           WHERE entries_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, CANDIDATE_POOL) as unknown as EntryRow[];
    } else {
      rows = this.db
        .prepare(`SELECT * FROM entries ORDER BY ts DESC LIMIT ?`)
        .all(CANDIDATE_POOL) as unknown as EntryRow[];
    }

    const now = Date.now();
    const wantedFiles = (opts.files ?? []).map(normalizePath);
    const queryTokens =
      opts.query?.toLowerCase().match(/[a-z0-9_]+/g)?.filter((t) => t.length > 1) ?? [];

    const scored: ScoredEntry[] = [];
    for (const row of rows) {
      if (opts.projectPath && row.project_path !== opts.projectPath) continue;
      if (opts.since && row.ts < opts.since) continue;
      const entry = rowToEntry(row);

      let score = 0;

      // Text relevance. bm25() is negative-is-better; flip it positive.
      if (ftsQuery && this.hasFts) {
        score += Math.max(0, -(row.rank ?? 0)) * 2;
      } else if (queryTokens.length > 0) {
        const body = ftsBody(entry).toLowerCase();
        const hits = queryTokens.filter((t) => body.includes(t)).length;
        if (hits === 0) continue;
        score += hits * 2;
      }

      // Recency: half-life of one week.
      const ageDays = Math.max(0, (now - Date.parse(entry.ts)) / 86_400_000);
      score += 4 * Math.pow(0.5, ageDays / 7);

      // File overlap with what the caller is touching now.
      if (wantedFiles.length > 0) {
        const entryFiles = entry.files.map(normalizePath);
        let overlap = 0;
        for (const w of wantedFiles) {
          if (entryFiles.some((f) => f === w || f.endsWith(w) || w.endsWith(f))) overlap++;
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
    return scored.slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
