import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// =============================================================================
// PHASE 6F — UI BOUNDARY GUARDS (static, file-text audit)
// =============================================================================
// Guards the 6F-authored client + presentation code so it can never, even by
// accident, hold a field it is not allowed to, call the server read model, log
// claim data, or issue a non-GET request. Static assertions on source text —
// no React/jsdom needed.
const ROOT = resolve(import.meta.dirname, '..', '..');
const SRC = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// 6F-authored NEW source files only. AdminView.tsx is pre-existing (edited to
// mount this tab) and keeps its own unrelated console/logging; it has a dedicated
// mount-only test below.
const NEW_FILES = [
  'src/services/adminClaimsApi.ts',
  'src/services/adminClaimsApiTypes.ts',
  'src/services/adminClaimsApiErrors.ts',
  'src/components/admin/claims/claimsPresentation.ts',
  'src/components/admin/claims/ClaimStatusBadge.tsx',
  'src/components/admin/claims/ClaimPaymentState.tsx',
  'src/components/admin/claims/ClaimPagination.tsx',
  'src/components/admin/claims/ClaimsFilters.tsx',
  'src/components/admin/claims/ClaimsTable.tsx',
  'src/components/admin/claims/ClaimDetailPanel.tsx',
  'src/components/admin/claims/ClaimsAdministration.tsx',
];

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

// De-comment AND de-string so a token mentioned only in a fixture string or a
// doc comment can never mask a real reference in code.
function codeOnly(file: string): string {
  let s = stripComments(SRC(file));
  s = s.replace(/`(?:[^`\\]|\\.|\$\{[^}]*\})*`/g, '""');
  s = s.replace(/(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '""');
  s = s.replace(/\/(?![\s/=])(?:[^/\\]|\\.)+\/[gimsuy]*/g, '//');
  return s;
}

function importSources(file: string): string[] {
  const s = stripComments(SRC(file));
  const sources: string[] = [];
  const re = /(?:(?:import|export)[^;]*?\bfrom\s+|require\s*\()\s*(['"])([^'"]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) sources.push(m[2]);
  return sources;
}

const PROHIBITED_FIELDS = [
  'payment_reference', 'security_answers', 'owner_identifying_details',
  'owner_identifying', 'owner_email', 'owner_id_proof_url',
  'code_hash', 'token_hash', 'claim_secret', 'pickup_code',
] as const;

const PROHIBITED_VERBS = [
  'updateClaimStatus', 'claimMutation', 'mutateClaim', 'refundClaim',
  'setClaimStatus', 'deleteClaim', 'cancelClaim',
] as const;

const PROHIBITED_IMPORT_SEGMENTS = [
  'db/database', '/db/', 'adminSafeViews', 'claimsSafeView',
  'routes/adminClaims', '../../server', 'adminClaims.ts',
] as const;

const PROHIBITED_READMODEL_CALLS = [
  'listAdminClaims', 'getAdminClaimDetail', 'getClaimDetail',
] as const;

describe('6F no sensitive fields exist in client source', () => {
  for (const file of NEW_FILES) {
    const code = codeOnly(file);
    it(`${file} does not reference a prohibited field`, () => {
      for (const field of PROHIBITED_FIELDS) {
        expect(code, `${file} references ${field}`).not.toContain(field);
      }
    });
        it(`${file} does not use a mutation verb`, () => {
      for (const verb of PROHIBITED_VERBS) {
        expect(code, `${file} uses ${verb}`).not.toContain(verb);
      }
    });
  }
});

describe('6F no direct DB / router / server / DTO imports in client source', () => {
  for (const file of NEW_FILES) {
    it(`${file} imports no prohibited boundary module`, () => {
      const sources = importSources(file);
      const bad = sources.filter((src) => PROHIBITED_IMPORT_SEGMENTS.some((seg) => src.includes(seg)));
      expect(bad, `${file} imports ${bad.join(', ')}`).toEqual([]);
    });
  }
});

describe('6F no logging of responses', () => {
  for (const file of NEW_FILES) {
    const code = codeOnly(file);
    it(`${file} never calls console.log`, () => {
      expect(code, `${file} calls console.log`).not.toContain('console.log');
    });
  }
});

describe('6F HTTP surface is read-only', () => {
  const raw = SRC('src/services/adminClaimsApi.ts');

  it('adminClaimsApi.ts only ever issues GET', () => {
    expect(raw).not.toMatch(/'POST'|"POST"|'PUT'|"PUT"|'PATCH'|"PATCH"|'DELETE'|"DELETE"/);
    expect(raw).toContain("method: 'GET'");
  });

  it('the list endpoint path is exactly /api/admin/claims', () => {
    expect(raw).toContain("const LIST_PATH = '/api/admin/claims'");
    expect(raw).not.toMatch(/(['"])\/api\/admin\/claims\/\?(['"])/);
  });
});

describe('6F adminClaimsApi.ts never calls the server-side read model', () => {
  const code = codeOnly('src/services/adminClaimsApi.ts');
  for (const fn of PROHIBITED_READMODEL_CALLS) {
    it(`adminClaimsApi.ts does not reference ${fn}`, () => {
      expect(code, fn).not.toContain(fn);
    });
  }
});

describe('6F AdminView integrates by mount only', () => {
  it('AdminView imports the claims administration component and nothing from the DB/router/server', () => {
    const vue = readFileSync(resolve(ROOT, 'src/components/AdminView.tsx'), 'utf8');
    expect(vue).toContain('ClaimsAdministration');
    expect(vue).not.toMatch(/import\s+[^;]*\b(db|adminSafeViews|adminClaims)\b/);
  });
});
