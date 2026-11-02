import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ITEM_AGENT_ASSIGNMENT_COLUMNS,
  ITEM_ASSIGNMENT_ACTOR_ROLES,
  ITEM_ASSIGNMENT_EVENT_TYPES,
  ITEM_ASSIGNMENT_METHODS,
  ITEM_ASSIGNMENT_TRIGGER_SOURCES,
} from '../../config/itemAgentAssignmentPolicy';

// =============================================================================
// PHASE 16.1 BATCH 3 — STAGE 3B-2: SCHEMA PARITY, APPEND-ONLY, ATOMICITY.
//
// A separate file from batch3AssignmentHistory.test.ts because these are
// properties of the DECLARATIONS and of the STRUCTURE of the write paths, not of
// runtime behaviour:
//
//   1. The three schema representations stay IN LOCKSTEP — src/db/schema.ts
//      (Drizzle), sql/schema.sql (fresh bootstrap) and ensureSchemaUpToDate() in
//      src/db/index.ts (upgrade of an already-running database). A table created
//      by one path must be the table the other two describe, column for column,
//      in order. This repository has already shipped a table whose three
//      declarations disagreed (payout_repair_requests: 22 vs 23 vs 24 columns),
//      which is why the comparison is against ONE ordered list rather than
//      "is this name somewhere in the file".
//   2. The in-memory test double knows the table exists.
//   3. The table is APPEND-ONLY: exactly one insert site, no update, no delete.
//   4. Each assignment path writes its event on the SAME transaction handle as
//      the assignment it describes.
//
// Static inspection is the correct tool for (1), (3) and (4): they are properties
// of source text and of which statements share a handle, and (4) additionally
// cannot be observed at all in the in-memory harness, which strips
// BEGIN/COMMIT/ROLLBACK.
// =============================================================================

const dbDir = path.resolve(__dirname, '..');
const schemaTs = fs.readFileSync(path.join(dbDir, 'schema.ts'), 'utf8');
const schemaSql = fs.readFileSync(path.resolve(dbDir, '../../sql/schema.sql'), 'utf8');
const indexTs = fs.readFileSync(path.join(dbDir, 'index.ts'), 'utf8');
const databaseTs = fs.readFileSync(path.join(dbDir, 'database.ts'), 'utf8');
const serverTs = fs.readFileSync(path.resolve(dbDir, '../server.ts'), 'utf8');

const TABLE = 'item_agent_assignments';

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * One method body, from its signature to the first `\n  }` that closes it.
 *
 * Line endings are normalised first: this repository's files are CRLF on
 * Windows, and a bare '\n  }\n' search would never match there — the slice
 * would then run to the top of the file and "prove" statements share a
 * transaction that are a thousand lines apart.
 *
 * Shared by the read-API checks and the write-path checks below, so the two
 * cannot disagree about which statements belong to a method.
 */
function methodBody(signature: string): string {
  const source = stripComments(databaseTs).replace(/\r\n/g, '\n');
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`method not found in database.ts: ${signature}`);
  const end = source.indexOf('\n  }\n', start);
  if (end === -1) throw new Error(`could not find the end of ${signature}`);
  return source.slice(start, end);
}

/** The Drizzle table object literal, up to its index/check config argument. */
function drizzleTableBlock(): string {
  const start = schemaTs.indexOf(`export const ${TABLE} = pgTable(`);
  if (start === -1) throw new Error(`table not found in schema.ts: ${TABLE}`);
  const configStart = schemaTs.indexOf('(table) => {', start);
  return schemaTs.slice(start, configStart === -1 ? undefined : configStart);
}

/** The Drizzle index/check configuration block (everything after the columns). */
function drizzleTableConfig(): string {
  const tableStart = schemaTs.indexOf(`export const ${TABLE} = pgTable(`);
  const configStart = schemaTs.indexOf('(table) => {', tableStart);
  const next = schemaTs.indexOf('\nexport const ', configStart);
  return schemaTs.slice(configStart, next === -1 ? undefined : next);
}

