# Real PostgreSQL concurrency checks

These tests use independent `pg.Client` connections to a **disposable PostgreSQL
16 server**. They apply the actual repository migrations `300 → 400 → 500 → 600 →
700`, unchanged, on `fixture.sql`. That predecessor is deliberately synthetic.
It is **not** the missing original schema, a production dump, or proof that the
migration chain is safe to apply to a hosted project.

No environment file is loaded, no Supabase/WhatsApp request is made, and no
message is sent. Normal `npm test` includes only the connection-guard unit tests;
`npm run test:postgres` requires an explicitly configured server and fails rather
than skipping when it is absent.

## Run with a fresh local Docker container

Requires Node 24, `npm ci`, and Docker. The password below is a fixed synthetic
test value, not a credential for any real account.

```sh
docker run --rm -d --name clinprime-concurrency-test \
  -e POSTGRES_USER=crm_test_owner \
  -e POSTGRES_PASSWORD=synthetic-only \
  -e POSTGRES_DB=crm_concurrency_test \
  -p 127.0.0.1:55439:5432 postgres:16

# Wait until this returns success before running the suite:
docker exec clinprime-concurrency-test pg_isready \
  -U crm_test_owner -d crm_concurrency_test

CRM_TEST_ALLOW_DISPOSABLE_DATABASE=1 \
CRM_TEST_DATABASE_URL='postgresql://crm_test_owner:synthetic-only@127.0.0.1:55439/crm_concurrency_test' \
npm run test:postgres

# Also run on test failure. Use a fresh container for each run.
docker stop clinprime-concurrency-test
```

A native temporary PostgreSQL 16 cluster works too: use a unique non-default
TCP port, bind only `127.0.0.1`, create the same test user/database, and stop/remove
that cluster after the run. The external PostgreSQL binary is intentionally not
added to the application's dependencies. Local verification used PostgreSQL
16.15 from the npm package `embedded-postgres@16.15.0-beta.19`, installed outside
this checkout, with Unix sockets disabled and an automatically selected local
port. The Docker command and GitHub service topology still require their own CI
execution; native verification does not claim to exercise Docker.

## Safety boundary

- Only `CRM_TEST_DATABASE_URL` plus `CRM_TEST_ALLOW_DISPOSABLE_DATABASE=1` can
  enable integration tests. `DATABASE_URL`, ambient `PG*` values, and application
  settings cannot select the connection.
- Only literal `127.0.0.1` or `::1`, an explicit non-default unprivileged port,
  database `crm_concurrency_test`, user `crm_test_owner`, and the synthetic
  password are accepted. DNS names, URL parameters, alternate credentials,
  ordinary database names, and port 5432 are rejected before a connection.
- The connected TCP peer must also be loopback. `inet_server_addr()` is not used
  for this check: a Docker container reached through a loopback-only published
  port sees its own internal network address.
- Before any fixture DDL, read-only catalog checks reject existing public
  objects, nonstandard schemas/databases/extensions, fixture roles, or any
  publication. The suite never deletes existing schemas or data to force a fit.
- The entire PostgreSQL cluster must be disposable because `anon`,
  `authenticated`, and `service_role` are cluster-wide roles. Re-running against
  the used cluster deliberately fails the freshness guard. Stop/remove it and
  create a fresh cluster instead.
- Loopback is an accidental-target safeguard, not proof that a port is not
  forwarded elsewhere. Never point the suite at a tunnel, shared server,
  staging project, or production database.

## What is demonstrated

Every race holds the first real operation uncommitted on one backend, starts the
contender on a different backend, and queries `pg_stat_activity` plus
`pg_blocking_pids` from a third connection. The test must observe the expected
lock wait and exact blocker before committing the winner. Waiting is bounded;
a contender that finishes early fails the test. No sleeps determine which
operation wins.

- Duplicate claims: one dispatch permission/token, one durable request.
- Cancellation first: the waiting claim observes the committed tombstone and
  cannot dispatch, even though no request existed before the cancellation.
- Claim first: the waiting cancellation is rejected as unsafe, without a
  tombstone or misleading audit entry.
- Worker completion: the row lock makes repeated completion return the same
  single stored message.
- Operator finalization: two overlapping audited recoveries reuse one message
  while preserving both operator audit entries.
- First contact: equivalent phone formats return one patient and one initial
  deal despite overlapping webhook work.

These are database concurrency checks, not an HTTP endpoint/provider delivery
simulation. They do not test logical replication subscribers, hosted Supabase
permissions, or the complete unknown predecessor schema. Existing PGlite and
routing tests cover additional behaviors separately.

## CI

`.github/workflows/synthetic-checks.yml` runs the normal synthetic tests, this
suite against a disposable PostgreSQL 16 service, typecheck, and production
build on PRs and pushes to `main`. It uses read-only repository permissions,
synthetic credentials, and no secrets or deployment steps. Root `.env*` files
are removed **only from the disposable CI checkout**, and explicit fake public
Supabase values are supplied to the build. No app server or artifacts are
published. This does not modify the repository's environment files.
