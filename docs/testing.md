# Testing

Tests are written with Vitest and run against the source directly.

## Commands

```bash
npm test                                    # full suite, once
npx vitest run src/__tests__/auth.test.ts  # one file
npx vitest run -t "admin_pending_2fa"      # by test name
npx vitest                                 # watch mode
```

`npm test` is `vitest run`: a single pass that exits. It does not watch.

## Layout

| Location | Covers |
|---|---|
| `src/__tests__/` | Server, routes, integration and end-to-end HTTP behaviour |
| `src/db/__tests__/` | Queries, constraints, compare-and-swap operations |
| `src/services/__tests__/` | Service behaviour, provider boundaries, fail-closed paths |
| `src/config/__tests__/` | Pure policy modules and vocabulary |
| `src/utils/__tests__/` | Helpers |
| `src/components/**/__tests__/` | Frontend presentation logic |

Tests sit in a `__tests__` directory beside the code they cover, except for the
top-level `src/__tests__/`, which holds tests spanning several areas.

`vitest.config.ts` includes `src/**/*.test.ts` and runs in a Node environment.
Note that `.test.tsx` is not in the include pattern, so a React component test
written as `.tsx` would not be collected.

## Running a focused test

Most of the suite requires a PostgreSQL database, because the tests exercise real
queries and real constraints rather than a mocked data layer. The database comes
from `DATABASE_URL` in the environment.

The setup file neutralises provider credentials before any test module is
imported. This matters: several services call `dotenv.config()` and initialise
their provider SDKs at import time, so without it, running the suite on a
machine with a populated `.env` would dispatch real SMS. The setup file also
disables the geocoding provider and clears the Sentry DSNs for the same reason.

`ALLOW_MOCK_OTP_BYPASS` is available in the test environment for flows that would
otherwise need a real SMS.

## Test timeout and worker count

`vitest.config.ts` sets a 60 second timeout and two workers, and both values carry
explanations in the config file. The short version:

Several security tests call `vi.resetModules()` and then dynamically re-import a
module to re-evaluate its import-time configuration under a different
`NODE_ENV`. That is a cold import of the whole database module graph. Under
contention from many workers those imports inflate from seconds to tens of
seconds, and tests fail on timeout while passing in isolation — a result that

## Categories of test

**Route and integration tests** mount the real Express app and exercise real
routing. This is possible because `src/server.ts` is constructible without a
listening socket, so tests do not need a second implementation of the routes.

**Security and authorization tests** cover the boundaries that are easy to
regress: that every admin route checks the role inline, that a pending-2FA token
is refused, that a suspended agent cannot act, that one customer cannot read
another's claim, and that error responses do not disclose internals.

**Vocabulary and invariant tests** assert that the closed vocabularies agree
across their declarations — claim statuses in the transition table, the schema
constraint and the runtime DDL; notification channels and statuses likewise.
These fail when a status is added in one place and forgotten in another.

**Constraint tests** assert that the partial unique indexes do what their
comments claim, since those comments are the documentation for a guarantee the
application code alone cannot provide.

**Fail-closed tests** assert that each provider boundary refuses rather than
silently succeeding when unconfigured, and that the `unknown` notification
outcome is never retried.

**End-to-end lifecycle tests** drive a claim from submission through handover
and settlement over HTTP, including the failure paths.

## Adding a test

1. Put it in the `__tests__` directory beside the code, or in `src/__tests__/`
   if it spans areas.
2. Name the file for what it covers, and match the existing `*.test.ts` pattern.
3. Prefer asserting observable behaviour — an HTTP response, a database row, a
   recorded notification — over asserting that a function was called. A few
   existing tests read source text to assert a structural invariant, which is
   appropriate only where the property genuinely has no runtime expression.
4. For a route test, include the negative case: an unauthorized caller, a
   wrong-role caller, a caller who owns nothing. Several of the highest-value
   tests in this repository are the ones that assert a refusal.

## Preserving regression coverage

Many tests here exist because something was once wrong: a route that forgot its
role check, a webhook that paid twice, an error message that leaked a stack
trace, a pending-2FA token that was silently upgraded to a full admin session.
Those tests are not incidental coverage. When a refactor makes one fail, the
correct response is to establish whether the behaviour changed, not to delete the
assertion.

In particular, do not weaken these categories to make a suite pass:

- tests asserting that a pending-2FA token is not an admin session;
- tests asserting that admin routes check the role inline;
- tests asserting that an amount mismatch is refused;
- tests asserting that a duplicate webhook does not pay twice;
- tests asserting that the retry path does not re-run the business transaction.

## Before considering a change complete

```bash
npx tsc --noEmit
npm test
npm run build
```

The build is included because the test environment imports source directly,
while the production build resolves and bundles it. A change can pass every test
and still fail to build.

## Related

- [development.md](development.md) — working with the repository
- [architecture.md](architecture.md) — the boundaries the tests cover
- [operations.md](operations.md) — behaviours the sweeps must preserve

depends on scheduling luck.

Two workers is a correctness setting, not a speed one. Do not raise it to speed
up a run without running the full suite twice afterwards.
