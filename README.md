# Return4me

Return4me is a national lost and found registry. Someone who finds an item
reports it; someone who loses an item searches for it. A claim is verified,
payment is taken into escrow, a registered agent hands the item over at a
designated collection point, and funds are released once the handover is done.

Reported items are matched through OCR-assisted document analysis, so a claimant
can be shown a probable match even when the reporter does not remember the
exact description.

## Who uses it

| Actor | What they do |
|---|---|
| **Finder** | Reports a found item, optionally uploads an image or document, and later confirms the item was released |
| **Owner** | Searches for a lost item, files a claim, proves control of a phone number, pays a fee, and collects the item |
| **Agent** | A registered collection point. Verifies items, receives drop-offs, confirms viewing, and completes handover |
| **Customer** | A registered account holder who can file claims and manage them under one account |
| **Administrator** | Approves agents, reviews items, adjudicates disputes, reconciles payments, monitors notification failures |

Agents are the only actors who physically move items. An owner never receives an
item directly; every handover goes through an approved agent at an assigned
location.

## Main workflows

**Reporting a found item** — a finder submits a description and an optional
image. The backend runs OCR over the image, extracts candidate text, and stores
the extracted text and a display name for search. An administrator reviews the
item before it is surfaced publicly.

**Finding and claiming an item** — an owner searches, submits a claim, and
receives a one-time verification code by email. Once verified, an agent confirms
the item is at their location, which opens a short payment window. The owner
pays, the payment is held in escrow, and a pickup code is issued. See
[docs/claims-and-payments.md](docs/claims-and-payments.md).

**Collection and settlement** — the agent confirms the owner viewed the item,
then confirms handover. Handover puts the claim into settlement, which releases
the disbursement split. A dispute window runs before release; a disputed claim is
adjudicated by an administrator.

**Agent onboarding** — an agent registers with a phone number, verifies a
one-time code, activates their email, submits business and location details, and
waits for administrator approval. Approved agents are assigned a location. See
[docs/agent-workflows.md](docs/agent-workflows.md).

## Technology stack

| Layer | Used for |
|---|---|
| TypeScript, Node.js | Server and shared application code |
| Express | HTTP API |
| React 19, Vite | Frontend |
| Drizzle ORM, PostgreSQL | Persistence |
| Resend | Email delivery |
| Africa's Talking | SMS delivery |
| IntaSend | Mobile payment (M-Pesa STK push and disbursements) |
| Google GenAI SDK | Document OCR and analysis |
| AWS S3 | Object storage for images and documents |
| Sentry | Error reporting |
| Vitest | Tests |

Document OCR uses the Google GenAI SDK. The specific model is selected at
runtime from the configured API key, so it is not pinned here.

## Running it locally

### 1. Prerequisites

- Node.js 18 or newer
- npm
- A reachable PostgreSQL instance

### 2. Install

```bash
npm install
```

### 3. Configure

```bash
cp .env.example .env
```

`.env.example` lists every supported environment variable with commentary. The
minimum needed to start is `DATABASE_URL` and `JWT_SECRET`. SMS, storage, OCR and
geocoding each fail closed or degrade when their own configuration is absent, so
an incomplete `.env` produces a running server with reduced capability rather
than a startup error. Payments, the email transport and the admin secrets are
stricter: in production the server refuses to boot without them, because each of
those paths fails closed at runtime and a missing value would otherwise look
healthy.

SMS is deliberately optional. `SMS_ENABLED="false"` is the recommended initial
production-launch configuration: Africa's Talking credentials and a Sender ID are
not required to boot, no SMS is attempted, and transactional notifications are
carried by email (Resend). Set `SMS_ENABLED="true"` later — once valid Africa's
Talking credentials and an approved Sender ID exist — to activate SMS, at which
point a missing or placeholder SMS value fails the production boot guard again.
Either way the launch path needs no SMS: since the E1 migration all
one-time-code flows are carried by email — signing in, registering, filing a
claim and linking a claim — so no code is withheld while `SMS_ENABLED="false"`.
See [docs/notifications.md](docs/notifications.md) for the delivery seam.
[docs/configuration.md](docs/configuration.md) lists every variable and which
ones are required to boot; `PUBLIC_APP_URL` in particular must be set to the real
public origin in production, or activation links point at localhost.

### 4. Start the development server

```bash
npm run dev
```

The server listens on `PORT` and serves the API and the Vite frontend from the
same process.

### 5. Verify

```bash
npm test          # full test suite
npx tsc --noEmit  # type check
npm run build     # production build
```

`npm run lint` is an alias for `npx tsc --noEmit`; this repository has no
separate linter. See [docs/development.md](docs/development.md) and
[docs/testing.md](docs/testing.md).

## npm scripts

| Script | Command | Purpose |
|---|---|---|
| `dev` | `tsx src/server.ts` | Development server |
| `build` | `vite build` plus an esbuild server bundle | Production build: frontend assets to `dist/`, server to `dist/server.cjs` |
| `start` | `node dist/server.cjs` | Run the production build |
| `test` | `vitest run` | Run the test suite once |
| `lint` | `tsc --noEmit` | Type check |
| `clean` | `rm -rf dist return4me_db.json` | Remove build output |

## Documentation

| Document | Covers |
|---|---|
| [architecture.md](docs/architecture.md) | System structure, service boundaries, decisions that shape them |
| [api.md](docs/api.md) | Route reference, grouped by actor |
| [authentication.md](docs/authentication.md) | Roles, both session models, activation and OTP flows |
| [claims-and-payments.md](docs/claims-and-payments.md) | Claim lifecycle, escrow, settlement, disputes |
| [agent-workflows.md](docs/agent-workflows.md) | Agent onboarding through handover |
| [notifications.md](docs/notifications.md) | Notification events, idempotency, failure classification, retry |
| [data-and-privacy.md](docs/data-and-privacy.md) | Personal data handling, hashing, erasure |
| [DATA_RETENTION_POLICY.md](docs/DATA_RETENTION_POLICY.md) | Authoritative retention schedule (draft, awaiting legal sign-off) |
| [database.md](docs/database.md) | Tables, relationships, correctness constraints |
| [configuration.md](docs/configuration.md) | Every environment variable |
| [development.md](docs/development.md) | Working with the repository |
| [testing.md](docs/testing.md) | Test layout and commands |
| [deployment.md](docs/deployment.md) | Production build and runtime requirements |
| [operations.md](docs/operations.md) | Background sweeps, failure handling, recovery |

Superseded engineering reports are kept in [docs/archive/](docs/archive/) as
historical records. They describe earlier states of the codebase and are not
current documentation.

Return4me is operated by Elligrace Technologies Limited.

