import path from 'path';

/**
 * SAFE STATIC SOURCE RESOLUTION (Phase 12)
 * ========================================
 * Resolves a request path to a real file that is genuinely contained inside an
 * allowed root, or returns `null`.
 *
 * WHY THIS EXISTS (the reproduced defect it replaces)
 * --------------------------------------------------
 * The production `/src/*` static fallback in server.ts used to do:
 *
 *     if (req.path.startsWith('/src/')) {
 *       const fullPath = path.join(process.cwd(), req.path);
 *       if (fs.existsSync(fullPath)) return res.sendFile(fullPath);
 *     }
 *
 * `path.join` NORMALISES `..` segments, so the path the code CHECKED was not the
 * path it SERVED:
 *
 *     req.path = '/src/../sql/schema.sql'
 *     '/src/../sql/schema.sql'.startsWith('/src/')   -> true   (guard passes)
 *     path.join(cwd, '/src/../sql/schema.sql')       -> <cwd>/sql/schema.sql
 *     existsSync(...) then sendFile(...)             -> served
 *
 * The same arithmetic maps '/src/../.env' to '<cwd>/.env'. So any non-dot file
 * under the deployment directory was readable unauthenticated, and because the
 * request still began with '/src/' the `srcBackendPathPrefixes` denylist added
 * specifically to stop backend-source disclosure was bypassed too
 * ('/src/../src/db/schema.ts' resolves back inside src/ but IS backend source).
 *
 * TWO RULES, both required
 * ------------------------
 *   1. NO parent-directory segment anywhere in the decoded path. A legitimate
 *      Vite/browser sourcemap request never needs one, and rule 2 alone is not
 *      sufficient: '/src/../src/db/schema.ts' resolves inside src/ and would
 *      re-enable the original backend-source disclosure.
 *   2. The resolved path must be the allowed root itself or a descendant of it.
 *
 * Deliberately pure and React-free so it is unit-testable in this repository's
 * node-only vitest environment (no jsdom), like utils/publicRoutes.ts.
 *
 * NOTE ON `path.resolve` AND A LEADING SLASH: on Windows a leading '/' or '\' is
 * "drive-rooted", so `path.resolve(cwd, '/src/x')` yields 'C:\src\x' — NOT
 * '<cwd>\src\x'. Because that would silently break every legitimate sourcemap
 * request, leading separators are stripped first and the remainder is resolved
 * RELATIVE to `baseDir`. Backslashes are unified to '/' so a '\..\' cannot
 * behave differently from a '/../'.
 */
export function resolveContainedSourcePath(
  allowedRoot: string,
  requestPath: string,
  baseDir: string = process.cwd()
): string | null {
  if (typeof requestPath !== 'string' || requestPath === '') return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    // A malformed percent-escape (e.g. '%zz') is never a legitimate file request.
    return null;
  }

  // A NUL byte can truncate the path inside the filesystem layer.
  if (decoded.includes('\0')) return null;

  const unified = decoded.replace(/\\/g, '/');

  // RULE 1 — reject any parent-directory segment outright.
  if (unified.split('/').includes('..')) return null;

  // Strip leading separators so the path is always interpreted RELATIVE to
  // baseDir (see the path.resolve note above).
  const relative = unified.replace(/^\/+/, '');
  if (relative === '') return null;

  const root = path.resolve(allowedRoot);
  const candidate = path.resolve(baseDir, relative);

  // RULE 2 — containment.
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null;

  return candidate;
}
