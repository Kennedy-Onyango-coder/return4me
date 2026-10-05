# Deployment

This document covers what the repository itself establishes about running
Return4me in production. It does not prescribe a hosting platform; none is
defined here, and the process is a plain Node.js server that any platform able to
run it will serve.

Return4me is operated by Elligrace Technologies Limited.

## Build

```bash
npm ci
npm run build
```

The build produces two things in `dist/`: the frontend assets from `vite build`,
and `dist/server.cjs`, an esbuild bundle of `src/server.ts`.

`express` and `vite` are marked external in the bundle, so they are resolved from
`node_modules` at runtime rather than inlined. They must therefore be installed
in the runtime image; a build stage alone is not sufficient.

## Run

```bash
NODE_ENV=production npm start
```

`npm start` runs `node dist/server.cjs`. There is no cluster mode, no process
manager configuration and no container definition in this repository.

Some behaviours below are affected by running more than one instance. The durable
SMS rate limit and the notification retry sweep both handle that case — see
[operations.md](operations.md) — but the general-purpose rate limiters use
`express-rate-limit`'s in-process store, which is per instance.

## Database prerequisites

- A reachable PostgreSQL instance
- A role permitted to create and alter tables

The application issues DDL at startup through `ensureSchemaUpToDate()`, and the
schema is also available as `sql/schema.sql`. A read-only database role will not
work.

`DATABASE_URL` is the only variable the application cannot start without.

## Environment configuration

See [configuration.md](configuration.md) for every variable. The ones that
specifically affect a production deployment:

| Variable | Consequence if wrong |

## External providers

Each is optional in the sense that the application runs without it, and each
fails closed or degrades rather than silently succeeding. See
[architecture.md](architecture.md) for the per-provider behaviour table.

| Provider | Purpose | Without it |
|---|---|---|
| Resend | Email | Fails closed in production; handover and activation notifications fail |
| Africa's Talking | SMS | Fails closed; one-time codes cannot be delivered |
| IntaSend | Payments | Payment routes refuse |
| S3-compatible storage | Images and documents | Uploads fail visibly |
| Google GenAI | Document OCR | Items are recorded without extracted text |
| Geocoding provider | Location resolution | Disabled by default anyway |
| Sentry | Error reporting | Disabled; errors are not reported off-host |
| Telegram / Facebook / X | Public notices | Skipped, and recorded as failed |

## Application URL

The frontend and API are served from the same origin by the same process, so
there is no separate API base URL to configure in the browser. `CORS_ORIGIN`
still needs to permit the deployed origin.

`PUBLIC_APP_URL` is the public origin used in activation emails and must be the
origin users can actually reach. It is the one variable whose absence produces a
failure that is not visible from the server logs.

## Background work

Five sweeps run on timers in every process, started when the server listens:

| Sweep | Interval |
|---|---|
| Claim payment window expiry | 60 seconds |
| Due settlements | 5 minutes |
| Social publication retry | 5 minutes |
| Notification retry | 5 minutes |
| Handover evidence retention | 24 hours |

In a multi-instance deployment each instance runs them. The three that mutate
money-related state — expiry, settlement and notification retry — claim their work
with conditional updates that return whether they won, so a second instance
finding the same row does nothing. See [operations.md](operations.md).

## Production safety

- Keep `NODE_ENV=production`. Several fail-closed guards and the OTP bypass are
  conditional on it.
- Confirm `EMAIL_FROM` (or the legacy `RESEND_FROM_EMAIL`) against the Resend
  dashboard, not by observing that a send call returned success.
- Set `PUBLIC_APP_URL` explicitly.
- Provide secrets through the platform's secret store rather than a file in the
  image.
- Run the type check, the full test suite and the build as part of the pipeline;
  the build catches import problems the tests do not.
- Before scaling to multiple instances, read
  [operations.md](operations.md) on sweep concurrency.

## Verification after deployment

`GET /api/health` confirms the process is up. It does not confirm that providers
are configured, that the database schema is current, or that the Resend sender is
verified. A deployment can be fully healthy by that endpoint and still unable to
send an activation email.

## Related

- [configuration.md](configuration.md) — every variable
- [operations.md](operations.md) — sweeps and recovery
- [architecture.md](architecture.md) — provider boundaries

|---|---|
| `PUBLIC_APP_URL` | Unset produces activation links pointing at `localhost`. Accounts are created and can never be activated. It is listed in `.env.example` as the localhost fallback, so an unedited copy still omits a real origin. |
| `RESEND_FROM_EMAIL` | An unverified or Resend test sender restricts delivery to the API key owner. Activation and handover emails appear to send and never arrive. |
| `JWT_SECRET` | Code-level fallback means a missing value starts the server with a publicly known signing key. |
| `DOC_HASH_SALT` | Falls back to `JWT_SECRET`; rotating the JWT secret then changes every document hash and empties in-flight rate-limit buckets. |
| `INTASEND_WEBHOOK_SECRET` | Unset means a webhook cannot be verified, and a crafted request could mark a claim as paid. |
| `SMS_ENABLED` | Off means SMS fails closed. A user waiting on a one-time code is told the send failed, which is the intended behaviour. |

`ENABLE_DEV_PAYMENT_SIMULATION` and `ALLOW_MOCK_OTP_BYPASS` must not be set. The
`/api/dev/*` routes additionally check `NODE_ENV`, but the environment
configuration is the primary control.

The `VITE_` prefix marks variables Vite inlines into the browser bundle. Anything
with that prefix is public. A Sentry DSN is designed to be public; no other
secret should carry the prefix.
