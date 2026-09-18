import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { db } from '../db/database';
import { testRunId } from '../db/__tests__/ensureTestCategory';
import {
  PUBLIC_CLUE_STYLES,
  isPublicClueStyle,
  maskPublicDocumentNumber,
  buildSafePublicClues,
} from '../services/publicRecognition';

// ===========================================================================
// P14A (P14-05) — public_clue_style is actually configurable
//
// Before this change the column existed, the schema documented it as
// "Admin-configurable per category", and publicRecognition.ts implemented it —
// but neither POST nor PUT /api/admin/categories accepted it, so an
// admin-created sensitive category was permanently stuck on 'generic'.
//
// These tests pin the whole chain:
//   1. the vocabulary is a single allow-listed set;
//   2. the value really drives the masking (the persisted value is USED);
//   3. the DB layer persists it, and an OMITTED value preserves what exists;
//   4. the admin routes validate it and keep their authorization stack.
// ===========================================================================

const repoRoot = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.resolve(repoRoot, rel), 'utf8');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const SERVER_RAW = read('src/server.ts');
const ADMIN_VIEW = stripComments(read('src/components/AdminView.tsx'));

/**
 * The POST and PUT category-route bodies, sliced from the real server source.
 * Anchors are located in the RAW source and comments stripped only from the
 * slice: server.ts contains a stray `/*`-looking token that makes a naive
 * whole-file stripper swallow a whole region of the file.
 */
function categoryRouteBodies() {
  const post = SERVER_RAW.indexOf("app.post('/api/admin/categories'");
  const put = SERVER_RAW.indexOf("app.put('/api/admin/categories/:id'");
  const del = SERVER_RAW.indexOf("app.delete('/api/admin/categories/:id'");
  expect(post, 'POST /api/admin/categories not found').toBeGreaterThan(-1);
  expect(put, 'PUT /api/admin/categories/:id not found').toBeGreaterThan(post);
  expect(del, 'DELETE /api/admin/categories/:id not found').toBeGreaterThan(put);
  return {
    post: stripComments(SERVER_RAW.slice(post, put)),
    put: stripComments(SERVER_RAW.slice(put, del)),
  };
}

describe('P14-05 — the masking-style vocabulary is allow-listed', () => {
  it('is exactly the styles the masking logic implements', () => {
    expect([...PUBLIC_CLUE_STYLES]).toEqual([
      'none',
      'national_id',
      'passport',
      'driving_licence',
      'card',
      'generic',
    ]);
  });

  it('accepts every supported value', () => {
    for (const style of PUBLIC_CLUE_STYLES) {
      expect(isPublicClueStyle(style), `${style} must be accepted`).toBe(true);
    }
  });

  it('rejects arbitrary strings, near-misses and non-strings', () => {
    for (const bad of ['nonsense', '', 'NATIONAL_ID', 'national-id', 'generic ', 'none;drop', 1, null, undefined, {}, []]) {
      expect(isPublicClueStyle(bad as any), `${String(bad)} must be rejected`).toBe(false);
    }
  });
});

describe('P14-05 — the persisted style actually drives the public clue', () => {
  it('each style produces its own masking rule', () => {
    expect(maskPublicDocumentNumber('12345678', 'none')).toBeNull();
    expect(maskPublicDocumentNumber('12345678', 'national_id')).toBe('12******');
    expect(maskPublicDocumentNumber('A1234567', 'passport')).toBe('A*******');
    expect(maskPublicDocumentNumber('KX123456', 'driving_licence')).toBe('K*******');
    expect(maskPublicDocumentNumber('4111111111114821', 'card')).toBe('•••• 4821');
    expect(maskPublicDocumentNumber('XYZ987654', 'generic')).toBe('X********');
  });

  it("a category set to 'none' publishes no document-number clue at all", () => {
    const clues = buildSafePublicClues(
      {
        is_sensitive_document: true,
        verification_status: 'confirmed_as_reported',
        verified_name: 'Kennedy Onyango',
        verified_document_number: '12345678',
        verified_found_area: 'Nairobi',
      },
      { public_clue_style: 'none' },
    );
    expect(clues.documentNumberClue).toBeNull();
    // The name clue is a separate policy and is unaffected.
    expect(clues.nameClue).toBe('K****** O******');
  });

  it("a category set to 'card' publishes only the last four digits", () => {
    const clues = buildSafePublicClues(
      {
        is_sensitive_document: true,
        verification_status: 'confirmed_as_reported',
        verified_name: null,
        verified_document_number: '4111111111114821',
        verified_found_area: 'Nairobi',
      },
      { public_clue_style: 'card' },
    );
    expect(clues.documentNumberClue).toBe('•••• 4821');
  });
});

