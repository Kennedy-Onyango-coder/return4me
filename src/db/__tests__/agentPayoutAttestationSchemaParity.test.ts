import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const ATTESTATION_COLUMNS = [
  'attested_at',
  'attested_by',
  'attestation_method',
  'attestation_note',
];

// =============================================================================
// PHASE 2 — THE ATTESTATION COLUMNS MUST AGREE IN ALL THREE DECLARATIONS
// =============================================================================
// src/db/schema.ts (Drizzle), src/db/index.ts (idempotent runtime DDL) and
// sql/schema.sql (the declaration used by migrations) must never drift. The
// runtime ADD COLUMN statements are what an EXISTING database actually receives,
// because CREATE TABLE IF NOT EXISTS is a no-op there.

function createTableBlock(source: string, marker: string, terminator: string) {
  const start = source.indexOf(marker);
  expect(start, marker).toBeGreaterThan(-1);
  const end = source.indexOf(terminator, start);
  expect(end, `${marker} terminator`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('Phase 2 — attestation schema parity', () => {
  it('sql/schema.sql declares the four columns in order', () => {
    const block = createTableBlock(
      read('sql/schema.sql'),
      'CREATE TABLE agent_payout_destination_changes (',
      '\n);',
    );
    let last = -1;
    for (const column of ATTESTATION_COLUMNS) {
      const at = block.indexOf(column);
      expect(at, `sql/schema.sql must declare ${column}`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('src/db/schema.ts declares the four Drizzle columns in order', () => {
    const block = createTableBlock(
      read('src/db/schema.ts'),
      'export const agent_payout_destination_changes = pgTable(',
      '\n);',
    );
    let last = -1;
    for (const column of ATTESTATION_COLUMNS) {
      const at = block.indexOf(`${column}:`);
      expect(at, `schema.ts must declare ${column}`).toBeGreaterThan(last);
      last = at;
    }
  });

  it('src/db/index.ts creates the columns for a fresh database AND adds them idempotently', () => {
    const source = read('src/db/index.ts');
    const createBlock = createTableBlock(
      source,
      'CREATE TABLE IF NOT EXISTS agent_payout_destination_changes (',
      '`)',
    );
    for (const column of ATTESTATION_COLUMNS) {
      expect(createBlock).toContain(column);
      expect(source).toContain(
        `ALTER TABLE agent_payout_destination_changes ADD COLUMN IF NOT EXISTS ${column}`,
      );
    }
  });

  it('the complete-or-absent and dual-control constraints exist in all three sources', () => {
    for (const file of ['sql/schema.sql', 'src/db/index.ts', 'src/db/schema.ts']) {
      const text = read(file);
      expect(text, `${file} must declare the attestation completeness constraint`).toContain(
        'agent_payout_changes_attestation_check',
      );
      expect(text, `${file} must declare the dual-control constraint`).toContain(
        'agent_payout_changes_dual_control_check',
      );
      expect(text, `${file} must bound the note`).toContain('500');
    }
  });

  it('the attestation writer does not write phone_verified_at', () => {
    const source = read('src/db/database.ts');
    const start = source.indexOf('public async recordAgentPayoutDestinationAttestation');
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('public async recordAgentPayoutDestinationPhoneVerification', start);
    expect(end).toBeGreaterThan(start);
    const method = source.slice(start, end);
    // A prose reference is fine; an ASSIGNMENT is what would make this writer a
    // second phone-verification path.
    expect(method).not.toMatch(/phone_verified_at\s*:\s*(now|params|new Date)/);
    expect(method).toContain('attestation_note');
  });

  it('registration remains Personal M-Pesa only (no Till/Paybill/Pochi offer)', () => {
    const registration = read('src/components/AgentView.tsx');
    // The form offers the one supported method and explicitly refuses the rest;
    // there is no option list that could submit an unsupported method.
    expect(registration).toContain('Personal M-Pesa');
    expect(registration).toContain('Pochi la Biashara are not supported');
    expect(registration).not.toMatch(/<option[^>]*value=["']Till Number["']/);
    expect(registration).not.toMatch(/<option[^>]*value=["']Paybill Number["']/);
  });
});
