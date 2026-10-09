import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as Sentry from "@sentry/node";
// Administrative 2FA hardening — the one-time plaintext -> encrypted TOTP secret
// migration below reuses the SAME primitives the application uses at runtime.
import { TOTP_CIPHER_PREFIX, encryptTOTPSecret, isEncryptedTOTPSecret } from "../services/totpCrypto";

dotenv.config();

// Fall back to .env.example if real .env doesn't exist
const realEnvExists = fs.existsSync(path.resolve(process.cwd(), '.env'));
if (!realEnvExists) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env.example') });
}

// In-Memory Database State for Mock Mode
const mockDatabaseState: Record<string, any[]> = {
  categories: [],
  agents: [],
  items: [],
  claims: [],
  disputes: [],
  ledger: [],
  audit_log: [],
  phone_reputations: [],
  admin_users: [],
  // Admin 2FA single-use recovery codes (bcrypt hashes only). Present so the
  // in-memory test double can model the atomic single-use consume.
  admin_recovery_codes: [],
  payment_sessions: [],
  customers: [],
  customer_otps: [],
  customer_sessions: [],
  customer_claim_links: [],
  lost_reports: [],
  account_activation_tokens: [],
  notification_events: []
};

// Uniqueness invariants the in-memory mock enforces on a PLAIN insert.
//
// Postgres enforces these through the real indexes declared in
// ensureSchemaUpToDate(); this mock has no schema, so without an explicit list
// a duplicate insert silently succeeded and any code or test that depends on
// the constraint proved nothing.
//
// SECURITY-CRITICAL ONLY. Everything listed here causes a real defect when
// violated; that is why `customer_claim_links` appears twice — once for the
// per-claim invariant (a claim belongs to at most ONE customer account, the
// rule that stops two racing customers from both linking the same claim) and
// once for idempotency. Do not add entries merely for schema parity; fixtures
// sometimes insert deliberately similar rows.
//
// N2 additions:
//  - notification_events.idempotency_key is THE cost-control invariant. Two
//    concurrent dispatches of one logical notification must resolve to a single
//    provider call; only a database constraint can decide that race. Without
//    it in this list the "one event, one send" guarantee would be untestable.
//  - customers.email mirrors the PARTIAL unique index (NULL values are skipped
//    by the null-check below, which is exactly what `WHERE email IS NOT NULL`
//    does in Postgres) — so unlimited grandfathered NULL-email accounts remain
//    valid while two real addresses can never collide.
const MOCK_UNIQUE_INDEXES: Record<string, string[][]> = {
  customer_claim_links: [['claim_id'], ['customer_id', 'claim_id']],
  notification_events: [['idempotency_key']],
  customers: [['email']],
  // N6 — the SMS rate-limit bucket key is the table's PRIMARY KEY in Postgres.
  // It MUST be modelled here for the same reason notification_events is: without
  // it the test double would let a second row be created for the same identity,
  // the guarded slot update would keep finding a virgin slot, and every rate-limit
  // test would pass while the limit did nothing. Registering it makes the
  // insert-or-23505 path the code actually relies on reachable in tests.
  sms_rate_limit_buckets: [['bucket_key']],
};

// Evaluate logical WHERE conditions recursively
function evaluateWhere(row: any, whereClause: string, params: any[]): boolean {
  if (!whereClause) return true;

  let expr = whereClause.replace(/"/g, '').trim();

  // Strip one layer of wrapping parentheses around the whole clause, e.g.
  // Drizzle's `and(eq(a,b), eq(c,d))` compiles to `WHERE (a = $1 AND c = $2)`.
  // Without this, the leading "(" and trailing ")" stay attached to the first
  // and last split parts below, breaking their column/value regex matches and
  // causing every row to silently fail to match (a false non-match, not a
  // thrown error) — leading to updates/selects that should hit a row instead
  // matching zero rows every time.
  while (expr.startsWith('(') && expr.endsWith(')')) {
    const inner = expr.slice(1, -1).trim();
    // Only unwrap if these are genuinely matching outer parens (a naive
    // depth check), not e.g. two separate parenthesized groups joined by AND.
    let depth = 0;
    let matchesOuter = true;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '(') depth++;
      if (inner[i] === ')') depth--;
      if (depth < 0) { matchesOuter = false; break; }
    }
    if (matchesOuter && depth === 0) {
      expr = inner;
    } else {
      break;
    }
  }

  if (expr.includes(' or ') || expr.includes(' OR ')) {
    const parts = expr.split(/\s+or\s+/i).map(p => p.trim());
    return parts.some(part => evaluateWhere(row, part, params));
  }

  if (expr.includes(' and ') || expr.includes(' AND ')) {
    const parts = expr.split(/\s+and\s+/i).map(p => p.trim());
    return parts.every(part => evaluateWhere(row, part, params));
  }
  
  const cleanExpr = expr.trim();
  if (cleanExpr.toLowerCase() === 'true') return true;
  if (cleanExpr.toLowerCase() === 'false') return false;
  
  if (cleanExpr.toLowerCase().endsWith('is null')) {
    const col = cleanExpr.substring(0, cleanExpr.toLowerCase().lastIndexOf('is null')).trim().replace(/^\w+\./, '');
    return row[col] === null || row[col] === undefined;
  }
  if (cleanExpr.toLowerCase().endsWith('is not null')) {
    const col = cleanExpr.substring(0, cleanExpr.toLowerCase().lastIndexOf('is not null')).trim().replace(/^\w+\./, '');
    return row[col] !== null && row[col] !== undefined;
  }
  
  // Match IN / NOT IN: "col in ($1, $2)" or "col in ('a','b')". Drizzle's
  // inArray()/notInArray() compile to these. Before this branch existed, an IN
  // clause fell through every case above to the unconditional `return true` at
  // the end of this function — so an inArray() WHERE filtered nothing in the
  // mock and silently matched EVERY row. That is not a production defect
  // (production talks to real Postgres) but it made any test double relying on
  // inArray() prove nothing: a scoped query's "returns only these rows"
  // assertion would pass while the mock handed back the whole table. Added for
  // exactly that reason, alongside the customer-claim-link scoping tests.
  const inMatch = cleanExpr.match(/^([\w.]+)\s+(not\s+)?in\s*\((.+)\)$/i);
  if (inMatch) {
    const inCol = inMatch[1].replace(/^\w+\./, '').trim();
    const negated = Boolean(inMatch[2]);
    const values = inMatch[3].split(',').map((part) => {
      const v = part.trim();
      const paramMatch = v.match(/^\$(\d+)$/);
      if (paramMatch) return params[parseInt(paramMatch[1]) - 1];
      if (/^now\(\)$/i.test(v)) return new Date();
      return v.replace(/^'|'$/g, '').trim();
    });
    const isMember = values.some((val) => String(row[inCol]) === String(val));
    return negated ? !isMember : isMember;
  }

  // Match equals: "col = $1" or "col = 'value'"
  const eqMatch = cleanExpr.match(/^([\w.]+)\s*=\s*(.+)$/);
  if (eqMatch) {
    const col = eqMatch[1].replace(/^\w+\./, '').trim();
    const valExpr = eqMatch[2].trim();
    
    let val: any;
    const paramMatch = valExpr.match(/^\$(\d+)$/);
    if (paramMatch) {
      const idx = parseInt(paramMatch[1]) - 1;
      val = params[idx];
    } else {
      val = valExpr.replace(/^'|'$/g, '').trim();
      if (val === 'true') val = true;
      if (val === 'false') val = false;
      if (val === 'null') val = null;
    }
    
    return String(row[col]) === String(val);
  }

  // Match not equals: "col <> $1" or "col != $1"
  const neMatch = cleanExpr.match(/^([\w.]+)\s*(?:<>|!=)\s*(.+)$/);
  if (neMatch) {
    const col = neMatch[1].replace(/^\w+\./, '').trim();
    const valExpr = neMatch[2].trim();
    
    let val: any;
    const paramMatch = valExpr.match(/^\$(\d+)$/);
    if (paramMatch) {
      const idx = parseInt(paramMatch[1]) - 1;
      val = params[idx];
    } else {
      val = valExpr.replace(/^'|'$/g, '').trim();
      if (val === 'true') val = true;
      if (val === 'false') val = false;
      if (val === 'null') val = null;
    }
    
    return String(row[col]) !== String(val);
  }

  // Match ordering comparisons: "col <= $1", "col < $1", "col >= $1", "col > $1"
  // — added because there was NO handling for these at all: any WHERE
  // clause using one (e.g. drizzle's lte()/lt()/gte()/gt()) fell through
  // every branch above and hit the unconditional `return true` at the end
  // of this function, meaning every row silently matched regardless of
  // the actual comparison. That's not a production bug (production talks
  // to a real Postgres, never this mock) but it's a real defect in this
  // test double that could make any test using a range/ordering
  // comparison pass or fail for the wrong reason. Order matters: check
  // <= / >= before < / > so e.g. "<=" isn't matched by the "<" pattern
  // first and left with a dangling "=".
  const cmpMatch = cleanExpr.match(/^([\w.]+)\s*(<=|>=|<|>)\s*(.+)$/);
  if (cmpMatch) {
    const col = cmpMatch[1].replace(/^\w+\./, '').trim();
    const op = cmpMatch[2];
    const valExpr = cmpMatch[3].trim();

    let val: any;
    const paramMatch = valExpr.match(/^\$(\d+)$/);
    if (paramMatch) {
      const idx = parseInt(paramMatch[1]) - 1;
      val = params[idx];
    } else if (/^now\(\)$/i.test(valExpr)) {
      val = new Date();
    } else {
      val = valExpr.replace(/^'|'$/g, '').trim();
    }

    // Compare as dates if either side looks like one, else numerically,
    // else fall back to string comparison — mirrors how a real Postgres
    // column's type would drive the comparison, without needing this mock
    // to actually track column types.
    const rowVal = row[col];
    const asDate = (x: any): number | null => {
      if (x instanceof Date) return x.getTime();
      if (typeof x === 'string' && !isNaN(Date.parse(x)) && /\d{4}-\d{2}-\d{2}/.test(x)) return Date.parse(x);
      return null;
    };
    const rowDate = asDate(rowVal);
    const valDate = asDate(val);

    let cmp: number;
    if (rowVal === null || rowVal === undefined) {
      // NULL is never <=, <, >=, or > anything in SQL three-valued logic.
      return false;
    } else if (rowDate !== null && valDate !== null) {
      cmp = rowDate - valDate;
    } else if (!isNaN(Number(rowVal)) && !isNaN(Number(val))) {
      cmp = Number(rowVal) - Number(val);
    } else {
      cmp = String(rowVal) < String(val) ? -1 : String(rowVal) > String(val) ? 1 : 0;
    }

    if (op === '<=') return cmp <= 0;
    if (op === '>=') return cmp >= 0;
    if (op === '<') return cmp < 0;
    return cmp > 0; // '>'
  }

  return true;
}