describe('P14-05 — the DB layer persists the style and preserves it when omitted', () => {
  const base = () => ({
    name_en: 'P14A Public Clue Style',
    name_sw: 'P14A Mtindo wa Kidokezo',
    total_fee: 100,
    finder_share: 25,
    agent_share: 35,
    platform_share: 40,
    is_sensitive_document: true,
  });

  it('stores a supplied style and defaults to generic when omitted', async () => {
    const withStyle = `TEST-PCS-${testRunId}-A`;
    const withoutStyle = `TEST-PCS-${testRunId}-B`;

    const created = await db.createCategory({ id: withStyle, ...base(), public_clue_style: 'none' });
    expect(created.public_clue_style).toBe('none');
    expect((await db.getCategory(withStyle))?.public_clue_style).toBe('none');

    await db.createCategory({ id: withoutStyle, ...base() } as any);
    // The column's own default, surfaced through parseCategory.
    expect((await db.getCategory(withoutStyle))?.public_clue_style).toBe('generic');
  });

  it('an update that OMITS the style leaves the stored value untouched', async () => {
    const id = `TEST-PCS-${testRunId}-C`;
    await db.createCategory({ id, ...base(), public_clue_style: 'passport' });

    await db.updateCategory(id, { ...base() } as any);
    expect((await db.getCategory(id))?.public_clue_style).toBe('passport');
  });

  it('an update that SUPPLIES the style writes it, including the strictest value', async () => {
    const id = `TEST-PCS-${testRunId}-D`;
    await db.createCategory({ id, ...base(), public_clue_style: 'generic' });

    await db.updateCategory(id, { ...base(), public_clue_style: 'none' } as any);
    expect((await db.getCategory(id))?.public_clue_style).toBe('none');

    await db.updateCategory(id, { ...base(), public_clue_style: 'card' } as any);
    expect((await db.getCategory(id))?.public_clue_style).toBe('card');
  });
});

describe('P14-05 — the admin routes enforce the allow-list and keep their auth stack', () => {
  it('both mutation routes validate the supplied value and reject anything else', () => {
    const { post, put } = categoryRouteBodies();
    for (const [label, body] of [['POST', post], ['PUT', put]] as const) {
      expect(body, `${label} must destructure public_clue_style`).toContain('public_clue_style,');
      expect(body, `${label} must validate with the shared predicate`).toContain('isPublicClueStyle(public_clue_style)');
      expect(body, `${label} must answer 400 for an unsupported value`).toMatch(/res\.status\(400\)/);
      expect(body, `${label} must pass the value to the DB layer`).toMatch(/public_clue_style: public_clue_style === undefined/);
    }
  });

  it('an omitted value is passed through as undefined (so defaults/existing values win)', () => {
    const { post, put } = categoryRouteBodies();
    const omitted = /public_clue_style:\s*public_clue_style === undefined \|\| public_clue_style === null \|\| public_clue_style === ''\s*\?\s*undefined/;
    expect(post).toMatch(omitted);
    expect(put).toMatch(omitted);
  });

  it('the authorization stack on the category mutation routes is unchanged', () => {
    const { post, put } = categoryRouteBodies();
    for (const [label, body] of [['POST', post], ['PUT', put]] as const) {
      expect(body, `${label} must keep authenticateJWT`).toContain('authenticateJWT');
      expect(body, `${label} must keep requireCurrentAdminSession`).toContain('requireCurrentAdminSession');
      expect(body, `${label} must keep the inline role check`).toContain("req.user?.role !== 'admin'");
    }
  });

  it('the console offers the style as a controlled select bound to the shared list', () => {
    expect(ADMIN_VIEW).toContain('PUBLIC_CLUE_STYLES.map');
    expect(ADMIN_VIEW).toContain('id="catFormPublicClueStyle"');
    expect(ADMIN_VIEW).toContain('public_clue_style: catFormPublicClueStyle');
  });
});
