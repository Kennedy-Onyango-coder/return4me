# Development

How to work with this repository.

## Prerequisites

- Node.js 18 or newer
- npm
- A PostgreSQL instance the application may create and alter tables in — the
  application issues DDL at startup, so a read-only role will not work

## Setup

```bash
npm install
cp .env.example .env
```

Set at minimum `DATABASE_URL` and `JWT_SECRET`; set `DOC_HASH_SALT` as well,
since it is the fallback salt for document hashing and SMS rate-limit buckets.
See [configuration.md](configuration.md) for every variable.

## Running

```bash
npm run dev
```

`tsx src/server.ts` starts the server with Vite mounted as middleware, so the
API and the frontend share one port and one origin. There is no separate frontend
dev server to start.

## Scripts

| Script | Does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Vite build plus an esbuild bundle of the server to `dist/server.cjs` |
| `npm start` | Run the built server |
| `npm test` | `vitest run`, once |
| `npm run lint` | `tsc --noEmit` — the type check |
| `npm run clean` | Remove `dist/` and the legacy JSON database file |

`npm run lint` is a type check, not a style linter. There is no ESLint or
Prettier configuration in this repository, so there is no formatting command to
run and no lint errors about style to fix.

The type check is worth running before the full test suite, because it is much
faster and catches a large fraction of mistakes.

## Code organisation

```
src/
  server.ts        entry point; account, auth, admin, item and dispute routes
  routes/          domain route modules
  services/        domain behaviour, provider calls
  config/          pure policy and vocabulary, no database or network
  db/              schema, queries, compare-and-swap operations
  components/      React views
  __tests__/       tests
```

Two conventions are worth following because the codebase depends on them.

**`src/config` modules stay pure.** No imports from `db`, services or Express.
This is what lets the claim lifecycle be imported by both a route and a React
component, and lets the notification catalogue be tested without a database.

**Shared vocabulary is declared once.** Claim statuses live in
`src/config/claimStatuses.ts`; notification events in
`src/config/notificationEvents.ts`. A status or event added anywhere else will
drift, and tests exist specifically to catch that.

## Adding a route

1. Put it in the domain module under `src/routes/` if one fits, otherwise in
   `src/server.ts` alongside its neighbours.
2. Apply authentication middleware, then authorization separately. A route
   under `/api/admin/*` needs an inline `role === 'admin'` check — the JWT
   middleware authenticates but does not authorize, and a test audits for the
   missing check.
3. For a claim-scoped route, use the shared claim-ownership check rather than
   re-deriving ownership from the request.
4. Call a service. Routes should not contain domain logic or SQL.
5. Keep the response shaped for the actor: administrator views go through
   `adminSafeViews.ts`, public views through the restricted DTO.
6. Add the route to [api.md](api.md).

## Adding a claim status or a notification event

Both are governed by a closed vocabulary, and both need changes in more than one
place. A status that is added to only one will be rejected by a test.

For a claim status: `CLAIM_STATUS_VALUES` and the relevant derived sets in
`src/config/claimStatuses.ts`, the `claims_status_check` constraint in
`src/db/schema.ts`, the same constraint in `sql/schema.sql` and
`ensureSchemaUpToDate()`, the status label in
`src/components/claimStatus.ts`, and
[claims-and-payments.md](claims-and-payments.md).

For a notification event: an entry in `EVENT_DEFINITIONS` in
`src/config/notificationEvents.ts`, including its channel, priority and retry
class; the `notification_events_channel_check` and status constraint if the
channel or status vocabulary changes; and
[notifications.md](notifications.md).

An event with no call site should not be defined. The module records deliberately
absent events in `ABSENT_EVENTS` for exactly this reason.

## Changing the schema

The schema is declared in three places that must agree: `src/db/schema.ts`,
`sql/schema.sql`, and `ensureSchemaUpToDate()` in `src/db/index.ts`. A constraint
added to one and not the others means a database created by the other path will
behave differently.

There are tests that assert the vocabularies match. Run them.

## Validating a change

```bash
npx tsc --noEmit
npm test
npm run build
```

Run all three before considering a change complete. The build catches import and
bundling problems the type check and the tests do not — the test environment
imports source directly, while the production build resolves and bundles it.

For a change in one area, run the relevant test file first. Test files are named
for the area they cover; see [testing.md](testing.md).

## Working with the documentation

The documents in `docs/` describe the current implementation and are expected to
match it. If a change alters behaviour a document describes, update the document
in the same change.

`docs/archive/` is historical. It is not maintained and should not be updated.

## Related

- [testing.md](testing.md) — test layout and commands
- [architecture.md](architecture.md) — the boundaries above in detail
- [configuration.md](configuration.md) — environment variables
- [api.md](api.md) — the route reference to update when routes change
