# Settlement authorization snapshot — migration runbook

**Status: reviewed and documented. NOT executed.** This review connected to no
database, took no backup, applied no DDL and read no production data. Every command
below is a procedure an operator runs, not a record that it was run.

The migration adds the two columns Batch 3 writes when a settlement is approved:

```sql
ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_total NUMERIC(10,2);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_ledger_ids TEXT;
```

## 0. What is being added, and why

| Column | Type | Meaning | Nullable |
| --- | --- | --- | --- |
| `settlement_authorized_total` | `NUMERIC(10,2)` | The finder+agent payout total the administrator approved, in KES. Matches `ledger.amount` precision. | Yes (no default) |
| `settlement_authorized_ledger_ids` | `TEXT` | Canonically sorted `role:id` pairs (e.g. `agent:LED-…,finder:LED-…`) of the payout rows the approval covered. **No PII**: a role and a ledger row id, never a phone number. | Yes (no default) |

Three declarations must agree, and a parity test pins them: `src/db/schema.ts`
(`numeric(..., { precision: 10, scale: 2 })` / `text(...)`), `sql/schema.sql`
(bootstrap), and the `statements` array in `ensureSchemaUpToDate()`
(`src/db/index.ts`).

**Safe-NULL semantics.** Both columns NULL = an approval recorded before Batch 3
(`legacy_approval`; the payout is still bound to its booked ledger rows by the
Batch 1.1 integrity check). Exactly one NULL = unverifiable state and is **refused**
at initiation (`incomplete_snapshot`), never read as an authorization.

**No backfill.** Writing a snapshot onto a historical approval would fabricate an
authorization nobody gave. Existing rows stay NULL by design.

## A. Preflight checks and environment identification

Run every step against the **target** database, and record the output in the release
record. Never paste a connection string, password or full host into the record.

**A1. Identify the environment explicitly.**

```sql
SELECT current_database() AS db,
       current_user AS role,
       inet_server_addr()::text AS host,
       version() AS server_version;
```

- [ ] `db`/`host` match the intended production instance (record them **masked**,
      e.g. `prod-db-***.internal`).
- [ ] `server_version` is PostgreSQL 14 or newer (the schema targets 14+; adding a
      nullable column with no default is a metadata-only change on 11+).
- [ ] `role` owns `claims` or has `ALTER` on it. A read-only role cannot run this,
      and `docs/deployment.md` already states a read-only role will not work.
- [ ] The application's `NODE_ENV` is `production` for the environment about to
      receive this change, and `DATABASE_URL` points at the same instance just
      queried (verify by host/database, not by printing the URL).

**A2. Record the release identity.** Deployment SHA (expected
`d3e166000a0fa4b71deda2fe1afccba8243ed7cd` or a descendant), migration operator,
window start/end.

**A3. Confirm the columns are genuinely absent (pre-migration).**

```sql
SELECT column_name, data_type, numeric_precision, numeric_scale,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'claims'
  AND column_name IN ('settlement_authorized_total', 'settlement_authorized_ledger_ids');
```

- [ ] Zero rows = first application.
- [ ] Two rows with the expected types = already applied; **stop and verify** rather
      than "re-applying" (the statement is a no-op, but an unexpected prior run
      needs an explanation).
- [ ] One row = a partial/failed prior attempt; resolve before deploying anything.

**A4. Snapshot integrity pre-check (must be zero).**

```sql
SELECT
  count(*) FILTER (WHERE settlement_authorized_total IS NULL
                     AND settlement_authorized_ledger_ids IS NULL) AS legacy_approvals,
  count(*) FILTER (WHERE (settlement_authorized_total IS NULL)
                    <> (settlement_authorized_ledger_ids IS NULL)) AS half_written
FROM claims;
```

- [ ] `half_written = 0`. If it is not, **stop**: the application will refuse those
      payouts, and the rows need an investigation before any release.

**A5. Confirm nothing financial is in flight.**

```sql
SELECT status, count(*) FROM claims GROUP BY status ORDER BY status;
SELECT count(*) FROM ledger
WHERE type IN ('finder_payout', 'agent_payout')
  AND status NOT IN ('pending', 'completed', 'failed');
```

- [ ] No claim is mid-release (`releasing` count understood and explained).
- [ ] No payout row is in a submitted/unknown state that an operator is still
      reconciling.
- [ ] No administrator is approving a settlement during the window (coordinate a
      short freeze; the ALTER takes a brief `ACCESS EXCLUSIVE` lock).

**A6. Bound the lock.** In the migration session:

```sql
SET lock_timeout = '5s';
SET statement_timeout = '60s';
```

A lock timeout aborts the migration cleanly; it cannot corrupt an approval.

## B. Backup and recoverability verification

**No backup exists as a result of this review.** The following is the checklist that
must be completed — and evidenced — before the SQL in section C is run.

- [ ] Provider snapshot / PITR marker taken now, named with the release SHA and
      timestamp. Record the snapshot identifier and retention window.
