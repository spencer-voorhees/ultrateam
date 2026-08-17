// The local web viewer: a zero-dependency node:http server bound to loopback
// only. Serves the single-file page plus a JSON API over the SQLite index.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Index, type ScoredEntry } from '../store/db.js';
import { findProjectRoot, isUltrateamInstallDirectory } from '../store/jsonl.js';
import { knownRoots, unregisterRoot } from '../store/roots.js';
import { agentMeta } from '../agents/registry.js';
import { workspaceIdentity } from '../workspace.js';

export interface ViewerOptions {
  port?: number;
  cwd?: string;
  instanceId?: string;
  /** Try subsequent loopback ports when the preferred port is occupied. */
  portFallback?: boolean;
}

export interface ViewerHandle {
  url: string;
  port: number;
  close(): void;
}

const DEFAULT_PORT = 4272;
const HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url));
const ICON_PATH = fileURLToPath(new URL('./ultrateam-icon.png', import.meta.url));

function json(res: http.ServerResponse, status: number, body: unknown, headOnly: boolean = false): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (headOnly) res.end();
  else res.end(JSON.stringify(body));
}

// Reindex a given root at most this often — /api/state is a read endpoint and
// must not become a write-amplification lever for whoever can send GETs.
const REINDEX_INTERVAL_MS = 5000;
const lastIndexed = new Map<string, number>();

function handleState(url: URL, startRoot: string | null, res: http.ServerResponse, headOnly: boolean = false): void {
  const index = new Index();
  try {
    const requested = url.searchParams.get('project');
    const q = url.searchParams.get('q')?.trim() ?? '';

    // ?project= names a stable logical workspace id. Continue accepting a
    // previously-known root path as a backwards-compatible alias, but never
    // resolve an arbitrary request path (that would become a path oracle).
    const candidateRoots = [...new Set([...knownRoots(), ...(startRoot ? [startRoot] : [])])];
    for (const root of candidateRoots) {
      if (!isUltrateamInstallDirectory(root)) continue;
      index.removeProject(root);
      unregisterRoot(root);
      lastIndexed.delete(root);
    }
    const roots = candidateRoots.filter((root) => !isUltrateamInstallDirectory(root));
    const rootAliases = new Map(roots.map((root) => [root, workspaceIdentity(root).id]));
    const allowed = new Set<string>(index.projectSummaries().map((p) => p.id));
    for (const id of rootAliases.values()) allowed.add(id);
    const requestedScope = requested && requested !== 'all'
      ? (rootAliases.get(requested) ?? requested)
      : requested;
    if (requestedScope && requestedScope !== 'all' && !allowed.has(requestedScope)) {
      json(res, 400, { error: 'unknown project' }, headOnly);
      return;
    }
    const startWorkspace = startRoot ? workspaceIdentity(startRoot).id : null;
    // Launch into the workspace the command was run from. The global index can
    // contain legitimate history from many projects, but presenting all of it
    // on first launch makes that history look like bundled/demo content.
    let scope = requestedScope === 'all'
      ? null
      : (requestedScope ?? startWorkspace);

    // Self-heal every checkout belonging to the scoped workspace (or all checkouts
    // when viewing all workspaces) from JSONL truth, so separate clones contribute
    // to one logical history.
    const now = Date.now();
    for (const root of roots) {
      if (scope && rootAliases.get(root) !== scope) continue;
      if (!fs.existsSync(root)) continue;
      if (now - (lastIndexed.get(root) ?? 0) <= REINDEX_INTERVAL_MS) continue;
      lastIndexed.set(root, now);
      try {
        index.indexProject(root);
      } catch {
        // serve whatever the index already has
      }
    }

    const projects = index.projectSummaries();
    // A workspace only exists once it holds real memory (an entry). Merge any
    // known sibling clone roots into a populated workspace, but never synthesize
    // an empty workspace from a registered-but-empty root — running a command or
    // launching the viewer from a directory must not create a phantom workspace.
    const rootsByWorkspace = new Map<string, string[]>();
    for (const [root, id] of rootAliases) {
      const workspaceRoots = rootsByWorkspace.get(id) ?? [];
      workspaceRoots.push(root);
      rootsByWorkspace.set(id, workspaceRoots);
    }
    for (const project of projects) {
      project.roots = [...new Set([...project.roots, ...(rootsByWorkspace.get(project.id) ?? [])])].sort();
    }
    projects.sort((a, b) => b.lastTs.localeCompare(a.lastTs) || a.name.localeCompare(b.name));
    if (scope && !projects.some((p) => p.id === scope)) {
      // The scoped workspace has no memory yet. Only show an empty placeholder
      // when the user explicitly navigated to it; if we merely defaulted to the
      // launch directory, present everything instead of inventing a workspace.
      if (requestedScope && requestedScope !== 'all') {
        projects.unshift({ id: scope, path: '', name: 'Workspace', count: 0, lastTs: '', roots: [] });
      } else {
        scope = null;
      }
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
    }, headOnly);
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
  const icon = fs.readFileSync(ICON_PATH);

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const isHead = req.method === 'HEAD';
      if (!hostAllowed(req)) {
        json(res, 403, { error: 'forbidden host' }, isHead);
      } else if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { error: 'method not allowed' }, isHead);
      } else if (url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        if (isHead) res.end();
        else res.end(page);
      } else if (url.pathname === '/ultrateam-icon.png' || url.pathname === '/favicon.ico') {
        res.writeHead(200, {
          'content-type': 'image/png',
          'cache-control': 'no-cache',
          'x-content-type-options': 'nosniff',
        });
        if (isHead) res.end();
        else res.end(icon);
      } else if (url.pathname === '/api/health') {
        json(res, 200, {
          app: 'ultrateam',
          instanceId: opts.instanceId ?? '',
          pid: process.pid,
        }, isHead);
      } else if (url.pathname === '/api/state') {
        handleState(url, startRoot, res, isHead);
      } else {
        json(res, 404, { error: 'not found' }, isHead);
      }
    } catch (err) {
      console.error(`[ultrateam] viewer request failed: ${String(err)}`);
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    const maxAttempts = opts.portFallback ? 21 : 1;
    let attempt = 0;

    const listen = (candidatePort: number): void => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (err.code === 'EADDRINUSE' && attempt + 1 < maxAttempts) {
          attempt += 1;
          // Port 0 asks the OS for an available ephemeral port. It is only
          // needed in the unlikely case the requested range reaches 65535.
          listen(candidatePort >= 65_535 ? 0 : candidatePort + 1);
          return;
        }
        if (err.code === 'EADDRINUSE') {
          reject(new Error(`Could not find an available viewer port starting at ${port}.`));
        } else {
          reject(err);
        }
      };
      server.once('error', onError);
      // Loopback only: memory is local data and stays local.
      server.listen(candidatePort, '127.0.0.1', () => {
        server.off('error', onError);
        const address = server.address();
        const boundPort = typeof address === 'object' && address ? address.port : candidatePort;
        resolve({
          url: `http://127.0.0.1:${boundPort}`,
          port: boundPort,
          close: () => server.close(),
        });
      });
    };

    listen(port);
  });
}