// Helper to map object rows to array rows if Drizzle requests them
function convertToDrizzleRows(queryText: string, rows: any[]): any[] {
  // Normalize SQL: remove quotes, replace whitespace
  const cleanSql = queryText.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  
  let selectedCols: string[] = [];
  
  const returningIdx = cleanSql.toUpperCase().indexOf(' RETURNING ');
  const selectIdx = cleanSql.toUpperCase().indexOf('SELECT ');
  const fromIdx = cleanSql.toUpperCase().indexOf(' FROM ');
  
  if (returningIdx !== -1) {
    const returningPart = cleanSql.substring(returningIdx + 11).trim();
    if (returningPart && returningPart !== '*' && returningPart !== '1') {
      selectedCols = returningPart.split(',').map(c => {
        const parts = c.trim().split(/\s+as\s+/i);
        const colName = parts[0].trim();
        const dotIdx = colName.indexOf('.');
        return dotIdx !== -1 ? colName.substring(dotIdx + 1) : colName;
      });
    }
  } else if (selectIdx !== -1 && fromIdx !== -1) {
    const selectPart = cleanSql.substring(selectIdx + 7, fromIdx).trim();
    if (selectPart !== '*' && selectPart !== 'count(*)' && selectPart !== '1') {
      selectedCols = selectPart.split(',').map(c => {
        const parts = c.trim().split(/\s+as\s+/i);
        const colName = parts[0].trim();
        const dotIdx = colName.indexOf('.');
        return dotIdx !== -1 ? colName.substring(dotIdx + 1) : colName;
      });
    }
  }
  
  if (selectedCols.length > 0) {
    return rows.map(row => {
      if (Array.isArray(row)) return row; // already an array
      return selectedCols.map(col => row[col]);
    });
  }
  
  return rows;
}

// In-Memory Query Executor
function executeMockQuery(sql: any, params: any[] = []): { rows: any[] } {
  let queryText = "";
  let queryParams = params;
  if (sql && typeof sql === 'object') {
    queryText = sql.text || "";
    queryParams = sql.values || params;
  } else {
    queryText = String(sql || "");
  }

  // Normalize SQL: remove quotes, remove extra spacing
  const normalized = queryText.replace(/"/g, '').replace(/\s+/g, ' ').trim();
  
  // Strip transactions
  if (normalized === 'BEGIN' || normalized === 'COMMIT' || normalized === 'ROLLBACK') {
    return { rows: [] };
  }
  
  let cleanSql = normalized;
  const returningIdx = cleanSql.toUpperCase().indexOf(' RETURNING ');
  if (returningIdx !== -1) {
    cleanSql = cleanSql.substring(0, returningIdx).trim();
  }
  
  // 1. SELECT
  if (cleanSql.toUpperCase().startsWith('SELECT')) {
    const fromMatch = cleanSql.match(/FROM\s+(\w+)/i);
    if (!fromMatch) return { rows: [] };
    const tableName = fromMatch[1].toLowerCase();
    const tableData = mockDatabaseState[tableName] || [];
    
    const whereMatch = cleanSql.match(/WHERE\s+(.+)$/i);
    if (!whereMatch) {
      return { rows: convertToDrizzleRows(queryText, tableData) };
    }
    
    let whereClause = whereMatch[1];
    const orderByIdx = whereClause.toUpperCase().indexOf(' ORDER BY ');
    if (orderByIdx !== -1) {
      whereClause = whereClause.substring(0, orderByIdx).trim();
    }
    const limitIdx = whereClause.toUpperCase().indexOf(' LIMIT ');
    if (limitIdx !== -1) {
      whereClause = whereClause.substring(0, limitIdx).trim();
    }
    
    const filtered = tableData.filter(row => evaluateWhere(row, whereClause, queryParams));
    return { rows: convertToDrizzleRows(queryText, filtered) };
  }
  
  // 2. INSERT
  if (cleanSql.toUpperCase().startsWith('INSERT INTO')) {
    const insertMatch = cleanSql.match(/INSERT\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i);
    if (insertMatch) {
      const tableName = insertMatch[1].toLowerCase();
      const cols = insertMatch[2].split(',').map(c => c.trim());
      const valsExpr = insertMatch[3].split(',');
      
      const newRow: any = {};
      cols.forEach((col, idx) => {
        const valStr = valsExpr[idx].trim();
        const paramMatch = valStr.match(/\$(\d+)/);
        if (paramMatch) {
          const paramIdx = parseInt(paramMatch[1]) - 1;
          newRow[col] = queryParams[paramIdx];
        } else {
          if (valStr.toUpperCase() === 'DEFAULT') {
            newRow[col] = undefined;
          } else {
            newRow[col] = valStr.replace(/^'|'$/g, '');
          }
        }
      });

      if (!mockDatabaseState[tableName]) mockDatabaseState[tableName] = [];

      // ON CONFLICT (...) DO NOTHING / DO UPDATE — drizzle's
      // onConflictDoNothing()/onConflictDoUpdate() generate real
      // "ON CONFLICT (col1, col2) DO ..." SQL. Without handling this, the
      // mock silently behaved as a plain unconditional insert, meaning
      // every unique-constraint-based idempotency/race protection added
      // to this codebase (e.g. uq_claims_one_active_per_item,
      // uq_social_pub_item_platform_type) was untestable — not because the
      // real Postgres behavior was wrong, only because this test double
      // couldn't verify it. This checks the actual target columns'
      // values against existing rows, same as a real unique constraint
      // would, for DO NOTHING; DO UPDATE additionally applies the SET
      // clause to the conflicting row.
      const conflictMatch = normalized.match(/ON CONFLICT\s*\(([^)]+)\)\s*DO\s+(NOTHING|UPDATE)/i);
      if (conflictMatch) {
        const conflictCols = conflictMatch[1].split(',').map(c => c.trim().toLowerCase());
        const existing = mockDatabaseState[tableName].find(row =>
          conflictCols.every(col => String(row[col]) === String(newRow[col]))
        );
        if (existing) {
          if (conflictMatch[2].toUpperCase() === 'UPDATE') {
            const setMatch = normalized.match(/DO UPDATE SET\s+(.+?)(?:\s+RETURNING|$)/i);
            if (setMatch) {
              const setParts = setMatch[1].split(',');
              setParts.forEach(part => {
                const eqMatch = part.match(/(\w+)\s*=\s*(.+)/);
                if (eqMatch) {
                  const col = eqMatch[1].trim();
                  const valStr = eqMatch[2].trim();
                  const paramMatch = valStr.match(/\$(\d+)/);
                  if (paramMatch) {
                    const paramIdx = parseInt(paramMatch[1]) - 1;
                    existing[col] = queryParams[paramIdx];
                  }
                }
              });
            }
            return { rows: convertToDrizzleRows(queryText, [existing]) };
          }
          // DO NOTHING: a real Postgres INSERT ... ON CONFLICT DO NOTHING
          // RETURNING returns zero rows when the conflict fires.
          return { rows: [] };
        }
      }

      // Plain INSERT (no ON CONFLICT clause): enforce the SECURITY-CRITICAL
      // unique indexes that the real Postgres schema declares, so a duplicate
      // insert fails here the way it fails in production.
      //
      // Without this, the mock's plain insert always succeeded — which made
      // every database-level uniqueness invariant untestable and, worse, let a
      // "two customers race for the same claim" test pass while actually
      // inserting two link rows. The real defence is the index in Postgres;
      // this makes the test double capable of witnessing it.
      //
      // Deliberately minimal — only invariants whose violation is a SECURITY
      // defect are listed. Extend it when a new uniqueness rule becomes
      // security-critical, not merely for schema parity: over-enforcing here
      // would break fixtures that intentionally insert near-duplicate rows.
      const uniqueIndexes = MOCK_UNIQUE_INDEXES[tableName];
      if (uniqueIndexes) {
        for (const indexCols of uniqueIndexes) {
          const clash = mockDatabaseState[tableName].some((row) =>
            indexCols.every(
              (col) => row[col] !== undefined && row[col] !== null && String(row[col]) === String(newRow[col])
            )
          );
          if (clash) {
            // Shaped like the real Postgres unique-violation (SQLSTATE 23505)
            // so callers' catch-and-classify paths are exercised for real.
            const violation: any = new Error(
              `duplicate key value violates unique constraint on ${tableName} (${indexCols.join(', ')})`
            );
            violation.code = '23505';
            throw violation;
          }
        }
      }

      mockDatabaseState[tableName].push(newRow);
      return { rows: convertToDrizzleRows(queryText, [newRow]) };
    }
  }
  
  // 3. UPDATE
  if (cleanSql.toUpperCase().startsWith('UPDATE')) {
    const updateMatch = cleanSql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)(?:\s+WHERE\s+(.+))?$/i);
    if (updateMatch) {
      const tableName = updateMatch[1].toLowerCase();
      const setExpr = updateMatch[2];
      const whereExpr = updateMatch[3];
      
      const tableData = mockDatabaseState[tableName] || [];
      
      const updates: any = {};
      const setParts = setExpr.split(',');
      setParts.forEach(part => {
        const eqMatch = part.match(/(\w+)\s*=\s*(.+)/);
        if (eqMatch) {
          const col = eqMatch[1].trim();
          const valStr = eqMatch[2].trim();
          const paramMatch = valStr.match(/\$(\d+)/);
          if (paramMatch) {
            const paramIdx = parseInt(paramMatch[1]) - 1;
            updates[col] = queryParams[paramIdx];
          } else {
            updates[col] = valStr.replace(/^'|'$/g, '');
          }
        }
      });
      
      const updatedRows: any[] = [];
      tableData.forEach(row => {
        if (!whereExpr || evaluateWhere(row, whereExpr, queryParams)) {
          Object.assign(row, updates);
          updatedRows.push(row);
        }
      });
      
      return { rows: convertToDrizzleRows(queryText, updatedRows) };
    }
  }
  
  // 4. DELETE
  if (cleanSql.toUpperCase().startsWith('DELETE')) {
    const deleteMatch = cleanSql.match(/DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
    if (deleteMatch) {
      const tableName = deleteMatch[1].toLowerCase();
      const whereExpr = deleteMatch[2];
      const tableData = mockDatabaseState[tableName] || [];
      
      mockDatabaseState[tableName] = tableData.filter(row => {
        if (!whereExpr) return false;
        return !evaluateWhere(row, whereExpr, params);
      });
      
      return { rows: [] };
    }
  }
  
  return { rows: [] };
}