- [ ] Logical dump of the affected table:

      ```bash
      pg_dump --format=custom --table=public.claims "$DATABASE_URL" \
        > claims-pre-settlement-snapshot-<sha>-<utc>.dump
      ```

- [ ] Restore that dump into a **scratch** database and verify it loads.
- [ ] Compare row count and a content checksum between production-read and restore:

      ```sql
      SELECT count(*) AS rows,
             md5(string_agg(id, ',' ORDER BY id)) AS id_digest,
             md5(string_agg(coalesce(status,''), ',' ORDER BY id)) AS status_digest
      FROM claims;
      ```

      (Run the identical query on both sides. Record both digests.)
- [ ] Record: snapshot id, dump file name/size, restore duration, row count, digests,
      and who verified the restore.
- [ ] Confirm the restore is usable **by this application**: boot it against the
      scratch database in a non-production environment before the window, not after.

A backup that has never been restored is a hope, not a recovery plan.

## C. The reviewed migration artifact

Run this once, in the maintenance window, as a single transaction so a failure
cannot leave one column added and the other missing:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_total NUMERIC(10,2);
ALTER TABLE claims ADD COLUMN IF NOT EXISTS settlement_authorized_ledger_ids TEXT;
COMMIT;
```

**Why this is consistent with the repository's conventions.**

- `ensureSchemaUpToDate()` in `src/db/index.ts` is this repository's incremental
  migration mechanism (`docs/database.md`, `docs/deployment.md`). These two
  statements already exist there as the same SQL (the bootstrap `sql/schema.sql`
  spells the type `NUMERIC(10, 2)`, the migration array spells it `NUMERIC(10,2)`,
  and both are accepted identically by PostgreSQL).
- Both statements are idempotent (`IF NOT EXISTS`); `schemaSyncIdempotency` proves
  the array is safe to re-run, and `settlementAuthorizationEnforcement` pins the
  presence and shape of these exact strings.
- In production, a failed statement makes `ensureSchemaUpToDate()` throw and the
  process refuse to start ("Refusing to start in production with an unverified
  schema"). That is fail-closed, not a silent partial schema.

**Two valid execution orders.**

1. **Recommended — pre-apply, then deploy.** Run section C manually with a DDL-capable
   role, verify section D, then deploy. The boot-time sync re-runs both statements as
   no-ops, so there is no DDL surprise during rollout.
2. **Deploy and let boot migrate.** Allowed (same statements, same ordering), but the
   DDL then happens during application start-up, under whatever traffic the rollout
   exposes, and a failure takes the instance down instead of aborting a migration.

**Do not deploy the new application code against an unmigrated database and assume it
degrades gracefully.** `approveSettlement()` writes both columns in the approval
transaction; a missing column aborts that transaction, so approvals would fail rather
than record a snapshot. The read path selects the declared column list through
Drizzle (no `SELECT *`), so an absent column is an error rather than a NULL. Verify
this behaviour on the staging copy during section E — it is a code-reading
conclusion, not something this review executed against PostgreSQL.

## D. Post-migration schema verification

```sql
-- D1. Exact shape.
SELECT column_name, data_type, numeric_precision, numeric_scale,
       is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'claims'
  AND column_name IN ('settlement_authorized_total', 'settlement_authorized_ledger_ids')
ORDER BY column_name;
```

- [ ] `settlement_authorized_total`: `numeric`, precision 10, scale 2, nullable, no default.
- [ ] `settlement_authorized_ledger_ids`: `text`, nullable, no default.

```sql
-- D2. No data was rewritten.
SELECT count(*) AS rows,
       count(*) FILTER (WHERE settlement_authorized_total IS NULL
                          AND settlement_authorized_ledger_ids IS NULL) AS null_snapshots
FROM claims;
```

- [ ] Row count equals the pre-migration count recorded in A5.
- [ ] `null_snapshots` equals `rows` immediately after migration (no backfill ran).

```sql
-- D3. Nothing else changed: no new index on these columns.
SELECT indexname FROM pg_indexes
WHERE schemaname='public' AND tablename='claims'
  AND indexdef ILIKE '%settlement_authorized%';
