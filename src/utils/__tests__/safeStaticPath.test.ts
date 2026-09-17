import { describe, it, expect } from 'vitest';
import path from 'path';
import { resolveContainedSourcePath } from '../safeStaticPath';

// =============================================================================
// PHASE 12 — /src/* PATH-TRAVERSAL REGRESSION TEST
// =============================================================================
// The production static fallback in server.ts used to gate on the RAW request
// path and then resolve it with path.join(), which normalises '..':
//
//     if (req.path.startsWith('/src/')) {
//       const fullPath = path.join(process.cwd(), req.path);
//       if (fs.existsSync(fullPath)) return res.sendFile(fullPath);
//     }
//
// '/src/../sql/schema.sql' passes the guard (it DOES start with '/src/') and
// path.join resolves it to '<cwd>/sql/schema.sql' — outside src/. These tests
// pin the corrected behaviour on the helper the handler now delegates to, and
// they assert the OLD arithmetic really was bypassable so the regression cannot
// silently reappear as "just a refactor".
// =============================================================================

const base = process.cwd();
const srcRoot = path.join(base, 'src');

describe('legitimate sourcemap requests still resolve', () => {
  it('resolves a frontend file inside src/ to its real path', () => {
    expect(resolveContainedSourcePath(srcRoot, '/src/components/Navbar.tsx')).toBe(
      path.join(srcRoot, 'components', 'Navbar.tsx')
    );
    expect(resolveContainedSourcePath(srcRoot, '/src/App.tsx')).toBe(path.join(srcRoot, 'App.tsx'));
    expect(resolveContainedSourcePath(srcRoot, '/src/index.css')).toBe(path.join(srcRoot, 'index.css'));
  });

  it('is NOT drive-rooted by the leading slash (Windows path.resolve trap)', () => {
    // path.resolve(cwd, '/src/x') would yield 'C:\src\x' on Windows and silently
    // 404 every legitimate request. The result must stay under srcRoot.
    const resolved = resolveContainedSourcePath(srcRoot, '/src/App.tsx');
    expect(resolved).not.toBeNull();
    expect((resolved as string).startsWith(srcRoot + path.sep)).toBe(true);
  });

  it('tolerates an in-path "./" and a trailing slash', () => {
    expect(resolveContainedSourcePath(srcRoot, '/src/./App.tsx')).toBe(path.join(srcRoot, 'App.tsx'));
    expect(resolveContainedSourcePath(srcRoot, '/src/')).toBe(srcRoot);
  });
});

describe('traversal and denylist-bypass attempts are refused', () => {
  it('refuses the exact defect paths that were previously served', () => {
    for (const hostile of [
      '/src/../sql/schema.sql',
      '/src/../../.env',
      '/src/../package.json',
      '/src/../tsconfig.json',
      '/src/../README.md',
      '/src/../docs/DATA_RETENTION_POLICY.md',
    ]) {
      expect(resolveContainedSourcePath(srcRoot, hostile), `must refuse ${hostile}`).toBeNull();
    }
  });

  it('refuses the denylist re-entry that resolves back INSIDE src/ but is backend source', () => {
    // Containment alone would ALLOW this (it resolves to <cwd>/src/db/schema.ts),
    // which is exactly why a bare containment check is not sufficient.
    expect(resolveContainedSourcePath(srcRoot, '/src/../src/db/schema.ts')).toBeNull();
    expect(resolveContainedSourcePath(srcRoot, '/src/../src/server.ts')).toBeNull();
    expect(resolveContainedSourcePath(srcRoot, '/src/../src/services/auth.ts')).toBeNull();
  });

  it('refuses percent-encoded and backslash traversal', () => {
    for (const hostile of [
      '/src/%2e%2e/package.json',
      '/src/..%2F..%2F.env',
      '/src/%2e%2e%2f%2e%2e%2f.env',
      '/src/..\\..\\.env',
      '/src/..%5C..%5C.env',
    ]) {
      expect(resolveContainedSourcePath(srcRoot, hostile), `must refuse ${hostile}`).toBeNull();
    }
  });

  it('refuses absolute-looking paths and sibling-prefix confusion', () => {
    expect(resolveContainedSourcePath(srcRoot, '//etc/passwd')).toBeNull();
    expect(resolveContainedSourcePath(srcRoot, '/src/../src-evil/x.ts')).toBeNull();
    // 'src-evil' must not satisfy the containment check through a bare prefix test.
    expect(resolveContainedSourcePath(srcRoot, '/src-evil/x.ts')).toBeNull();
  });

  it('refuses NUL bytes, malformed escapes and empty input', () => {
    expect(resolveContainedSourcePath(srcRoot, '/src/a\u0000b.ts')).toBeNull();
    expect(resolveContainedSourcePath(srcRoot, '/src/%zz.ts')).toBeNull();
    expect(resolveContainedSourcePath(srcRoot, '')).toBeNull();
    expect(resolveContainedSourcePath(srcRoot, undefined as any)).toBeNull();
  });
});

describe('the defect this test exists for was real', () => {
  it('the OLD path.join arithmetic really did escape src/', () => {
    // Documented proof, so nobody can dismiss the guard as redundant: the naive
    // resolution used before the fix lands outside src/ for a path that passes
    // the `startsWith('/src/')` check.
    const hostile = '/src/../sql/schema.sql';
    expect(hostile.startsWith('/src/')).toBe(true);
    const naive = path.join(base, hostile);
    expect(naive.startsWith(srcRoot + path.sep)).toBe(false);
    expect(naive).toBe(path.join(base, 'sql', 'schema.sql'));
    // ...and the corrected helper refuses exactly that input.
    expect(resolveContainedSourcePath(srcRoot, hostile)).toBeNull();
  });
});