// In-Memory Pool mock matching pg Pool
class MockPool {
  async query(sql: any, params: any[] = []) {
    return executeMockQuery(sql, params);
  }
  async connect() {
    return {
      query: async (sql: any, params: any[] = []) => {
        return executeMockQuery(sql, params);
      },
      release: () => {}
    };
  }
  on() {}
}

export function isDatabaseConnectionError(err: any): boolean {
  if (!err) return false;
  const msg = (err?.message || String(err)).toLowerCase();
  const code = String(err?.code || '').toLowerCase();
  return (
    msg.includes("getaddrinfo") ||
    msg.includes("eai_again") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("connect timeout") ||
    msg.includes("timeout expired") ||
    msg.includes("connection terminated") ||
    msg.includes("terminating connection") ||
    msg.includes("server closed the connection") ||
    msg.includes("connection ended unexpectedly") ||
    msg.includes("socket hang up") ||
    msg.includes("epipe") ||
    code === "eai_again" ||
    code === "econnrefused" ||
    code === "econnreset" ||
    code === "epipe" ||
    code === "57p01" || // admin_shutdown — server-side idle connection termination (common on Neon/Supabase poolers)
    code === "57p02" || // crash_shutdown
    code === "57p03"    // cannot_connect_now
  );
}

// Fault-tolerant, self-healing Pool wrapper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class ResilientPool {
  private realPool: Pool | null = null;
  private useMock = false;
  private mockPool = new MockPool();

  constructor(connectionString: string, isPlaceholder: boolean) {
    if (isPlaceholder) {
      this.useMock = true;
      console.log("[ResilientPool] Created in self-healing In-Memory Sandbox Mode.");
    } else {
      try {
        this.realPool = new Pool({
          connectionString,
          ssl: { rejectUnauthorized: false },
          // 15s (not 5s): free-tier serverless Postgres (Neon, Supabase) can
          // take 5-10+ seconds to wake a suspended compute on first connect
          // after any idle period. A 5s timeout was routinely shorter than a
          // genuine cold-start, causing every request that hit a suspended DB
          // — including the categories fetch — to fail outright rather than
          // just wait a bit longer for a real, healthy database to respond.
          connectionTimeoutMillis: 15000,
          keepAlive: true,
          keepAliveInitialDelayMillis: 10000,
        });
        this.realPool.on("error", (err) => {
          console.error("Unexpected error on idle SQL pool client:", err);
          if (isDatabaseConnectionError(err)) {
            console.error("[ResilientPool] Real database idle connection lost:", err);
            try {
              Sentry.captureException(err);
            } catch (se) {
              console.error("Failed to capture idle pool error to Sentry:", se);
            }
          }
        });
      } catch (err: any) {
        console.error("[ResilientPool] Failed to instantiate pg Pool.", err);
        if (process.env.NODE_ENV === 'production') {
          // Same fail-closed guarantee as createPool() above — a malformed
          // DATABASE_URL that passes the placeholder check but still fails
          // to construct a real Pool must crash startup in production, not
          // silently degrade to the in-memory mock.
          throw new Error('FATAL: Failed to instantiate the production PostgreSQL connection pool. Refusing to fall back to the in-memory mock database in production.', { cause: err });
        }
        console.error("[ResilientPool] Falling back to Mock Mode (non-production only).");
        this.useMock = true;
      }
    }
  }

  async query(sql: any, params: any[] = []) {
    if (this.useMock) {
      return this.mockPool.query(sql, params);
    }
    try {
      return await this.realPool!.query(sql, params);
    } catch (err: any) {
      if (isDatabaseConnectionError(err)) {
        console.error("[ResilientPool] Real database query connection error (will retry with backoff):", err);
        try {
          Sentry.captureException(err);
        } catch (se) {
          console.error("Failed to capture query error to Sentry:", se);
        }
        // Two retry causes, needing two different responses:
        // (1) Serverless/pooled Postgres providers (Neon, Supabase, RDS Proxy,
        //     etc.) routinely close idle connections server-side — the first
        //     query after any idle period frequently hits a connection that's
        //     already dead from the server's side, even though the pool
        //     hasn't noticed yet. An immediate retry (fresh connection) fixes
        //     this instantly.
        // (2) A suspended free-tier compute waking from a cold start — this
        //     can take several seconds, so retrying instantly just times out
        //     again while it's still waking. A short real delay before each
        //     retry gives it the extra time an instant retry can't.
        // Together this is what was causing "categories sometimes fails to
        // load" — a 5s timeout was routinely shorter than a genuine cold
        // start, and the single instant retry didn't help a still-waking DB.
        for (const delayMs of [0, 3000]) {
          if (delayMs > 0) await sleep(delayMs);
          try {
            return await this.realPool!.query(sql, params);
          } catch (retryErr: any) {
            console.error(`[ResilientPool] Retry (after ${delayMs}ms) failed:`, retryErr?.message || retryErr);
            if (delayMs === 3000) throw retryErr;
          }
        }
      }
      throw err;
    }
  }

  async connect() {
    if (this.useMock) {
      return this.mockPool.connect();
    }
    try {
      return await this.realPool!.connect();
    } catch (err: any) {
      if (isDatabaseConnectionError(err)) {
        console.error("[ResilientPool] Real database connect connection error (will retry with backoff):", err);
        try {
          Sentry.captureException(err);
        } catch (se) {
          console.error("Failed to capture connect error to Sentry:", se);
        }
        for (const delayMs of [0, 3000]) {
          if (delayMs > 0) await sleep(delayMs);
          try {
            return await this.realPool!.connect();
          } catch (retryErr: any) {
            console.error(`[ResilientPool] Connect retry (after ${delayMs}ms) failed:`, retryErr?.message || retryErr);
            if (delayMs === 3000) throw retryErr;
          }
        }
      }
      throw err;
    }
  }

  on(event: any, callback: (...args: any[]) => void) {
    if (this.realPool) {
      this.realPool.on(event, callback);
    }
  }
}

export const createPool = (): any => {
  const dbUrl = process.env.DATABASE_URL || '';
  const isPlaceholder = !dbUrl || 
                        dbUrl.includes("user:password@host") || 
                        dbUrl.includes("dummy_user") ||
                        dbUrl.includes("postgresql://host");

  // PRODUCTION MUST NEVER SILENTLY RUN ON THE IN-MEMORY MOCK DATABASE.
  // The mock pool exists purely so local development and tests can run
  // without a real Postgres instance configured. A production deployment
  // with a missing or placeholder DATABASE_URL is a misconfiguration, not
  // a degraded-but-acceptable state — every found-item report, claim, and
  // payment record would silently go into memory and vanish on the next
  // restart while every response looked completely normal. Fail the
  // process startup loudly instead, so this gets caught in deployment, not
  // discovered later as "why did all our data disappear."
  if (isPlaceholder && process.env.NODE_ENV === 'production') {
    throw new Error(
      'FATAL: DATABASE_URL is missing or is still a placeholder value in a production environment. ' +
      'Refusing to start with the in-memory mock database in production — configure a real ' +
      'PostgreSQL DATABASE_URL before deploying.'
    );
  }

  return new ResilientPool(dbUrl, isPlaceholder);
};

export const pool = createPool();

export const db = drizzle(pool, { schema });

/**
 * ONE-TIME DATA MIGRATION: encrypt any legacy PLAINTEXT admin TOTP secret.
 *
 * The repository's migration mechanism (the `statements` array below) is a list
 * of idempotent DDL strings run on every boot. A transformation that must consult
 * an application-held encryption key cannot be expressed as a plain SQL statement
 * (Postgres has no access to TOTP_ENCRYPTION_KEY), so it is implemented here as a
 * dedicated, idempotent step that runs immediately after the DDL has been
 * applied — the closest correct fit for this repository's architecture.
 *
 * SAFETY PROPERTIES
 *   * Identifies plaintext by shape: only rows whose totp_secret is non-empty and
 *     does NOT already carry TOTP_CIPHER_PREFIX are touched. A base32 secret
 *     (A-Z, 2-7) can never begin with the prefix (which contains ':'), so the
 *     predicate is exact and idempotent — after one successful run no rows match,
 *     and every subsequent boot is a no-op.
 *   * Preserves the enrolled secret EXACTLY (decrypt(cipher) round-trips to the
 *     identical base32 string) and never changes totp_enabled.
 *   * Never logs the secret; only a per-row admin id on failure, and a count.
 *   * A failure on one row does not abort the others or the boot: the migration
 *     is retried on the next boot, and the runtime read path tolerates a
 *     not-yet-migrated plaintext value so no administrator is locked out.
 */
