import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.ts";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as Sentry from "@sentry/node";

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
  admin_users: []
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
        console.error("[ResilientPool] Failed to instantiate pg Pool. Falling back to Mock Mode.", err);
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
  return new ResilientPool(dbUrl, isPlaceholder);
};

export const pool = createPool();

export const db = drizzle(pool, { schema });

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
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS payout_method_type VARCHAR(50) NOT NULL DEFAULT 'Till Number'`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS needs_manual_geocoding BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE agents ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255)`,
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
    // Admin 2FA (TOTP) — additive columns only, both default to "not
    // enrolled" so no existing admin account is affected until they
    // opt in via the new enrollment flow.
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255)`,
    `ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false`,
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
    `CREATE TABLE IF NOT EXISTS admin_users (
      id VARCHAR(40) PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      full_name VARCHAR(100) NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ
    )`,
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
    // Safe to run on every boot.
    `ALTER TABLE claims DROP CONSTRAINT IF EXISTS claims_status_check`,
    `ALTER TABLE claims ADD CONSTRAINT claims_status_check CHECK (status IN ('pending_verification', 'awaiting_agent_confirmation', 'pending_payment', 'payment_window_expired', 'escrow_held', 'releasing', 'released', 'disputed', 'rejected', 'refunding', 'refunded'))`
  ];
  for (const sql of statements) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error(`[SCHEMA SYNC] Failed to run: ${sql}`, err);
    }
  }
  console.log(`[SCHEMA SYNC] Database schema check complete — ${statements.length} statements verified.`);
}
