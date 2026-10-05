# Configuration

All configuration is by environment variable. `.env.example` in the repository
root lists the same set with inline commentary and is the file to copy; this
document explains what each variable is for, which are required, which hold
secrets, and which must not be set in production.

## Required

| Variable | Purpose | Secret |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `JWT_SECRET` | Signs and verifies session tokens; also the fallback salt for document hashing and SMS rate-limit bucket keys | Yes |

The application cannot start without `DATABASE_URL`. `JWT_SECRET` has code-level
fallbacks, which means a missing value starts the server rather than failing it;
in production that is worse than a startup error, because tokens signed with a
default salt are forgeable by anyone who has read the source.

`DOC_HASH_SALT` is not strictly required but is effectively so. Without it,
document hashes and SMS rate-limit bucket keys fall back to `JWT_SECRET`, which
means rotating the JWT secret also invalidates in-flight rate-limit buckets and
changes every document hash.

## Application URLs and server

| Variable | Purpose | Secret | Notes |
|---|---|---|---|
| `PORT` | HTTP listen port | No | Defaults to 3000 |
| `CORS_ORIGIN` | Allowed origin for API requests | No | Defaults to `http://localhost:3000` |
| `PUBLIC_APP_URL` | Public origin used to build email activation links | No | **Required in production** |
| `APP_URL` | Listed in `.env.example` | No | **Not read by the application** |

`PUBLIC_APP_URL` falls back to `http://localhost:3000` when unset. In production
that produces activation links pointing at localhost, which the recipient cannot
open — new accounts are created and can never be activated. It is listed in
`.env.example`, but the shipped value is the localhost fallback, so a deployment
assembled from that file still has to set it to the real public origin.

`APP_URL` is the inverse case: present in `.env.example`, read nowhere in the
application. Setting it has no effect. It is listed here so the discrepancy is
recorded rather than discovered.

## Authentication and secrets

| Variable | Purpose | Secret |
|---|---|---|
| `JWT_SECRET` | Session token signing | Yes |
| `DOC_HASH_SALT` | Salt for document hashing and rate-limit bucket keys | Yes |
| `ADMIN_PASSCODE` | Passcode guarding the administration console | Yes |
| `ADMIN_INITIAL_USERNAME` | Username for the bootstrapped administrator | No |
| `ADMIN_INITIAL_PASSWORD` | Password for the bootstrapped administrator | Yes |

`ADMIN_INITIAL_USERNAME` and `ADMIN_INITIAL_PASSWORD` are consumed once, when no
administrator exists yet. After the first administrator is created they are
ignored, so rotating them does not change any existing credential. Change the
password in the application, not in the environment.

## SMS

| Variable | Purpose | Secret |
|---|---|---|
| `SMS_ENABLED` | Master switch for SMS sending | No |
| `AFRICASTALKING_API_KEY` | Provider API key | Yes |
| `AFRICASTALKING_USERNAME` | Provider account username | Yes |
| `AFRICASTALKING_SENDER_ID` | Sender identifier shown to recipients | No |

With `SMS_ENABLED` off, the application fails closed in production rather than
silently skipping a message. A user waiting on a one-time code is told the send
did not happen, which is the correct outcome: silence would leave them waiting.

Africa's Talking is the only SMS provider. There is no fallback provider.

## Email

| Variable | Purpose | Secret |
|---|---|---|
| `RESEND_API_KEY` | Resend API key | Yes |
| `EMAIL_FROM` | Sender, including display name | No |
| `RESEND_FROM_EMAIL` | Legacy name for `EMAIL_FROM`, still honoured | No |
| `EMAIL_REPLY_TO` | Mailbox a reply is delivered to | No |
| `ADMIN_NOTIFICATION_EMAIL` | Recipient of administrative notices | No |

### Sender requirement

`EMAIL_FROM` (or the legacy `RESEND_FROM_EMAIL`, which is still read so an
existing deployment does not silently change sender — `EMAIL_FROM` wins when both
are set) must be an address or domain Resend has verified. Resend provides a
shared test sender, `onboarding@resend.dev`, which restricts delivery to the
address that owns the API key — messages to real recipients are not delivered,
while the send itself still reports success.

`EMAIL_REPLY_TO` defaults to the support mailbox printed in every template
footer, so a reply reaches a human instead of the unattended no-reply sender. An
explicitly empty value, or `none`, suppresses the header for a deployment with no
monitored mailbox.

### Boot behaviour

In production the server refuses to boot without a usable `RESEND_API_KEY`, on
the same boot path as the other missing-secret checks. Outside development there
is no console outbox, so a deployment with no provider would serve traffic while
unable to send the activation link that verifies an account or the payment
confirmation that releases an item from an agent. A placeholder value counts as
missing. In development and test an absent key only warns: the message is written
to the server console instead of being sent.

Resend's shared test sender, and a suppressed Reply-To, are reported as problems
at boot in every environment but never block startup — both can still deliver, and
a staging operator may choose them deliberately.


## Payments

| Variable | Purpose | Secret |
|---|---|---|
| `INTASEND_PUBLISHABLE_KEY` | Publishable key, sent to the client | No |
| `INTASEND_SECRET_KEY` | Server-side API key | Yes |
| `INTASEND_WEBHOOK_SECRET` | Verifies inbound webhooks | Yes |
| `DISPUTE_WINDOW_HOURS` | Hours between handover and settlement eligibility | No |
| `ENABLE_DEV_PAYMENT_SIMULATION` | Enables the payment simulation routes | No |

`INTASEND_WEBHOOK_SECRET` is what makes a webhook trustworthy. Without it, a
crafted request could mark a claim as paid. This variable is not optional in
production even though `.env.example` describes the secret as such.