```

- [ ] Zero rows. None is required — see "Why no index, constraint or backfill" below.

## E. Application smoke tests (no financial operations)

Run these against staging (or production, read-only) after the migration.

- [ ] Boot log shows `[SCHEMA SYNC] Database schema check complete — N statements
      verified.` and no `[SCHEMA SYNC] Failed to run` line.
- [ ] `node node_modules/typescript/bin/tsc --noEmit` — exit 0 on the deployed bytes.
- [ ] Read-only admin surfaces: sign in and open the dashboard and one
      `pending_settlement` claim. Confirm the settlement summary renders (it reads
      the persisted snapshot) and that an *unapproved* claim shows the approval
      action, not a fabricated total.
- [ ] Confirm an ineligible claim's approval is **refused** without writing (e.g. a
      claim outside its review window). A refusal proves the write path is reachable
      and correctly guarded; it records nothing.
- [ ] Confirm the boot log's wallet lines report configured/undeclared — without
      printing wallet IDs.
- [ ] **Explicitly out of scope for a smoke test:** approving a claim, initiating a
      payout, approving a batch, issuing a refund, transferring between wallets.

If a staging claim is used to exercise a *successful* approval, do it only in
staging, and confirm afterwards that `settlement_authorized_total` equals the sum of
that claim's `finder_payout` + `agent_payout` ledger rows and that
`settlement_authorized_ledger_ids` lists exactly those rows.

## F. Rollback considerations

**The default rollback is application-only: redeploy the previous release and leave
the columns in place.** They are additive and nullable; code from before Batch 3
never reads or writes them, so reverted code behaves exactly as it did before.

**Do not drop the columns to "roll back".** After the window, every new approval
writes an authorization snapshot into them. Dropping the columns destroys the only
record of what those approvals covered — which is the control the migration exists to
provide. A drop is a data-loss action, not a rollback.

If a drop is ever unavoidable:

1. Freeze approvals and payout initiation first.
2. Export before dropping:

   ```sql
   COPY (
     SELECT id, settlement_approved_at, settlement_approved_by,
            settlement_authorized_total, settlement_authorized_ledger_ids
     FROM claims
     WHERE settlement_authorized_total IS NOT NULL
        OR settlement_authorized_ledger_ids IS NOT NULL
   ) TO STDOUT WITH (FORMAT csv, HEADER true);
   ```

3. Store the export with the release record and verify it is readable.
4. Only then drop, and re-apply the migration before any new code is deployed.

**Partial-failure handling.** If only one column was added (possible only outside the
single transaction in section C), do not deploy: the approval writer needs both, and
a half-present snapshot is refused. Re-run section C to complete it.

**Point-in-time recovery** is the last resort: it restores the database to a moment,
discarding everything written after it. It requires provider confirmation that the
window and retention actually cover the incident — never assume PITR exists.

## G. Go / no-go conditions

Do **not** execute in production unless every line is true and evidenced.

- [ ] Target environment positively identified (A1) and matches the release being
      deployed.
- [ ] Pre-migration column state is exactly "absent" and `half_written = 0` (A3, A4).
- [ ] No approval or payout is in flight; the freeze is agreed and announced (A5).
- [ ] Backup exists, was **restored into a scratch database**, and the digests match
      (section B).
- [ ] The migration SQL executed is exactly section C, by a DDL-capable role.
- [ ] Post-migration shape matches D1 and row counts match D2.
- [ ] Boot log is clean and the read-only smoke tests pass (section E).
- [ ] Rollback plan (section F) is agreed, including who may authorise an
      application rollback and where the snapshot export would be written.
- [ ] IntaSend verification is **not** a precondition of this migration — but the
      first payout still requires it (see
      [`intasend-provider-verification.md`](intasend-provider-verification.md)).

**No-go** if any of the following is true: the target is ambiguous; a backup has not
been restore-tested; `half_written > 0`; a payout is mid-reconciliation; the operator
cannot obtain a DDL-capable role; or the release being deployed is not the one whose
tests were run.

## Why no index, constraint or backfill

- **No index.** The columns are never filtered, sorted or joined on. They are read
  as part of the claim row, already fetched by primary key. An index would be unused
  write amplification.
- **No CHECK constraint.** The application already refuses a half-present snapshot
  at payout initiation (`incomplete_snapshot`). A DB constraint would add a second
  enforcement point to migrate, and existing rows legitimately hold `(NULL, NULL)`.
  Adding one is a speculative schema change to the money path; it is not included.
- **No backfill.** See section 0. Backfilling an approval snapshot invents an
  authorization that was never given.
- **No default.** With no `DEFAULT`, there is no table rewrite and no invented value
  for historical rows.

## Concurrency and ordering

- **Approval is a single transaction.** `db.approveSettlement()` performs a
  conditional update (status `pending_settlement`, `settlement_approved_at IS NULL`,
  elapsed `settle_at`) and, only when that wins, writes both snapshot columns in the
  same transaction. If the payout rows cannot be described unambiguously, the
  transaction is aborted, so no approval exists without its snapshot.
- **Two simultaneous approvals** cannot both win: the `IS NULL` predicate makes the
  second update affect zero rows and report `already_approved`.
- **The ALTER versus an in-flight approval.** The DDL takes `ACCESS EXCLUSIVE` on
  `claims` for a metadata-only change; a concurrent approval either completes first
  or waits. With `lock_timeout` set, the migration aborts instead of queueing
  indefinitely, and no approval is ever partially written.
- **Initiation** compares the snapshot before any durable submission marker; a
  migration that runs between approval and initiation cannot make a mismatched
  payout pass, because the comparison is on stored values, not on schema presence.
- **Legacy approvals remain payable** (both columns NULL), bound to their booked
  ledger rows by the Batch 1.1 integrity check — the migration neither widens nor
  narrows that path.
