# CRM schema hardening plan

Goal: make staging review actionable without accessing a live database, while preserving the existing foundation contract.

The existing foundation design remains the specification. This continuation adds only a read-only audit, explicit least-privilege grants for the new tables, immutable pending IDs, and three-table Realtime membership. It does not infer or replace predecessor RLS policies.

- [x] Reproduce permissive-default-grant and pending-identity weaknesses with PGlite tests, then harden in migration `20261103040000_crm_security_realtime.sql`.
- [x] Test anonymous, unaffiliated, cross-tenant, authenticated and service-role boundaries using synthetic rows.
- [x] Add only conversations, messages and pending items to an existing `supabase_realtime` publication, preserving unrelated membership and supporting repeat execution. Fail closed if predecessor messages lack RLS or publication is absent.
- [x] Test a read-only SQL preflight against incomplete, inconsistent and post-migration synthetic schemas. Return schema/catalog diagnostics and aggregate issue counts only. Include outbox table/column grants, service RPC grants and required message write columns, with deliberate unsafe-configuration regression tests.
- [x] Run the complete test suite and document actual-schema, browser and replication limits.

No production credentials, data, database connection, migration application, deployment, commit or push is part of this work.

Verification on 2026-11-03: full `npm test` passed 70/70; focused ESLint passed for the two new test files; `git diff --check` passed. The schema/security continuation includes nine security/integration cases and five preflight cases. Hosted Supabase, logical replication transport and the real predecessor schema remain untested.