`DISPUTE_WINDOW_HOURS` sets how long a completed handover waits before money is
released. A longer window protects the platform from fraudulent handovers; a
shorter one pays agents faster.

`ENABLE_DEV_PAYMENT_SIMULATION` must not be set in production. The simulation
routes are additionally guarded by `NODE_ENV`, but the flag is the primary
control and should be absent.

## Object storage

| Variable | Purpose | Secret |
|---|---|---|
| `STORAGE_ENDPOINT` | S3-compatible endpoint | No |
| `STORAGE_BUCKET` | Bucket name | No |
| `STORAGE_KEY` | Access key ID | Yes |
| `STORAGE_SECRET` | Secret access key | Yes |

Uploads fail when storage is unconfigured rather than reporting success, so a
missing bucket produces visible errors instead of items with no image.

## Document analysis

| Variable | Purpose | Secret |
|---|---|---|
| `GEMINI_API_KEY` | Google GenAI key for document OCR | Yes |
| `GROQ_API_KEY` | Groq key for fast inference | Yes |

`GROQ_API_KEY` is optional. Without it, analysis falls back to the primary
provider.

When no analysis key is configured, the item is still recorded; only the
extracted text and derived display name are missing. The analysis capability is
separate from the reporting capability, and losing one does not lose the other.

## Geocoding

| Variable | Purpose | Default |
|---|---|---|
| `GEOCODING_PROVIDER` | Provider name, or a value that disables geocoding | disabled |
| `GEOCODING_ENDPOINT` | Provider endpoint | Nominatim |
| `GEOCODING_TIMEOUT_MS` | Request timeout | 2500 |
| `GEOCODING_CACHE_TTL_MS` | Cache entry lifetime | 24 hours |
| `GEOCODING_CACHE_MAX_ENTRIES` | Maximum cache entries | 500 |
| `GEOCODING_MIN_INTERVAL_MS` | Minimum spacing between requests | 1100 |
| `GEOCODING_USER_AGENT` | User agent sent to the provider | — |

Geocoding is **disabled by default**. The values `none`, `off`, `disabled`,
`false` and the empty string all disable it. An unrecognised provider name
disables it rather than falling back to a live provider, so a typo cannot
silently enable outbound requests that were meant to be off.

The default 1100 ms spacing reflects the public Nominatim usage limit of one
request per second.

## Observability


## Social publishing

| Variable | Purpose | Secret |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | Yes |
| `TELEGRAM_CHANNEL_ID` | Target channel | No |
| `FACEBOOK_PAGE_ID` | Target page | No |
| `FACEBOOK_PAGE_ACCESS_TOKEN` | Page access token | Yes |
| `TWITTER_API_KEY` | X API key | Yes |
| `TWITTER_API_SECRET` | X API secret | Yes |
| `TWITTER_ACCESS_TOKEN` | X access token | Yes |
| `TWITTER_ACCESS_TOKEN_SECRET` | X access token secret | Yes |

These are optional. Public notices are skipped when unconfigured, and the
publication rows record the failure so the condition is visible. Automatic retry
is implemented only for found-notice posts; other publication types are logged
as skipped rather than retried.

## Development-only

| Variable | Purpose | Notes |
|---|---|---|
| `ALLOW_MOCK_OTP_BYPASS` | Skip one-time code verification without sending SMS | Development only |
| `ENABLE_DEV_PAYMENT_SIMULATION` | Enable payment simulation routes | Development only |
| `NODE_ENV` | Runtime mode | Set by the environment |

`ALLOW_MOCK_OTP_BYPASS` is read only when `NODE_ENV` is not production. It does
not cover email activation, which has no bypass path.

`NODE_ENV` is not in `.env.example` because it is normally set by the host
rather than by a developer.

## Handling secrets

- No secret value appears in this repository, in a notification row, in a log
  line, or in an administrator view.
- `.env` is not committed. `.env.example` holds placeholders only.
- In production, every `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_TOKEN` and
  `DATABASE_URL` value must come from the platform's secret store, not from a
  file in the image.
- `EMAIL_FROM`, `EMAIL_REPLY_TO`, `RESEND_FROM_EMAIL` and
  `ADMIN_NOTIFICATION_EMAIL` are not secrets, but a mis-set sender is a
  production incident. See the sender requirement above.

## Known discrepancies

Every variable above appears in `.env.example` except `NODE_ENV`, and `APP_URL`
appears in `.env.example` without being read by the application. Both are
recorded here rather than corrected, because correcting them means editing a
configuration file.

| Variable | Purpose | Secret |
|---|---|---|
| `SENTRY_DSN_BACKEND` | Server-side error reporting DSN | Yes |
| `VITE_SENTRY_DSN_FRONTEND` | Browser-side error reporting DSN | Yes |

Both are disabled when absent, and also when they still hold the
`REPLACE_WITH_...` placeholder shipped in `.env.example`. The placeholder check
exists because an un-replaced placeholder looks like a valid DSN and would send
production errors to a project that does not exist, or to a real project by
accident.

`VITE_SENTRY_DSN_FRONTEND` is prefixed `VITE_` because Vite inlines
`import.meta.env` variables into the browser bundle. Anything with that prefix
is public. A DSN is designed to be public, but no other secret should use the
prefix.

That configuration looks healthy in testing and fails silently in production, so
a deployment left on the test sender will appear to send activation and handover
emails that never arrive. Verify the sender against Resend before going live.

In development, with no API key configured, emails are written to a sandbox
console rather than sent. That path does not exist in production.
