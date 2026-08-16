// The local web viewer: a zero-dependency node:http server bound to loopback
// only. Serves the single-file page plus a JSON API over the SQLite index.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, type ScoredEntry } from '../store/db.js';
import { findProjectRoot } from '../store/jsonl.js';
import { knownRoots } from '../store/roots.js';
import { agentMeta } from '../agents/registry.js';
import { workspaceIdentity } from '../workspace.js';

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

    // ?project= names a stable logical workspace id. Continue accepting a
    // previously-known root path as a backwards-compatible alias, but never
    // resolve an arbitrary request path (that would become a path oracle).
    const roots = [...new Set([...knownRoots(), ...(startRoot ? [startRoot] : [])])];
    const rootAliases = new Map(roots.map((root) => [root, workspaceIdentity(root).id]));
    const allowed = new Set<string>(index.projectSummaries().map((p) => p.id));
    for (const id of rootAliases.values()) allowed.add(id);
    const requestedScope = requested && requested !== 'all'
      ? (rootAliases.get(requested) ?? requested)
      : requested;
    if (requestedScope && requestedScope !== 'all' && !allowed.has(requestedScope)) {
      json(res, 400, { error: 'unknown project' });
      return;
    }
    const startWorkspace = startRoot ? workspaceIdentity(startRoot).id : null;
    const scope = requestedScope === 'all' ? null : (requestedScope ?? startWorkspace);

    // Self-heal every checkout belonging to the scoped workspace from JSONL
    // truth, so separate clones contribute to one logical history.
    const now = Date.now();
    if (scope) {
      for (const root of roots) {
        if (rootAliases.get(root) !== scope || !fs.existsSync(root)) continue;
        if (now - (lastIndexed.get(root) ?? 0) <= REINDEX_INTERVAL_MS) continue;
        lastIndexed.set(root, now);
        try {
          index.indexProject(root);
        } catch {
          // serve whatever the index already has
        }
      }
    }

    const projects = index.projectSummaries();
    // A freshly-inited project has a scope but zero entries — the client's
    // <select> still needs an option for it.
    if (scope && !projects.some((p) => p.id === scope)) {
      projects.unshift({
        id: scope,
        path: startRoot ?? '',
        name: startRoot ? path.basename(startRoot) : 'Workspace',
        count: 0,
        lastTs: '',
        roots: startRoot ? [startRoot] : [],
      });
    }

    // Workspace names are first-class search targets. An exact name query is
    // interpreted as "show this workspace" so every entry is returned, rather
    // than only entries that happen to repeat the name in their prose.
    const normalizedQuery = q.toLocaleLowerCase();
    const matchingWorkspaceIds = q
      ? projects
          .filter((project) => project.name.trim().toLocaleLowerCase() === normalizedQuery)
          .map((project) => project.id)
      : [];
    let results: ScoredEntry[];
    if (!q) {
      results = index.list({ workspaceId: scope ?? undefined, limit: 200 });
    } else if (scope && matchingWorkspaceIds.includes(scope)) {
      results = index.list({ workspaceId: scope, limit: 200 });
    } else if (!scope && matchingWorkspaceIds.length > 0) {
      const seen = new Set<string>();
      results = matchingWorkspaceIds
        .flatMap((workspaceId) => index.list({ workspaceId, limit: 200 }))
        .filter((result) => {
          if (seen.has(result.entry.id)) return false;
          seen.add(result.entry.id);
          return true;
        })
        .sort((a, b) => b.entry.ts.localeCompare(a.entry.ts))
        .slice(0, 200);
    } else {
      results = index.recall({ query: q, workspaceId: scope ?? undefined, limit: 100 });
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
