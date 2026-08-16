// The local web viewer: a zero-dependency node:http server bound to loopback
// only. Serves the single-file page plus a JSON API over the SQLite index.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index } from '../store/db.js';
import { findProjectRoot } from '../store/jsonl.js';
import { knownRoots } from '../store/roots.js';
import { agentMeta } from '../agents/registry.js';

export interface ViewerOptions {
  port?: number;
  cwd?: string;
}

export interface ViewerHandle {
  url: string;
  close(): void;
}

const DEFAULT_PORT = 4272;
const HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url));

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

// Reindex a given root at most this often — /api/state is a read endpoint and
// must not become a write-amplification lever for whoever can send GETs.
const REINDEX_INTERVAL_MS = 5000;
const lastIndexed = new Map<string, number>();

function handleState(url: URL, startRoot: string | null, res: http.ServerResponse): void {
  const index = new Index();
  try {
    const requested = url.searchParams.get('project');
    const q = url.searchParams.get('q')?.trim() ?? '';

    // ?project= must name a root ultrateam already knows — never an arbitrary
    // filesystem path (that would be a path-probing oracle, and indexProject
    // would permanently register attacker-chosen paths).
    const allowed = new Set<string>(knownRoots());
    for (const p of index.projectSummaries()) allowed.add(p.path);
    if (startRoot) allowed.add(startRoot);
    if (requested && requested !== 'all' && !allowed.has(requested)) {
      json(res, 400, { error: 'unknown project' });
      return;
    }
    const scope = requested === 'all' ? null : (requested ?? startRoot);

    // Self-heal the scoped project from JSONL truth (picks up entries other
    // agents wrote since the last request), throttled.
    const now = Date.now();
    if (scope && fs.existsSync(scope) && now - (lastIndexed.get(scope) ?? 0) > REINDEX_INTERVAL_MS) {
      lastIndexed.set(scope, now);
      try {
        index.indexProject(scope);
      } catch {
        // serve whatever the index already has
      }
    }

    const results = q
      ? index.recall({ query: q, projectPath: scope ?? undefined, limit: 100 })
      : index.list({ projectPath: scope ?? undefined, limit: 200 });

    const projects = index.projectSummaries();
    // A freshly-inited project has a scope but zero entries — the client's
    // <select> still needs an option for it.
    if (scope && !projects.some((p) => p.path === scope)) {
      projects.unshift({ path: scope, name: path.basename(scope), count: 0, lastTs: '' });
    }

    const fourteenDaysAgo = new Date(now - 15 * 86_400_000).toISOString();
    json(res, 200, {
      scope: scope ?? 'all',
      query: q || null,
      projects,
      stats: index.stats(scope ?? undefined),
      activityTs: index.recentTs(scope ?? undefined, fourteenDaysAgo),
      agents: index.agentSummaries(scope ?? undefined).map((a) => ({
        ...a,
        meta: agentMeta(a.name),
      })),
      entries: results.map((r) => ({
        ...r.entry,
        projectPath: r.projectPath,
        meta: agentMeta(r.entry.agent.name),
      })),
    });
  } finally {
    index.close();
  }
}

/** Defense against DNS rebinding: only loopback host names may talk to the API. */
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

export function startViewer(opts: ViewerOptions = {}): Promise<ViewerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const startRoot = findProjectRoot(opts.cwd ?? process.cwd());
  const page = fs.readFileSync(HTML_PATH);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (!hostAllowed(req)) {
        json(res, 403, { error: 'forbidden host' });
      } else if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' });
      } else if (url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(page);
      } else if (url.pathname === '/api/state') {
        handleState(url, startRoot, res);
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      console.error(`[ultrateam] viewer request failed: ${String(err)}`);
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use — try \`ultrateam view --port ${port + 1}\`.`));
      } else {
        reject(err);
      }
    });
    // Loopback only: the diary is local data and stays local.
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}
