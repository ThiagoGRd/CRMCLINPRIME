# Isolated CRM database checks

These checks use a minimal, synthetic predecessor schema, not a production dump.
They exercise the real migration on PGlite (PostgreSQL compiled to WebAssembly).
They do not read environment files or contact Supabase or WhatsApp.

Node 24 and the pinned `@electric-sql/pglite` development dependency are needed:

```sh
npm ci
npm test          # UI helpers, actual send routing, database, WA helpers
npm run test:db   # only isolated database checks
npm run test:routing
```

`PGLITE_MODULE` optionally points to an externally installed PGlite ES module.
The normal test command requires no environment variables or credentials.

The fixture validates SQL execution, composite foreign keys, RLS, immutable
conversation identity, required pending-item fields, explicit audited resolution,
legacy unclassified history, idempotent message inserts and monotonic activity.
Routing checks execute the actual send endpoint against synthetic transport and
database boundaries. They never deliver a WhatsApp message.

This does not replace validating the migration against a sanitized copy of the
actual predecessor schema, inspecting existing RLS policies/triggers, checking
Supabase Realtime publication membership, and testing deployment with a test
WhatsApp number. The repository does not contain the complete original schema.

## Schema/security continuation

`security.test.mjs` reproduces permissive default grants, denies destructive browser
permissions, protects pending primary IDs, checks negative RLS/role cases, and
runs the 300/400/500 migration chain using synthetic fixtures. Publication tests
inspect real PostgreSQL catalogs, including repeat execution and existing
all-table publications. They do not run a logical replication subscriber or
Supabase Realtime server.

`preflight.test.mjs` executes `docs/schema/crm-preflight.sql` against empty,
inconsistent, migrated and RLS-limited synthetic schemas. It checks reported
counts, absence of selected record content, unchanged data and incomplete-audit
reporting. See `docs/schema/README.md` for the authorized staging workflow and
remaining limits. No live audit or migration has been performed.