/** A `CREATE TABLE [IF NOT EXISTS] item_agent_assignments (...)` block. */
function sqlTableBlock(source: string, ifNotExists: boolean): string {
  const header = ifNotExists ? `CREATE TABLE IF NOT EXISTS ${TABLE} (` : `CREATE TABLE ${TABLE} (`;
  const start = source.indexOf(header);
  if (start === -1) {
    throw new Error(`table not found (${ifNotExists ? 'idempotent' : 'bootstrap'} DDL): ${TABLE}`);
  }
  const end = source.indexOf('\n);', start);
  return source.slice(start, end === -1 ? undefined : end);
}

/** Column names, in declaration order, from a `CREATE TABLE` block. */
function sqlColumns(block: string): string[] {
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.toUpperCase().startsWith('CONSTRAINT'))
    .map((line) => line.match(/^([a-z_][a-z0-9_]*)\s+(VARCHAR|TEXT|NUMERIC|TIMESTAMP)/i))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1]);
}

/** Column names, in declaration order, from the Drizzle object literal. */
function drizzleColumns(block: string): string[] {
  const matcher = /^\s{4}([a-z_][a-z0-9_]*):\s*(?:varchar|text|numeric|timestamp|boolean|integer)\(/gm;
  return Array.from(block.matchAll(matcher)).map((match) => match[1]);
}

const bootstrapBlock = sqlTableBlock(schemaSql, false);
const idempotentBlock = sqlTableBlock(indexTs, true);

describe('B3-2 — the assignment-history table is declared identically in all three places', () => {
  it('declares the shared column list, in order, in the Drizzle schema', () => {
    expect(drizzleColumns(drizzleTableBlock())).toEqual([...ITEM_AGENT_ASSIGNMENT_COLUMNS]);
  });

  it('declares the shared column list, in order, in sql/schema.sql (fresh bootstrap)', () => {
    expect(sqlColumns(bootstrapBlock)).toEqual([...ITEM_AGENT_ASSIGNMENT_COLUMNS]);
  });

  it('declares the shared column list, in order, in ensureSchemaUpToDate() (upgrade path)', () => {
    expect(sqlColumns(idempotentBlock)).toEqual([...ITEM_AGENT_ASSIGNMENT_COLUMNS]);
  });

  it('keeps the runtime DDL idempotent, so booting twice is a no-op', () => {
    expect(idempotentBlock.startsWith(`CREATE TABLE IF NOT EXISTS ${TABLE} (`)).toBe(true);
    for (const index of [
      `CREATE INDEX IF NOT EXISTS idx_${TABLE}_item`,
      `CREATE INDEX IF NOT EXISTS idx_${TABLE}_new_agent`,
    ]) {
      expect(indexTs).toContain(index);
    }
    for (const constraint of [
      `${TABLE}_event_type_check`,
      `${TABLE}_method_check`,
      `${TABLE}_trigger_source_check`,
      `${TABLE}_actor_role_check`,
    ]) {
      expect(indexTs, `runtime DDL must re-assert ${constraint}`).toContain(
        `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${constraint}`,
      );
      expect(indexTs, `runtime DDL must add ${constraint}`).toContain(
        `ALTER TABLE ${TABLE} ADD CONSTRAINT ${constraint} CHECK`,
      );
    }
  });

  it('registers the table with the in-memory test double', () => {
    expect(indexTs).toMatch(new RegExp(`${TABLE}: \\[\\],`));
  });

  it('declares both indexes and all FIVE CHECK constraints in the Drizzle schema and in sql/schema.sql', () => {
    const config = drizzleTableConfig();
    for (const name of [
      `idx_${TABLE}_item`,
      `idx_${TABLE}_new_agent`,
      `${TABLE}_event_type_check`,
      `${TABLE}_method_check`,
      `${TABLE}_trigger_source_check`,
      `${TABLE}_actor_role_check`,
      // STAGE 3B-3 — the holder/event-type agreement rule.
      `${TABLE}_holder_shape_check`,
    ]) {
      expect(config, `Drizzle schema must declare ${name}`).toContain(name);
      expect(schemaSql, `sql/schema.sql must declare ${name}`).toContain(name);
    }
  });

  it('STAGE 3B-3: the holder-shape constraint exists in all three declarations', () => {
    // An `unassigned` row must name the outgoing agent and NO incoming agent, and
    // an assignment row must name a holder. Without this the two columns and the
    // event type could disagree, and the history would contradict itself.
    const config = drizzleTableConfig();
    expect(config).toContain(`${TABLE}_holder_shape_check`);
    expect(schemaSql).toContain(`${TABLE}_holder_shape_check`);
    expect(indexTs).toContain(`${TABLE}_holder_shape_check`);

    for (const source of [schemaSql, indexTs]) {
      expect(source).toContain("event_type = 'unassigned' AND new_agent_id IS NULL");
      expect(source).toContain("event_type <> 'unassigned' AND new_agent_id IS NOT NULL");
    }
  });

  it('derives every CHECK vocabulary from the one policy module, never from a second literal list', () => {
    const vocabularies = [
      ITEM_ASSIGNMENT_EVENT_TYPES,
      ITEM_ASSIGNMENT_METHODS,
      ITEM_ASSIGNMENT_TRIGGER_SOURCES,
      ITEM_ASSIGNMENT_ACTOR_ROLES,
    ];
    for (const values of vocabularies) {
      for (const value of values) {
        // sql/schema.sql is hand-written DDL, so every value must appear there
        // literally. (runtime DDL in index.ts interpolates the generated SQL
        // lists instead of repeating the literals — asserted separately below —
        // and the Drizzle schema imports the same lists.)
        expect(schemaSql, `sql/schema.sql is missing '${value}'`).toContain(`'${value}'`);
      }
    }
    for (const sqlList of [
      'ITEM_ASSIGNMENT_EVENT_TYPE_SQL_LIST',
      'ITEM_ASSIGNMENT_METHOD_SQL_LIST',
      'ITEM_ASSIGNMENT_TRIGGER_SOURCE_SQL_LIST',
      'ITEM_ASSIGNMENT_ACTOR_ROLE_SQL_LIST',
    ]) {
      expect(indexTs).toContain(sqlList);
      expect(schemaTs).toContain(sqlList);
    }
  });
});

// =============================================================================
// APPEND-ONLY, AND INTERNAL.
// =============================================================================
describe('B3-2 — the history is append-only in the application layer', () => {
  const code = stripComments(databaseTs);

  it('has exactly ONE insert site for the history table', () => {
    expect((code.match(/\.insert\(itemAgentAssignmentsTable\)/g) ?? []).length).toBe(1);
  });

  it('exposes no update path for a stored event', () => {
    expect(code).not.toMatch(/\.update\(itemAgentAssignmentsTable\)/);
    expect(code).not.toMatch(/UPDATE\s+item_agent_assignments/i);
    expect(code).not.toMatch(/updateItemAssignment/i);
  });

  it('exposes no delete path for a stored event', () => {
    expect(code).not.toMatch(/\.delete\(itemAgentAssignmentsTable\)/);
    expect(code).not.toMatch(/DELETE\s+FROM\s+item_agent_assignments/i);
    expect(code).not.toMatch(/deleteItemAssignment/i);
  });

  it('is read through exactly the TWO declared read APIs, and nothing else names the table', () => {
    // STAGE 3B-6B added a SECOND reader, and this invariant is stated in terms
    // of the readers rather than "exactly one" because "exactly one" is no
    // longer the architecture — it would forbid the only efficient shape the
    // stranded queue can use.
    //
    //   * getItemAssignmentHistory(itemId) — ONE item, oldest first. The
    //     chronological contract Stage 3B-2 defined, unchanged.
    //   * getLatestAssignmentEventsForItems(itemIds) — MANY items, newest
    //     first, reduced to one entry per item. The queue reads a whole console
    //     page of rows per request; looping the single-item reader there would
    //     be N queries for one screen. It is the same append-only table and the
    //     same parse, so it is not a second history, only a second question.
    //
    // What the invariant still forbids, and what is asserted below: a THIRD
    // read site anywhere in the data layer, any write of any kind from either
    // reader, and any route, DTO or public projection naming the table.
    const readSites = code.match(/from\(itemAgentAssignmentsTable\)/g) ?? [];
    expect(readSites.length).toBe(2);

    // Each site belongs to exactly one of the two declared readers, and the
    // single-item reader cannot be multiplied into a batch reader by accident.
    expect(
      (methodBody('public async getItemAssignmentHistory(').match(
        /from\(itemAgentAssignmentsTable\)/g,
      ) ?? []).length,
    ).toBe(1);
    expect(
      (methodBody('public async getLatestAssignmentEventsForItems(').match(
        /from\(itemAgentAssignmentsTable\)/g,
      ) ?? []).length,
    ).toBe(1);

    // No route or public projection touches it, so no DTO or privacy surface
    // changed in this stage.
    expect(stripComments(serverTs)).not.toContain(TABLE);
    expect(stripComments(serverTs)).not.toContain('getItemAssignmentHistory');
    // The queue reaches the history through the DATA LAYER's set-based reader,
    // called once with the ids it already has — not by looping the per-item
    // reader over a queue.
    expect(stripComments(serverTs)).toContain('db.getLatestAssignmentEventsForItems(');
  });

  it('each reader keeps its own declared shape: one item oldest-first, many items newest-first', () => {
    // The single-item contract is unchanged from Stage 3B-2: a total order
    // (created_at, then id) so two events sharing a timestamp stay ordered.
    const single = methodBody('public async getItemAssignmentHistory(');
    expect(single).toContain('eq(itemAgentAssignmentsTable.item_id, itemId)');
    expect(single).toContain('asc(itemAgentAssignmentsTable.created_at)');
    expect(single).toContain('asc(itemAgentAssignmentsTable.id)');

    const batch = methodBody('public async getLatestAssignmentEventsForItems(');
    // ONE statement over the ids the caller already has: never a per-item query.
    expect(batch).toContain('inArray(itemAgentAssignmentsTable.item_id, ids)');
    expect(batch).toContain('desc(itemAgentAssignmentsTable.created_at)');
    expect(batch).toContain('desc(itemAgentAssignmentsTable.id)');
    // An empty queue must not become `IN ()`, which PostgreSQL rejects; the
    // empty answer is stated rather than queried.
    expect(batch).toContain('if (ids.length === 0) return latest;');
    // The newest event is ALSO chosen in code, because the in-memory double
    // ignores ORDER BY — otherwise "latest" would only be true on PostgreSQL.
    expect(batch).toContain('isLaterAssignmentEvent(');
    // Batch means batch: ONE database round-trip for the whole queue, and the
    // only loop left is the in-memory reduction over rows already fetched.
    expect((batch.match(/\.select\(/g) ?? []).length).toBe(1);
    expect((batch.match(/await drizzleDb/g) ?? []).length).toBe(1);
  });
});


// =============================================================================
// ATOMICITY, AS A PROPERTY OF THE WRITE PATHS.
//
// The in-memory harness strips BEGIN/COMMIT/ROLLBACK, so "these two statements
// commit together" cannot be observed at runtime here — but WHICH HANDLE each
// statement is issued on can be, statically, and that is the whole mechanism.
// =============================================================================
describe('B3-2 — every assignment path writes its event on the assignment transaction', () => {
  it('attemptAutoAgentAssignment: one transaction, event written only AFTER the CAS won', () => {
    const body = methodBody('public async attemptAutoAgentAssignment(');

    const tx = body.indexOf('drizzleDb.transaction(');
    const update = body.indexOf('.update(itemsTable)');
    const lost = body.indexOf('if (rows.length === 0) return false;');
    const event = body.indexOf('insertItemAssignmentEventInTx(');

    expect(tx).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(tx);
    // The loser returns BEFORE the event site, so a failed CAS cannot record one.
    expect(lost).toBeGreaterThan(update);
    expect(event).toBeGreaterThan(lost);
    // Exactly one of each: no second write path, no second event.
    expect((body.match(/drizzleDb\.transaction\(/g) ?? []).length).toBe(1);
    expect((body.match(/insertItemAssignmentEventInTx\(/g) ?? []).length).toBe(1);
  });

  it('createItem: the insert and its first-assignment event share one transaction', () => {
    const body = methodBody('public async createItem(');

    const tx = body.indexOf('drizzleDb.transaction(');
    const insert = body.indexOf('.insert(itemsTable)');
    const event = body.indexOf('insertItemAssignmentEventInTx(');

    expect(tx).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(tx);
    expect(event).toBeGreaterThan(insert);
    expect((body.match(/drizzleDb\.transaction\(/g) ?? []).length).toBe(1);
  });

  it('adminAssignAgentAtomically: conditional (CAS) update plus event, in one transaction', () => {
    const body = methodBody('private async adminAssignAgentAtomically(');

    const tx = body.indexOf('drizzleDb.transaction(');
    const update = body.indexOf('.update(itemsTable)');
    const event = body.indexOf('insertItemAssignmentEventInTx(');

    expect(tx).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(tx);
    expect(event).toBeGreaterThan(update);

    // The previous holder is captured by a CONDITIONAL write, not by trusting a
    // separate read: the update only applies while the holder is still the one
    // that was observed.
    expect(body).toContain('isNull(itemsTable.assigned_agent_id)');
    expect(body).toContain('eq(itemsTable.assigned_agent_id, previousAgentId)');
    // A re-save that keeps the same holder is not a mutation and records nothing
    // (Stage 3B-3 returns a null outcome, which is also what stops the route
    // announcing a transfer that never happened).
    expect(body).toContain('if (previousAgentId === incomingAgentId) return null;');
    // SELECT ... FOR UPDATE is deliberately not used: the test double returns
    // zero rows for it, so it could never be exercised.
    expect(body).not.toContain("for('update'");
  });

  it('adminUpdateItem refuses an assignment that carries no attribution', () => {
    const body = methodBody('public async adminUpdateItem(');
    expect(body).toContain('requires an ItemAssignmentEventContext');
    expect(body).toContain('adminAssignAgentAtomically(');
    // It also refuses a column method that contradicts the attribution.
    expect(body).toContain('disagree');
  });

  it('the MANUAL audit lines commit with their mutation (H-1); the automatic one stays post-commit', () => {
    // H-1 (post-audit correction) changed exactly two audit lines: the manual
    // assignment and the manual unassignment now write theirs with
    // logAuditInTx(tx, ...) on the mutation's own transaction handle, BEFORE the
    // mutation is issued — so a failed audit write leaves the holder and the
    // history untouched instead of leaving a committed change nobody recorded.
    // The automatic path is deliberately UNCHANGED: it still writes its line
    // after its transaction, with the same prose as before.
    const auto = methodBody('public async attemptAutoAgentAssignment(');
    expect(auto.indexOf('await this.logAudit(')).toBeGreaterThan(
      auto.indexOf('const won = await drizzleDb.transaction('),
    );
    expect(auto).toContain('"AUTO_AGENT_ASSIGNMENT"');

    const admin = methodBody('private async adminAssignAgentAtomically(');
    expect(admin).toMatch(/logAuditInTx\(\s*tx,\s*"ADMIN",\s*"ADMIN_UPDATE_ITEM"/);
    // No second, post-commit write: exactly one line per committed change.
    expect(admin).not.toMatch(/this\.logAudit\(/);
    expect(admin).toContain('`Item ${id} was manually updated by admin.`');
    // Inside the transaction, and BEFORE the item write it describes.
    expect(admin.indexOf('logAuditInTx(')).toBeGreaterThan(admin.indexOf('drizzleDb.transaction('));
    expect(admin.indexOf('logAuditInTx(')).toBeLessThan(admin.indexOf('.update(itemsTable)'));
  });
});


// =============================================================================
// STAGE 3B-3 — THE UNASSIGNMENT PATH, AS A PROPERTY OF THE WRITE PATH.
// =============================================================================
describe('B3-3 — the unassignment writes its event on the unassignment transaction', () => {
  it('adminUnassignAgent: read, conditional update and event in ONE transaction', () => {
    const body = methodBody('public async adminUnassignAgent(');

    const tx = body.indexOf('drizzleDb.transaction(');
    const update = body.indexOf('.update(itemsTable)');
    const event = body.indexOf('insertItemAssignmentEventInTx(');

    expect(tx).toBeGreaterThan(-1);
    expect(update).toBeGreaterThan(tx);
    // The loser returns/throws BEFORE the event site, so a failed CAS cannot record one.
    expect(event).toBeGreaterThan(update);

    // Exactly one of each: no second write path, no second event.
    expect((body.match(/drizzleDb\.transaction\(/g) ?? []).length).toBe(1);
    expect((body.match(/insertItemAssignmentEventInTx\(/g) ?? []).length).toBe(1);
  });

  it('H-1 - the audit row is written on the SAME transaction, BEFORE the removal', () => {
    // Post-audit correction H-1: the removal's audit line used to be a separate
    // statement issued after commit, so a failed audit write left a COMMITTED
    // removal with no record of who made it, why, or whose custody ended. It is
    // now issued with logAuditInTx(tx, ...) inside this transaction, and before
    // the conditional write, so an audit failure leaves the holder, the history
    // and the audit trail untouched.
    const body = methodBody('public async adminUnassignAgent(');

    expect(body).toMatch(/logAuditInTx\(\s*tx,\s*"ADMIN",\s*"MANUAL_AGENT_UNASSIGNMENT"/);
    // No second, post-commit write survives the change: one line per removal.
    expect(body).not.toMatch(/this\.logAudit\(/);
    // The prose is unchanged (it still names the agent, the administrator and the reason).
    expect(body).toContain('was unassigned by ${context.actorId}');
    expect(body).toContain('Reason: ${context.reason');

    const audit = body.indexOf('logAuditInTx(');
    expect(audit).toBeGreaterThan(body.indexOf('drizzleDb.transaction('));
    expect(audit).toBeLessThan(body.indexOf('.update(itemsTable)'));
    expect(audit).toBeLessThan(body.indexOf('insertItemAssignmentEventInTx('));
  });

  it('H-2 - an explicitly observed "no holder" is a constraint, not "no opinion"', () => {
    const body = methodBody('public async adminUnassignAgent(');

    // The three forms are distinguished explicitly rather than by a single
    // "is it nullish?" test, which is what used to let a removal decided against
    // a holder-less item delete a NEWER assignment.
    expect(body).toContain('expectedPreviousAgentId === null && previousAgentId !== null');
    expect(body).toContain("'holder_changed'");
    // It refuses BEFORE the "nothing to remove" answer, so an item that gained a
    // holder is reported as a stale decision (409), not as an empty item.
    expect(
      body.indexOf('expectedPreviousAgentId === null && previousAgentId !== null'),
    ).toBeLessThan(body.indexOf('no_current_holder'));
    // `undefined` still means "no expectation": it is never turned into a refusal.
    expect(body).toContain('expectedPreviousAgentId !== undefined');
  });

  it('has NO CAS retry loop: a stale removal is refused, never retried onto a newer holder', () => {
    const body = methodBody('public async adminUnassignAgent(');
    expect(body).not.toContain('MAX_CAS_ATTEMPTS');
    // The conditional write is still there - it is what makes "remove THIS holder"
    // atomic rather than "remove whoever is there now".
    expect(body).toContain('eq(itemsTable.assigned_agent_id, previousAgentId)');
    expect(body).toContain('expectedPreviousAgentId');
  });

  it('checks custody and the reason BEFORE the item write', () => {
    const body = methodBody('public async adminUnassignAgent(');
    const reasonGate = body.indexOf('reason_required');
    const tx = body.indexOf('drizzleDb.transaction(');
    const custody = body.indexOf('describeManualUnassignmentRefusal');
    const update = body.indexOf('.update(itemsTable)');

    expect(reasonGate).toBeGreaterThan(-1);
    expect(reasonGate).toBeLessThan(tx);
    expect(custody).toBeGreaterThan(tx);
    expect(custody).toBeLessThan(update);
  });

  it('records an unassigned event with no incoming agent and never a fabricated one', () => {
    const body = methodBody('public async adminUnassignAgent(');
    expect(body).toContain('newAgentId: null');
    // No placeholder agent id is invented to stand in for "nobody".
    expect(body).not.toMatch(/newAgentId:\s*'UNASSIGNED'/);
    expect(body).not.toMatch(/previousAgentId:\s*null/);
  });

  it('the event vocabulary now contains unassigned, in every declaration', () => {
    expect(ITEM_ASSIGNMENT_EVENT_TYPES).toContain('unassigned');
    expect(schemaSql).toContain("'unassigned'");
    // sql/schema.sql is hand-written DDL, so the literal value must be there.
    expect(schemaSql).toMatch(/CHECK \(event_type IN \([^)]*'unassigned'[^)]*\)\)/);
  });

  it('the legacy "clear the holder" route through adminUpdateItem is gone', () => {
    const body = methodBody('public async adminUpdateItem(');
    expect(body).toContain('unassignment_requires_endpoint');
    expect(body).toContain('adminUnassignAgent()');
  });
});
