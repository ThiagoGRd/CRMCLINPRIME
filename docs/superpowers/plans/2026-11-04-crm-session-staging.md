# CRM Session and Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bind the CRM role to the authenticated user and establish reproducible, synthetic concurrency checks without using production.

**Architecture:** Keep the current Supabase/Next application and existing migration chain. Add authenticated-user scoping to membership lookup and run transactional SQL against a disposable PostgreSQL test schema through independent connections.

**Tech Stack:** TypeScript, Node24, Supabase JS, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-04-crm-session-staging-design.md`

## Global Constraints

No production data, secrets, hosted database changes, real provider calls, number migration, agent integration, merge or production deployment. Existing draft branch only. Synthetic SQL fixture is not the real predecessor schema.

## Review Focus

- Visible colleague membership must not change current user's role/name.
- Missing/expired auth must not query membership or metrics.
- Multiple memberships must select consistently in layout/dashboard.
- Missing or inconsistent related organization must fail closed.
- Concurrent claim/cancel/finalize must not duplicate dispatch or storage.

## Task1: Scope authenticated membership

Files: `lib/org.ts`, `app/(app)/dashboard/page.tsx`, `tests/org.test.ts`.

- [x] Reproduce teammate-role selection using actual Supabase query builder and synthetic HTTP boundary.
- [x] Test no auth, auth error, membership failure, deterministic ordering and missing organization.
- [x] Validate auth before `.eq('user_id', user.id)`, order by org_id, retain existing result type.
- [x] Guard dashboard against null org before metrics/record queries.
- [x] Run focused tests, typecheck and lint.

## Task2: Disposable real PostgreSQL checks

Files: `tests/postgres/*`, package test script/dev dependency, `.github/workflows/*`.

- [x] Use only recognized official/registry tools for local disposable server, bind loopback.
- [x] Validate local target and disposable database identity before any schema write.
- [x] Apply synthetic predecessor and real300→700 migrations.
- [x] Test duplicate claim, both claim/cancel orderings, concurrent finalize and first contact with independent sessions and explicit barriers.
- [x] Add read-only CI with fake build variables and no deploy/provider step.
- [x] Run actual PostgreSQL tests, report any unexecuted stage honestly.

## Task3: Review and publish

- [x] Independent review; fix confirmed issues and rerun relevant checks.
- [x] Full npm test, typecheck, build with fake environment, diff check and changed-file lint.
- [ ] Publish to same authorized draft branch, verify exact remote SHA and CI/preview terminal state.
- [ ] Report concrete staging prerequisites and distinguish PostgreSQL/Supabase/browser/provider coverage.