export async function encryptExistingTotpSecrets(pool: Pool): Promise<number> {
  let rows: Array<{ id?: string; totp_secret?: string }> = [];
  try {
    const result = await pool.query(
      `SELECT id, totp_secret FROM admin_users
       WHERE totp_secret IS NOT NULL AND totp_secret <> ''
         AND totp_secret NOT LIKE '${TOTP_CIPHER_PREFIX}%'`
    );
    rows = (result && (result as any).rows) || [];
  } catch (err: any) {
    console.warn('[TOTP MIGRATION] Could not scan admin_users for plaintext TOTP secrets:', err?.message || err);
    return 0;
  }

  let migrated = 0;
  for (const row of rows) {
    const id = row?.id;
    const secret = row?.totp_secret;
    if (!id || typeof secret !== 'string' || secret === '' || isEncryptedTOTPSecret(secret)) continue;
    try {
      const encrypted = encryptTOTPSecret(secret);
      await pool.query('UPDATE admin_users SET totp_secret = $1 WHERE id = $2', [encrypted, id]);
      migrated++;
    } catch (err: any) {
      // Log the admin id and the error message ONLY — never the secret itself.
      console.error(`[TOTP MIGRATION] Failed to encrypt the TOTP secret for admin id ${id}: ${err?.message || err}`);
    }
  }
  if (migrated > 0) {
    console.log(`[TOTP MIGRATION] Encrypted ${migrated} previously-plaintext admin TOTP secret(s) at rest.`);
  }
  return migrated;
}

/**
 * SCHEMA SYNC RULE FOR FUTURE UPDATES:
 * Every time a new column or table is added to schema.ts, the corresponding
 * "ADD COLUMN IF NOT EXISTS" or "CREATE TABLE IF NOT EXISTS" statement
 * must be added to this statements array in the same pull request/change.
 * This array is the single source of truth for schema-sync alongside schema.ts.
 */
export async function ensureSchemaUpToDate(pool: Pool) {
  const dbUrl = process.env.DATABASE_URL || '';
  const isPlaceholder = !dbUrl || 
                        dbUrl.includes("user:password@host") || 
                        dbUrl.includes("dummy_user") ||
                        dbUrl.includes("postgresql://host");
  if (isPlaceholder) {
    console.warn("[SCHEMA SYNC] Placeholder or missing DATABASE_URL. Skipping schema sync.");
    return;
  }

  try {
    const client = await pool.connect();
    client.release();
  } catch (err: any) {
    console.warn(`[SCHEMA SYNC] Database connection test failed. Skipping schema sync. Error: ${err.message || err}`);
    return;
  }

  // --- STARTUP SCHEMA BOOTSTRAP CHECK ---
  try {
    const tableCheck = await pool.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'categories')"
    );
    const categoriesExist = tableCheck.rows[0]?.exists === true;

    if (!categoriesExist) {
      console.log('================================================================');
      console.log("[SCHEMA BOOTSTRAP] No existing schema detected — creating base schema from sql/schema.sql...");
      console.log('================================================================');
      
      const schemaPath = path.resolve(process.cwd(), 'sql', 'schema.sql');
      if (!fs.existsSync(schemaPath)) {
        throw new Error(`Base schema file not found at path: ${schemaPath}`);
      }
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      
      // Execute the complete file as one script, in order
      await pool.query(schemaSql);
      
      console.log('================================================================');
      console.log("[SCHEMA BOOTSTRAP SUCCESS] Base database schema created successfully!");
      console.log('================================================================');
    }
  } catch (bootstrapErr: any) {
    console.error('================================================================');
    console.error('            RETURN4ME SCHEMA BOOTSTRAP FATAL ERROR              ');
    console.error('================================================================');
    console.error('Failed to bootstrap database base schema from sql/schema.sql.');
    console.error('The application cannot start up in this state because the database base tables are missing.');
    console.error(`Error details: ${bootstrapErr.message || bootstrapErr}`);
    console.error('================================================================');
    process.exit(1);
  }

  const statements = [
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_sensitive_document BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_admin_modified BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS location_address TEXT`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS county VARCHAR(50)`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS administrative_unit_id VARCHAR(50)`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS location_accuracy NUMERIC(10, 2)`,
    // GEO-D+ — additive location provenance. Nullable, NO default, NO
    // backfill: legacy rows keep NULL. `location_source` names the SERVICE
    // geography's origin; `coordinate_source` names the operational hub
    // coordinate's origin. Two INDEPENDENT axes — see the vocabulary + guards
    // in services/locationProvenance.ts.
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS location_source VARCHAR(30)`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS coordinate_source VARCHAR(30)`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS payout_method_type VARCHAR(50) NOT NULL DEFAULT 'Till Number'`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS needs_manual_geocoding BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)`,
    // ---------------------------------------------------------------------
    // N4 — AGENT EMAIL ACTIVATION. Additive, non-destructive, and it rewrites
    // NO existing row: it adds one nullable column and one partial unique
    // index, both of which leave every pre-N4 agent exactly as it was.
    // ---------------------------------------------------------------------
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`,
    // Partial, for the same reason uq_customers_email is: any number of
    // grandfathered NULL-email agents must coexist, while two non-null agent
    // emails can never collide. Without this, a duplicate address could be used
    // to confuse one agent's activation record with another's.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_agents_email ON agents(contact_email) WHERE contact_email IS NOT NULL`,
    // ---------------------------------------------------------------------
    // N6 — DURABLE SMS RATE LIMIT. Additive and non-destructive.
    //
    // Three timestamp slots rather than a counter, so the window is genuinely
    // ROLLING (a slot frees the instant its own timestamp ages out) instead of
    // tumbling on a clock boundary. Admission is decided by a single guarded
    // UPDATE ... RETURNING, so the database resolves concurrency rather than
    // the application. See the table comment in db/schema.ts.
    // ---------------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS sms_rate_limit_buckets (
      bucket_key VARCHAR(64) PRIMARY KEY,
      slot_1_at TIMESTAMPTZ,
      slot_2_at TIMESTAMPTZ,
      slot_3_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS shop_photo_url TEXT`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS id_document_photo_url TEXT`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS warning_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_warning_reason TEXT`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_warning_at TIMESTAMPTZ`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS flagged_for_review BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS is_description_only BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS description TEXT`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS is_sensitive_document BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS locked_total_fee NUMERIC(10,2)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS locked_finder_share NUMERIC(10,2)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS locked_agent_share NUMERIC(10,2)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS locked_platform_share NUMERIC(10,2)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS agent_assignment_method VARCHAR(30)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS agent_assignment_distance_km NUMERIC(8,2)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS needs_manual_agent_reassignment BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS finder_email VARCHAR(255)`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS owner_id_proof_url TEXT`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS owner_identifying_details TEXT`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS owner_email VARCHAR(255)`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS agent_confirmed_at TIMESTAMPTZ`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS handover_photo_url VARCHAR(500)`,
    // Recovery Fee Engine config (categories) — see src/services/feeEngine.ts.
    // These were added to schema.ts/sql/schema.sql but were missing from
    // this incremental migration path, meaning any database that was
    // bootstrapped BEFORE the fee engine existed would never have received
    // them — the engine would silently read undefined/NaN for every
    // category on such a database. Fixed here.
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS base_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS complexity_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS delay_fee NUMERIC(10,2) NOT NULL DEFAULT 0.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS ceiling_percent NUMERIC(5,2) NOT NULL DEFAULT 12.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS finder_pct NUMERIC(5,2) NOT NULL DEFAULT 25.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS agent_pct NUMERIC(5,2) NOT NULL DEFAULT 35.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS platform_pct NUMERIC(5,2) NOT NULL DEFAULT 40.00`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS finder_reward_cap NUMERIC(10,2)`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS elevated_review BOOLEAN NOT NULL DEFAULT false`,
    // Recovery Fee Engine inputs on items (declared value + whether the
    // ceiling actually bound) — same gap as above.
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS declared_value NUMERIC(12,2)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS fee_ceiling_applied BOOLEAN NOT NULL DEFAULT false`,
    // Settlement dispute-window timestamp on claims — same gap.
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS settle_at TIMESTAMPTZ`,
    // D-2B-B - settlement review/approval + durable manual payout initiation.
    // Additive and idempotent. NULL settlement_approved_at means no human
    // approval recorded for this claim. Nothing else in the migration or the
    // application treats a NULL as "never approved": every read path checks
    // for NULL explicitly, and every write is CAS-guarded, so a legacy row
    // (or a row in a database bootstrapped from schema.sql on an older host)
    // is never misread as approved.
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_approved_at TIMESTAMPTZ`,
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_approved_by VARCHAR(100)`,
    // Platform-wide admin toggles (currently just the social publishing
    // emergency stop) — same gap, this table didn't exist in the
    // incremental path at all.
    `CREATE TABLE IF NOT EXISTS platform_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_by VARCHAR(100),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Dispute evidence — lets either claimant attach their own photo/text
    // evidence to a dispute for the admin to review during resolution,
    // instead of the admin working from claim data + notes alone.
    `CREATE TABLE IF NOT EXISTS dispute_evidence (
      id VARCHAR(40) PRIMARY KEY,
      dispute_id VARCHAR(40) NOT NULL REFERENCES disputes(id),
      claim_id VARCHAR(50) NOT NULL REFERENCES claims(id),
      submitted_by_phone VARCHAR(20) NOT NULL,
      evidence_text TEXT,
      evidence_photo_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS phone_reputations (
      phone_number VARCHAR(15) PRIMARY KEY,
      is_cleared BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    // BUGFIX (migration order): this CREATE TABLE must run BEFORE any
    // ALTER TABLE admin_users statement. It previously ran AFTER the TOTP
    // column additions below, meaning a database that didn't already have
    // admin_users (a genuinely fresh database not bootstrapped via
    // sql/schema.sql, or an old database that predates this table) would
    // fail both ALTER statements with "relation admin_users does not
    // exist" before ever reaching the statement that actually creates it.
    `CREATE TABLE IF NOT EXISTS admin_users (
      id VARCHAR(40) PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    )`,
    // Admin 2FA (TOTP) — additive columns only, both default to "not
    // enrolled" so no existing admin account is affected until they
    // opt in via the new enrollment flow. Now correctly ordered after
    // the admin_users table is guaranteed to exist.
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255)`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false`,
    // Administrative 2FA hardening — staged enrollment secret + recovery codes.
    // totp_pending_secret keeps a freshly generated secret SEPARATE from the
    // active totp_secret, so an already-enabled account is never downgraded or
    // has its live authenticator replaced merely because /setup was called.
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_pending_secret VARCHAR(255)`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_pending_created_at TIMESTAMPTZ`,
    // Single-use 2FA recovery codes (bcrypt hashes only). Additive table; the
    // matching definition lives in schema.ts and sql/schema.sql.
    `CREATE TABLE IF NOT EXISTS admin_recovery_codes (
      id VARCHAR(40) PRIMARY KEY,
      admin_id VARCHAR(40) NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      code_hash VARCHAR(255) NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_admin ON admin_recovery_codes(admin_id)`,
    `CREATE TABLE IF NOT EXISTS claim_payment_strikes (
      phone_number VARCHAR(15) PRIMARY KEY,
      strike_count INTEGER NOT NULL DEFAULT 0,
      last_strike_at TIMESTAMPTZ,
      is_cleared_by_admin BOOLEAN NOT NULL DEFAULT false
    )`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
      phone_number VARCHAR(20) PRIMARY KEY,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS claim_otps (
      claim_id VARCHAR(50) PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE TABLE IF NOT EXISTS claim_pickup_codes (
      claim_id VARCHAR(50) PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
      code_hash VARCHAR(64) NOT NULL,
      verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Migration note: the original claims.status CHECK constraint only allowed
    // ('pending_verification', 'pending_payment', 'escrow_held', 'released', 'disputed')
    // but the application actively sets 'awaiting_agent_confirmation' (after OTP
    // verification, before the agent physically confirms the item), 'payment_window_expired'
    // (when the payment window times out), and 'rejected' (auto-applied to losing
    // claimants when another claimant pays first on a non-sensitive multi-claim item)
    // — all three were being silently rejected by Postgres, breaking the entire
    // physical-verification-before-payment flow and the multi-claim resolution logic.
    // This drops and recreates the constraint with the full, correct set of statuses.
    // 'refunding'/'refunded' added: a losing dispute claimant who had already paid
    // into escrow needs a real M-Pesa refund via IntaSend (see resolveDispute /
    // finalizeClaimRefund / revertClaimRefundLock in database.ts) — without these two
    // statuses that locked, auditable refund flow can't be represented in the DB at all.
    // 'pending_settlement' added: this was the actual P0 bug — schema.ts and
    // sql/schema.sql both correctly include it (the settlement dispute-window
    // state between handover confirmation and real payout — see
    // enterPendingSettlement in database.ts), but this incremental migration
    // statement recreated the constraint WITHOUT it, meaning any database that
    // had already been bootstrapped before the settlement rework would reject
    // every transition into pending_settlement with a CHECK violation the
    // moment an agent confirmed a handover. Fixed.
    // Safe to run on every boot.
    `ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_check`,
    `ALTER TABLE claims ADD CONSTRAINT claims_status_check CHECK (status IN ('pending_verification', 'awaiting_agent_confirmation', 'pending_payment', 'payment_window_expired', 'escrow_held', 'pending_settlement', 'releasing', 'released', 'disputed', 'rejected', 'refunding', 'refunded'))`,
    // Same class of bug as claims_status_check above, for items: the
    // suspected_stolen/legal_hold statuses were added to schema.ts and
    // sql/schema.sql but this incremental path never updated the
    // already-bootstrapped-database constraint to match, so an existing
    // production database would reject the entire stolen-property state
    // machine. Postgres auto-names an unnamed inline CHECK on a column
    // "<table>_<column>_check", so this matches the constraint sql/schema.sql
    // implicitly created.
    `ALTER TABLE items DROP CONSTRAINT IF EXISTS items_status_check`,
    `ALTER TABLE items ADD CONSTRAINT items_status_check CHECK (status IN ('awaiting_dropoff', 'at_agent', 'claimed', 'expired', 'rejected', 'suspected_stolen', 'legal_hold'))`,
    // Belt-and-braces against the claim-creation race (see the matching
    // comment in schema.ts) — at most one non-terminal claim per item at
    // the database level. Also missing from this incremental path entirely.
    //
    // SC-7: the excluded set below MUST equal CLAIM_SLOT_EXCLUDED_STATUSES in
    // src/config/claimStatuses.ts (and the literals in src/db/schema.ts and
    // sql/schema.sql). `disputed`/`refunding` must stay excluded or filing a
    // dispute would violate this index. A test pins all four declarations.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_claims_one_active_per_item ON claims(item_id) WHERE status NOT IN ('disputed', 'rejected', 'refunding', 'refunded', 'payment_window_expired')`,
    // AUTHORITATIVE PAYMENT TRUTH (SC-4/SC-6) — see the matching comment in
    // schema.ts. Nullable, additive, no default and no backfill here: existing
    // claims keep paid_at = NULL (i.e. "not authoritatively confirmed"), which
    // is the only safe default for an obligation to refund. Ambiguous legacy
    // rows (e.g. status='disputed' after createDispute overwrote their real
    // prior state) must NOT be assumed paid. New confirmations set it via
    // attemptClaimEscrowHold()'s guarded CAS.
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE`,
    // CONSERVATIVE BACKFILL (idempotent, runs at most once per row).
    // Claims that already exist predate paid_at, so without this they would all
    // read as "unpaid" — and a historically-paid dispute loser would be
    // rejected instead of refunded, stranding their money.
    //
    // This is provably safe rather than a guess: every status below is
    // reachable ONLY through attemptClaimEscrowHold()'s guarded CAS from
    // 'pending_payment' (escrow_held -> pending_settlement -> releasing ->
    // released, and escrow_held -> disputed -> refunding -> refunded), so a row
    // in one of them has definitely had a confirmed payment. `updated_at` is
    // used as the best available timestamp — it is an approximation of WHEN,
    // never of WHETHER.
    //
    // DELIBERATELY EXCLUDED: rows still sitting in 'disputed' whose real prior
    // state was destroyed by the old createDispute() overwrite. Whether such a
    // claimant had paid is genuinely unknown from the data (that is exactly the
    // SC-3 information loss), and silently assuming "paid" would fabricate a
    // refund obligation. openpaying legacy disputes therefore need an
    // operational decision, reported rather than guessed.
    `UPDATE claims SET paid_at = updated_at WHERE paid_at IS NULL AND status IN ('escrow_held', 'pending_settlement', 'releasing', 'released', 'refunding', 'refunded')`,
    // DISPUTE SNAPSHOT (SC-3) — each participant's status/paid state captured
    // immediately before the dispute was filed. See schema.ts.
    `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS claimant_1_status_at_dispute VARCHAR(30)`,
    `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS claimant_2_status_at_dispute VARCHAR(30)`,
    `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS claimant_1_paid_at_dispute TIMESTAMP WITH TIME ZONE`,
    `ALTER TABLE disputes ADD COLUMN IF NOT EXISTS claimant_2_paid_at_dispute TIMESTAMP WITH TIME ZONE`,
    // Per-transaction payout reconciliation on the ledger — see the
    // matching comment in schema.ts. Added alongside the schema/SQL
    // changes in the same pass this time, rather than as a follow-up fix.
    `ALTER TABLE ledger ADD COLUMN IF NOT EXISTS provider_batch_id VARCHAR(100)`,
    `ALTER TABLE ledger ADD COLUMN IF NOT EXISTS provider_transaction_id VARCHAR(100)`,
    `ALTER TABLE ledger ADD COLUMN IF NOT EXISTS failure_reason TEXT`,
    // PAYOUT SUBMISSION OUTCOME (E3A) — see the matching comment in schema.ts
    // and src/config/payoutOutcomes.ts. Additive, nullable, NO backfill: every
    // existing row keeps payout_outcome = NULL, which the settlement executor
    // reads as "submission history unknown" and therefore never re-sends. That
    // is the fail-closed default; guessing "not_submitted" here would re-issue
    // transfers that may already have been executed.
    `ALTER TABLE ledger ADD COLUMN IF NOT EXISTS payout_outcome VARCHAR(20)`,
    // The vocabulary constraint, re-asserted with the repository's established
    // DROP-IF-EXISTS-then-ADD pairing (Postgres has no ADD CONSTRAINT IF NOT
    // EXISTS, so a bare ADD aborts on a database that already has it — the
    // exact class of startup failure schemaSyncIdempotency.test.ts pins).
    // sql/schema.sql declares the identical predicate as an unnamed inline
    // column CHECK, which Postgres names ledger_payout_outcome_check.
    `ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_payout_outcome_check`,
    `ALTER TABLE ledger ADD CONSTRAINT ledger_payout_outcome_check CHECK (payout_outcome IS NULL OR payout_outcome IN ('not_submitted', 'submitting', 'accepted', 'unknown', 'rejected', 'completed'))`,
    // At most one unresolved dispute per item — see matching comment in schema.ts.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_disputes_one_unresolved_per_item ON disputes(item_id) WHERE resolved_at IS NULL`,
    // Durable, idempotent social publication tracking — see matching
    // comment in schema.ts. Added alongside the schema/SQL changes in the
    // same pass, not as a follow-up fix.
    `CREATE TABLE IF NOT EXISTS social_publications (
      id VARCHAR(50) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      platform VARCHAR(20) NOT NULL,
      publication_type VARCHAR(30) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      provider_post_id VARCHAR(200),
      last_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      next_attempt_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      completed_at TIMESTAMPTZ
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_social_pub_item_platform_type ON social_publications(item_id, platform, publication_type)`,
    // Agent-verification fields on items, plus the field-level correction
    // audit trail table — see matching comments in schema.ts.
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS verified_category_id VARCHAR(50) REFERENCES categories(id)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS verified_name VARCHAR(150)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS verified_document_number VARCHAR(100)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS verified_description TEXT`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS verified_found_area VARCHAR(200)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS verification_status VARCHAR(30) NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS physically_verified_at TIMESTAMPTZ`,
    // Same class of bug fixed twice already this project (admin_users
    // TOTP columns, ledger provider columns): CREATE TABLE for a brand
    // new table must come before any statement that references it. This
    // table doesn't exist in an already-bootstrapped older database, so
    // it's created here, in the incremental path, not just in
    // sql/schema.sql's fresh-bootstrap path.
    `CREATE TABLE IF NOT EXISTS item_verification_changes (
      id VARCHAR(50) PRIMARY KEY,
      item_id VARCHAR(50) NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      agent_id VARCHAR(50) NOT NULL REFERENCES agents(id),
      field_name VARCHAR(50) NOT NULL,
      original_value TEXT,
      verified_value TEXT,
      reason VARCHAR(100) NOT NULL,
      reason_detail TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_item_verification_changes_item ON item_verification_changes(item_id)`,
    `ALTER TABLE items DROP CONSTRAINT IF EXISTS items_verification_status_check`,
    `ALTER TABLE items ADD CONSTRAINT items_verification_status_check CHECK (verification_status IN ('pending', 'confirmed_as_reported', 'corrected', 'rejected'))`,
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS public_clue_style VARCHAR(30) NOT NULL DEFAULT 'generic'`,
    // PHASE 16.1 BATCH 1 (CAT-03) — canonical category display order. Must be in
    // THIS incremental path (not just schema.ts / sql/schema.sql) so an
    // already-running database picks it up. Added NOT NULL DEFAULT 0 so every
    // existing row immediately has a valid value rather than a NULL window;
    // syncDefaultCategories() then writes each seeded category's real position
    // from the canonical seed's array order.
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`,
    // PHASE 16.1 BATCH 2 (CAT-04) — category lifecycle state. Added NOT NULL
    // DEFAULT true so every existing category stays active through the upgrade
    // (purely additive: nothing that was visible becomes hidden). Must be in
    // THIS incremental path (not just schema.ts / sql/schema.sql) so an
    // already-running database picks it up.
    `ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`,
    // Short-lived, single-use claim-payment authorization — see matching
    // comment on claim_payment_auth in schema.ts. Same class of gap as the
    // other tables above: must exist in this incremental path, not just
    // sql/schema.sql, for an already-running database to pick it up.
    `CREATE TABLE IF NOT EXISTS claim_payment_auth (
      claim_id VARCHAR(50) PRIMARY KEY REFERENCES claims(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    // Matches idx_items_status in schema.ts — the public search route now
    // runs `WHERE status = 'at_agent'` on every request (see
    // getItemsByStatus in database.ts), and without an index this is a
    // full table scan on exactly the column the highest-traffic query in
    // the app filters on. Must exist here, not just schema.ts, for an
    // already-running database to pick it up.
    `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status)`,
    // Dedup guard for POST /api/claims/:id/rate — see the matching comment
    // on the Claim interface's agent_rated_at field in database.ts.
    `ALTER TABLE claims ADD COLUMN IF NOT EXISTS agent_rated_at TIMESTAMPTZ`,
    // Matches idx_items_finder_phone in schema.ts — see the comment on
    // getItemsByFinderPhone in database.ts.
    `CREATE INDEX IF NOT EXISTS idx_items_finder_phone ON items(finder_phone)`,
    // PHASE 9D: the finder's explicit canonical county for a found item.
    // Must exist in THIS incremental path (not just sql/schema.sql) so an
    // already-running database picks it up. Deliberately NO data backfill and
    // NO DEFAULT: existing rows keep found_county = NULL, which the matcher
    // reads as "county unknown" — see the column comment in schema.ts.
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS found_county VARCHAR(50)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS administrative_unit_id VARCHAR(50)`,
    // GEO-D+ — how the found county/sub-county was established. Additive,
    // nullable, NO default, NO backfill. There is deliberately NO coordinate
    // axis on items: items.latitude/longitude are a device/routing hint, not
    // the found-item location.
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS location_source VARCHAR(30)`,
    // Session-revocation mechanism for admin accounts — see the matching
    // comment on admin_users.token_version in schema.ts. Must exist here,
    // not just schema.ts, for an already-running database to pick it up.
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 1`,
    // Payment-session table — see the matching comment on payment_sessions
    // in schema.ts. Enforced DDL version of the Drizzle definition; must be
    // present in this incremental path (not just sql/schema.sql) so an
    // already-running database picks it up.
    `CREATE TABLE IF NOT EXISTS payment_sessions (
      id VARCHAR(64) PRIMARY KEY,
      claim_id VARCHAR(50) REFERENCES claims(id) ON DELETE CASCADE,
      amount NUMERIC(10,2) NOT NULL,
      currency VARCHAR(3) NOT NULL DEFAULT 'KES',
      payer_phone VARCHAR(20),
      method VARCHAR(20) NOT NULL DEFAULT 'mpesa_stk',
      status VARCHAR(30) NOT NULL DEFAULT 'created',
      provider_invoice_id VARCHAR(100),
      provider_reference VARCHAR(100),
      failure_reason TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      confirmed_at TIMESTAMPTZ
    )`,
    `ALTER TABLE payment_sessions DROP CONSTRAINT IF EXISTS payment_sessions_status_check`,
    `ALTER TABLE payment_sessions ADD CONSTRAINT payment_sessions_status_check CHECK (status IN ('created', 'payment_initiated', 'pending', 'confirmed', 'failed', 'cancelled', 'expired'))`,
    `CREATE INDEX IF NOT EXISTS idx_payment_sessions_claim ON payment_sessions(claim_id)`,
    // Database-level uniqueness guarantee for provider invoice references —
    // the recommended hardening from the payment pre-commit security audit.
    // Partial: several sessions may legitimately have provider_invoice_id =
    // NULL (the invoice only exists after IntaSend accepts the STK push), but
    // two sessions must never share the same non-null invoice reference. This
    // is an ADDITIONAL defense on top of the application-level CAS
    // (reservePaymentSession / attemptPaymentSessionConfirm /
    // attemptClaimEscrowHold), which remains in database.ts. Must be in this
    // incremental path, not just schema.ts, for an already-running database
    // to pick it up.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_sessions_provider_invoice ON payment_sessions(provider_invoice_id) WHERE provider_invoice_id IS NOT NULL`,
    // Customer account foundation — customers, customer_otps, customer_sessions.
    // Mirrors the Drizzle definitions in schema.ts; idempotent DDL so an
    // already-running database picks them up.
    `CREATE TABLE IF NOT EXISTS customers (
      id VARCHAR(50) PRIMARY KEY,
      full_name TEXT NOT NULL,
      phone VARCHAR(20) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_phone ON customers(phone)`,
    `CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status)`,
    `CREATE TABLE IF NOT EXISTS customer_otps (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) REFERENCES customers(id) ON DELETE CASCADE,
      phone VARCHAR(20) NOT NULL,
      purpose VARCHAR(20) NOT NULL,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      used_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_otps_phone_purpose ON customer_otps(phone, purpose)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_otps_expires ON customer_otps(expires_at)`,
    `CREATE TABLE IF NOT EXISTS customer_sessions (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_seen_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_sessions_token ON customer_sessions(token_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_sessions_customer ON customer_sessions(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_sessions_expires ON customer_sessions(expires_at)`,
    // Customer ↔ claim links (explicit, per-claim). Mirrors the Drizzle
    // definition in schema.ts. The two UNIQUE indexes are load-bearing, not
    // cosmetic: uq_customer_claim_links_claim is what actually enforces
    // "a claim belongs to at most one customer" under concurrent link
    // requests — application-level checks alone cannot.
    `CREATE TABLE IF NOT EXISTS customer_claim_links (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      claim_id VARCHAR(50) NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
      linked_at TIMESTAMPTZ DEFAULT now(),
      linked_via VARCHAR(40) NOT NULL DEFAULT 'claim_otp'
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_claim_links_pair ON customer_claim_links(customer_id, claim_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_claim_links_claim ON customer_claim_links(claim_id)`,
    // ---------------------------------------------------------------------
    // N2 — NOTIFICATION ARCHITECTURE FOUNDATION.
    //
    // Additive and NON-DESTRUCTIVE. Nothing below rewrites an existing row,
    // changes customers.status, touches payment/claim/agent state, or removes
    // any authentication data. Existing customers simply keep email = NULL
    // and email_verified_at = NULL and remain exactly as active as they were.
    //
    // ORDERING: `CREATE TABLE customers` above already precedes the ALTERs
    // below, which is what migrationOrder.test.ts enforces. Never move an
    // ALTER above its CREATE for the same table.
    // ---------------------------------------------------------------------
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS email VARCHAR(255)`,
    `ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ`,
    // Partial so any number of grandfathered NULL-email accounts coexist,
    // while two non-null emails can never collide.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_email ON customers(email) WHERE email IS NOT NULL`,
    // Activation tokens — ONE shared table for customer + agent accounts.
    // The `account_type` discriminator is what keeps ownership unambiguous
    // (a polymorphic account_id cannot be a real foreign key). Only a SHA-256
    // hash is stored; the plaintext exists solely in the activation email.
    // The two CHECK constraints stop a token being filed under an undefined
    // account type or purpose and later redeemed as something it was never
    // issued for.
    `CREATE TABLE IF NOT EXISTS account_activation_tokens (
      id VARCHAR(50) PRIMARY KEY,
      account_type VARCHAR(20) NOT NULL,
      account_id VARCHAR(50) NOT NULL,
      purpose VARCHAR(32) NOT NULL,
      token_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now(),
      CONSTRAINT account_activation_tokens_purpose_check CHECK (purpose = 'email_activation'),
      CONSTRAINT account_activation_tokens_account_type_check CHECK (account_type IN ('customer', 'agent'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_account_activation_tokens_hash ON account_activation_tokens(token_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_account_activation_tokens_account ON account_activation_tokens(account_type, account_id, purpose)`,
    `CREATE INDEX IF NOT EXISTS idx_account_activation_tokens_expires ON account_activation_tokens(expires_at)`,
    // Notification events — one row per LOGICAL notification, retries reuse the
    // row. uq_notification_events_idempotency is the load-bearing constraint:
    // it is what makes two concurrent requests for the same event resolve to a
    // single provider invocation, which an application-level check cannot do.
    // NEVER holds an OTP, pickup code, activation token or payment secret.
    `CREATE TABLE IF NOT EXISTS notification_events (
      id VARCHAR(50) PRIMARY KEY,
      event_type VARCHAR(64) NOT NULL,
      channel VARCHAR(20) NOT NULL,
      provider VARCHAR(40),
      idempotency_key VARCHAR(255) NOT NULL,
      recipient_reference VARCHAR(255) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      provider_message_id VARCHAR(128),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      fallback_of VARCHAR(50) REFERENCES notification_events(id),
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now(),
      sent_at TIMESTAMPTZ,
      CONSTRAINT notification_events_channel_check CHECK (channel IN ('sms', 'email')),
      CONSTRAINT notification_events_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'fallback_available', 'fallback_requested', 'fallback_sent', 'cancelled'))
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_events_idempotency ON notification_events(idempotency_key)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_events_type ON notification_events(event_type)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_events_recipient ON notification_events(recipient_reference)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_events_status ON notification_events(status)`,
    `CREATE INDEX IF NOT EXISTS idx_notification_events_created ON notification_events(created_at)`,
    // N9 failure recovery. Additive, nullable and backfill-free: an
    // already-running database picks these up without a rewrite, and because
    // next_attempt_at stays NULL for every pre-existing row, the retry sweep can
    // never select one. No historical notification is resent by this migration,
    // and attempt_count keeps its historical meaning (successful acceptances).
    `ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS business_reference VARCHAR(64)`,
    `ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS retry_class VARCHAR(32)`,
    `ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS retry_attempt_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMP WITH TIME ZONE`,
    `CREATE INDEX IF NOT EXISTS idx_notification_events_retry ON notification_events(status, next_attempt_at)`,
    // The status CHECK predates N9 and does not permit the recovery states, so it
    // is replaced. DROP IF EXISTS makes this idempotent and safe on every boot.
    // 'failed' is deliberately retained so pre-N9 rows stay valid and terminal —
    // N9 never treats a historical failure as retryable.
    `ALTER TABLE notification_events DROP CONSTRAINT IF EXISTS notification_events_status_check`,
    `ALTER TABLE notification_events ADD CONSTRAINT notification_events_status_check CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'retryable_failure', 'permanent_failure', 'unknown', 'cancelled', 'fallback_available', 'fallback_requested', 'fallback_sent'))`,
    // ---------------------------------------------------------------------
    // LOST-ITEM REPORTS (Phase 9A) — see the matching comment in schema.ts.
    // CREATE TABLE is placed here (in the incremental path, not just
    // sql/schema.sql) so an ALREADY-running database picks the table up, and
    // AFTER the customers table above because it references it (the same
    // ordering class of bug migrationOrder.test.ts exists to catch).
    // ---------------------------------------------------------------------
    `CREATE TABLE IF NOT EXISTS lost_reports (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      category_id VARCHAR(50) NOT NULL REFERENCES categories(id),
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      county VARCHAR(50) NOT NULL,
      location_area VARCHAR(120) NOT NULL,
      location_landmark VARCHAR(160),
      lost_at_from TIMESTAMPTZ NOT NULL,
      lost_at_to TIMESTAMPTZ,
      brand VARCHAR(100),
      model VARCHAR(100),
      colour VARCHAR(60),
      material VARCHAR(60),
      description TEXT,
      distinctive_marks TEXT,
      document_type VARCHAR(50),
      document_number_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
    // Closed, disjoint status vocabulary — see config/lostReportStatuses.ts.
    // DROP-then-ADD (not a bare CREATE TABLE constraint) so the constraint is
    // (re-)asserted on a table that already existed from an earlier version,
    // exactly like payment_sessions_status_check above.
    `ALTER TABLE lost_reports DROP CONSTRAINT IF EXISTS lost_reports_status_check`,
    `ALTER TABLE lost_reports ADD CONSTRAINT lost_reports_status_check CHECK (status IN ('active', 'match_review', 'resolved', 'cancelled', 'lapsed'))`,
    `CREATE INDEX IF NOT EXISTS idx_lost_reports_customer ON lost_reports(customer_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lost_reports_category ON lost_reports(category_id)`,
    `CREATE INDEX IF NOT EXISTS idx_lost_reports_status ON lost_reports(status)`,
    `CREATE INDEX IF NOT EXISTS idx_lost_reports_document_hash ON lost_reports(document_number_hash)`,
    `CREATE INDEX IF NOT EXISTS idx_lost_reports_county ON lost_reports(county)`,
    `ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS administrative_unit_id VARCHAR(50)`,
    // GEO-D+ — how the required county/sub-county was established. Additive,
    // nullable, NO default, NO backfill: legacy reports keep NULL.
    `ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS location_source VARCHAR(30)`,

    // ======================================================================
    // BATCH 0 — FOUNDATIONAL SCHEMA PRIMITIVES
    //
    // Every statement below is ADDITIVE and idempotent (IF NOT EXISTS), so an
    // already-running database upgrades in place and no historical row is
    // rewritten, deleted or reinterpreted. Nothing here is read by business
    // logic yet: these are data foundations for later batches.
    // ======================================================================

    // --- A1: individual payment-strike records ---------------------------
    // The aggregate claim_payment_strikes table stays EXACTLY as it is and
    // stays the source of truth for the existing >=3 gate, so no behaviour
    // moves in this batch. This normalized table exists so that per-strike
    // 5-day expiry becomes expressible WITHOUT decrementing strike_count,
    // which would destroy the audit history A1 requires us to keep.
    //
    // NO BACKFILL, deliberately. For a legacy row with strike_count = 3 and
    // last_strike_at = T, the three individual timestamps are not recoverable —
    // the aggregate never stored them. Manufacturing three rows (all stamped T,
    // or spread backwards on an invented cadence) would fabricate audit data.
    // The aggregate row is left untouched and remains the record of every
    // pre-migration strike; this table holds only strikes recorded after the
    // migration, each with a genuine created_at. A later batch must decide
    // explicitly how legacy aggregate strikes interact with the 5-day window;
    // that is a product call and is deliberately not pre-empted here.
    `CREATE TABLE IF NOT EXISTS claim_payment_strike_records (
      id VARCHAR(50) PRIMARY KEY,
      phone_number VARCHAR(15) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ,
      is_cleared_by_admin BOOLEAN NOT NULL DEFAULT false,
      cleared_at TIMESTAMPTZ,
      cleared_by_admin VARCHAR(100),
      source_claim_id VARCHAR(50)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_claim_strike_records_phone ON claim_payment_strike_records(phone_number)`,
    `CREATE INDEX IF NOT EXISTS idx_claim_strike_records_expires ON claim_payment_strike_records(expires_at)`,

    // --- A1: frozen legacy baseline (Batch 0A remediation) ---------------------
    // Additive and nullable, so every existing row is untouched: NULL means
    // 'never touched post-migration' (pure legacy), and strike_count/
    // last_strike_at remain authoritative for those rows. No backfill, no
    // invented historical timestamps. These are written ONCE by
    // recordPaymentStrike() on a phone's first post-migration strike.
    `ALTER TABLE claim_payment_strikes ADD COLUMN IF NOT EXISTS legacy_strike_count INTEGER`,
    `ALTER TABLE claim_payment_strikes ADD COLUMN IF NOT EXISTS legacy_last_strike_at TIMESTAMPTZ`,
    // A1 remediation: durable record that an administrator cleared the LEGACY
    // component for this phone. Needed because recordPaymentStrike() cannot reuse
    // is_cleared_by_admin for that purpose without either re-restricting a
    // cleared phone or allowing a later strike to reactivate a frozen legacy
    // baseline. NULL = never cleared.
    `ALTER TABLE claim_payment_strikes ADD COLUMN IF NOT EXISTS legacy_cleared_at TIMESTAMPTZ`,

    // --- E1: active-notification expiry ----------------------------------
    // Deliberately a SEPARATE column from next_attempt_at, which is retry
    // SCHEDULING. A row can be due for a retry and already past its active
    // window, or vice versa; conflating them would couple user-visible expiry
    // to delivery retry mechanics. Also unrelated to sent_at/status, which are
    // DELIVERY OUTCOME.
    //
    // Nullable with no default: existing rows get NULL, and NULL must mean
    // "never expires" rather than being inferred into a 5-day lookback that
    // could hide an old record. No historical notification is deleted or resent
    // as a result of this statement.
    `ALTER TABLE notification_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,

    // --- BATCH 1: customer notification user layer --------------------------
    // Three NEW tables. Additive and idempotent: CREATE TABLE IF NOT EXISTS, so
    // running this twice is a no-op and no existing row is read, rewritten,
    // deleted or resent. Nothing here touches notification_events, and no
    // statement below migrates or backfills delivery data.
    //
    // WHY NEW TABLES RATHER THAN EXTENDING notification_events
    //   That table is a delivery ledger keyed by a MASKED recipient_reference,
    //   with a channel CHECK limited to sms/email and rows carrying provider
    //   names, error strings and retry counters. A customer-facing layer needs
    //   customer-keyed rows, an in_app channel, and none of those internals.
    //   Forcing it into that table would have required a customer column, a
    //   widened CHECK that N7/N8 rely on, and a projection around nearly every
    //   field. The layers are related by (event_type, business_reference) only.
    //
    // expires_at here is the ACTIVE-WINDOW boundary (see config/customerNotifications
    // .ts), deliberately distinct from notification_events.next_attempt_at,
    // which is retry scheduling. No statement below couples them.
    `CREATE TABLE IF NOT EXISTS customer_notifications (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      category VARCHAR(40) NOT NULL,
      title VARCHAR(160) NOT NULL,
      body TEXT,
      business_reference VARCHAR(64),
      read_at TIMESTAMP WITH TIME ZONE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_via_fallback BOOLEAN NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL
    )`,
    // BATCH 1: no implicit column value is declared in these CREATE TABLE
    // statements, deliberately. Every insert in this layer supplies created_via_fallback,
    // disabled, applied and created_at explicitly. Omitting an implicit value also
    // keeps these statements clear of the locked Batch 0 assertion governing
    // notification_events.expires_at. See batch0FoundationalSchema.test.ts.
    // See batch0FoundationalSchema.test.ts.
    // Partial: holds only unread rows, so it empties as the customer reads.
    `CREATE INDEX IF NOT EXISTS idx_customer_notifications_unread ON customer_notifications(customer_id, created_at) WHERE read_at IS NULL`,

    // Preferences. An ABSENT ROW means ENABLED, which is the safe assumption, so a
    // brand-new customer receives everything without a seeded row per category.
    `CREATE TABLE IF NOT EXISTS customer_notification_prefs (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      category VARCHAR(40) NOT NULL,
      channel VARCHAR(20) NOT NULL,
disabled BOOLEAN NOT NULL,
created_at TIMESTAMP WITH TIME ZONE NOT NULL,
updated_at TIMESTAMP WITH TIME ZONE NOT NULL
    )`,
    // One row per customer+category+channel, so a concurrent double-submit
    // cannot leave contradictory preferences behind.
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_notification_pref ON customer_notification_prefs(customer_id, category, channel)`,
    // Only channels the system can actually deliver on. No fake channel.
    //
    // Re-asserted DROP-then-ADD, exactly like items_status_check above, and for
    // the same reason: sql/schema.sql declares these two constraints as UNNAMED
    // inline column CHECKs, and Postgres auto-names such a constraint
    // "<table>_<column>_check" — which is precisely the two names used below.
    // Any database bootstrapped from sql/schema.sql therefore ALREADY carries
    // both constraints, so a bare ADD CONSTRAINT aborts with
    // 'constraint "..." for relation "customer_notification_prefs" already
    // exists'. Because the bootstrap in this same function runs sql/schema.sql
    // on a genuinely fresh database, that abort happened on FIRST boot too, not
    // only on a re-run — it surfaced as "2 of 171 migration statement(s)
    // failed" and the production startup refusal.
    //
    // Dropping IF EXISTS first makes the pair idempotent on a fresh database
    // AND on a database that already carries the constraint, while still
    // re-asserting the exact predicate: a missing or drifted constraint is
    // corrected, never tolerated. The fail-closed guarantee at the end of this
    // function is untouched — a genuine failure is still fatal in production.
    // This is the SAME pattern the other seven constraint re-assertions in this
    // list use; these two were the only ADD CONSTRAINTs missing their DROP.
    `ALTER TABLE customer_notification_prefs DROP CONSTRAINT IF EXISTS customer_notification_prefs_channel_check`,
    `ALTER TABLE customer_notification_prefs ADD CONSTRAINT customer_notification_prefs_channel_check CHECK (channel IN ('sms', 'email', 'in_app'))`,
    `ALTER TABLE customer_notification_prefs DROP CONSTRAINT IF EXISTS customer_notification_prefs_category_check`,
    `ALTER TABLE customer_notification_prefs ADD CONSTRAINT customer_notification_prefs_category_check CHECK (category IN ('claim_status', 'payment_status', 'document_verification', 'lost_report', 'found_item_report', 'account_security', 'terms_service'))`,

    // Append-only audit of preference changes. Separate from the pref table
    // because that one is updated in place and would therefore lose the
    // customer's previous choice, which is the history an audit must keep.
    `CREATE TABLE IF NOT EXISTS customer_notification_pref_audit (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      category VARCHAR(40) NOT NULL,
      channel VARCHAR(20) NOT NULL,
      previous_disabled BOOLEAN,
      new_disabled BOOLEAN NOT NULL,
applied BOOLEAN NOT NULL,
created_at TIMESTAMP WITH TIME ZONE NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_notification_pref_audit ON customer_notification_pref_audit(customer_id, created_at)`,

    // --- BATCH 2: customer identity changes (G3) ---------------------------
    // ONE new table, additive and idempotent. It holds a CLAIMED but not yet
    // proven email/phone so an unverified second identity is kept entirely out
    // of the authoritative customers row, and so the old identifier keeps
    // authenticating until the new one is verified.
    //
    // No column carries an implicit value here, deliberately: every insert in
    // this path supplies consumed_at / created_at explicitly, and this statement
    // sits AFTER notification_events.expires_at in the list, where the locked
    // Batch 0 assertion governs what may follow. See
    // batch0FoundationalSchema.test.ts.
    `CREATE TABLE IF NOT EXISTS customer_identity_changes (
      id VARCHAR(50) PRIMARY KEY,
      customer_id VARCHAR(50) NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      kind VARCHAR(10) NOT NULL,
      target_value VARCHAR(255) NOT NULL,
      code_hash VARCHAR(64) NOT NULL,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      consumed_at TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_customer_identity_changes_customer ON customer_identity_changes(customer_id, kind)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_identity_changes_expiry ON customer_identity_changes(expires_at)`,
    // Bounded guessing (see config/customerAccountPolicy.ts): the count of WRONG
    // codes presented for a pending identity change. Additive + idempotent so an
    // already-running database picks the column up without a rebuild.
    `ALTER TABLE customer_identity_changes ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0`,


    // --- H9 / H10: customer session device + activity context -------------
    // last_seen_at (the H10 inactivity clock) and revoked_at (H9 per-session
    // revocation, which preserves the row) ALREADY EXIST and are untouched —
    // neither is added or altered here. Only the request context a future
    // "your active sessions" view needs is added.
    //
    // NO IP ADDRESS COLUMN, and none is reserved. The codebase already stores
    // rate-limit identities as salted hashes precisely so a table does not
    // become a record of who connected from where, and session rows follow the
    // same rule. If coarse geography is ever needed it must arrive as its own
    // decision.
    `ALTER TABLE customer_sessions ADD COLUMN IF NOT EXISTS user_agent VARCHAR(512)`,
    // Re-asserted DROP-then-ADD (same pattern as payment_sessions_status_check
    // and lost_reports_status_check above) so the bound holds on a table that
    // already existed from an earlier version. The VARCHAR(512) type already
    // enforces it; this makes the intent explicit and defends a table created
    // from sql/schema.sql against a longer value arriving via another path.
    `ALTER TABLE customer_sessions DROP CONSTRAINT IF EXISTS customer_sessions_user_agent_len`,
    `ALTER TABLE customer_sessions ADD CONSTRAINT customer_sessions_user_agent_len CHECK (user_agent IS NULL OR length(user_agent) <= 512)`,
    `CREATE INDEX IF NOT EXISTS idx_customer_sessions_activity ON customer_sessions(customer_id, last_seen_at)`,

    // --- B12: lost-report withdrawal audit fields -------------------------
    // Foundation only. `status` already carries the business lifecycle and
    // already includes 'cancelled'; these columns add WHO / WHEN / WHY without
    // inventing a lifecycle value or a broad `deleted` flag, so the report row
    // survives exactly as B12 requires.
    `ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`,
    `ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawn_by VARCHAR(100)`,
    `ALTER TABLE lost_reports ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT`,

    // --- B13: found-item withdrawal audit fields --------------------------
    // Same shape as B12. NO new items.status value: items_status_check is a
    // custody vocabulary that means something specific, and B13's withdrawal
    // cases map onto different existing statuses or an admin/agent decision.
    // That constraint change belongs to the batch that implements withdrawal,
    // with its transition rules decided first — it is NOT pre-empted here.
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawn_by VARCHAR(100)`,
    `ALTER TABLE items ADD COLUMN IF NOT EXISTS withdrawal_reason TEXT`,
  ];
  let migrationFailureCount = 0;
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error(`[SCHEMA SYNC] Failed to run: ${sql}`, err);
      migrationFailureCount++;
    }
  }
  console.log(`[SCHEMA SYNC] Database schema check complete — ${statements.length} statements verified.`);

  if (migrationFailureCount > 0) {
    // Every statement above is written to be safely re-runnable (IF NOT
    // EXISTS / IF EXISTS / DROP-then-ADD), so a failure here means a real,
    // unexpected schema problem — e.g. existing rows that violate a new
    // CHECK constraint. Attempting every statement first (rather than
    // stopping at the first failure) maximizes how much of the schema
    // actually gets synced even in a partial-failure scenario, but the
    // process must not silently continue into serving production traffic
    // on top of a database that didn't end up matching what the
    // application code assumes.
    const message = `[SCHEMA SYNC] ${migrationFailureCount} of ${statements.length} migration statement(s) failed. See errors above.`;
    if (process.env.NODE_ENV === 'production') {
      throw new Error(message + ' Refusing to start in production with an unverified schema.');
    }
    console.warn(message + ' Continuing in non-production environment.');
  }

  // Administrative 2FA hardening — one-time, idempotent data migration that
  // encrypts any legacy plaintext admin TOTP secret at rest. Runs after the DDL
  // above so the columns are guaranteed to exist. Non-fatal and retried on every
  // boot (the predicate above makes it a no-op once nothing plaintext remains),
  // so a transient failure here can never take the service down while still
  // converging on encrypted-at-rest.
  try {
    await encryptExistingTotpSecrets(pool);
  } catch (err: any) {
    console.warn('[TOTP MIGRATION] Skipped due to an unexpected error:', err?.message || err);
  }
}
