# CRM Readiness Implementation Plan

**Goal:** Continue the CRM foundation with safe historical access, durable delivery identity, and tested database readiness checks.
**Architecture:** Keep Next.js/React/Supabase. Add read-only legacy access rather than guessing historical channels. Persist outbound requests before transport and refuse automatic retries after ambiguous outcomes. Add narrow database hardening and a read-only preflight; never apply against production.
**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL, Supabase Edge Functions, synthetic PGlite and transport fixtures.
**Spec:** docs/CRM-FOUNDATION-DESIGN.md, docs/CRM-FOUNDATION-READINESS.md.

## Constraints
- Continue the existing isolated branch and draft PR. No merge, live data, production deployment, numbers, new credentials, agent integration or automatic resolution.
- Builder choices continue the existing architecture; synthetic tests cannot certify the unknown live schema.

## Review focus
- Repeated sends, lost responses and accepted-but-unsaved delivery must not cause another external send.
- Cross-tenant IDs, anonymous access and inherited database privileges must fail closed.
- Legacy messages must remain separate, read-only and visibly unattributed to a number.
- Reload, older requests and navigation must preserve conversation identity.
- Small screens must retain accessible channel selection, messages and patient work.

## Tasks
### 1. Database readiness and security
- [x] Reproduce unsafe inherited privileges with synthetic tests; harden new tables in migration 400.
- [x] Add read-only schema/data/RLS/publication preflight with counts only and no personal records.
- [x] Add conditional idempotent Realtime publication membership for the CRM tables; document infrastructure-only limits.
### 2. Read-only legacy archive
- [x] Test org/patient/null-channel scoping and stable paging.
- [x] Implement /historico-legado with patient selection, read-only message history and clear unknown-number warnings.
- [x] Link from navigation and active patient context without merging records or enabling replies.
### 3. Durable send intent
- [x] Test atomic claim, request binding, concurrent duplicate/replayed calls, provider rejection, timeout and save failure.
- [x] Add outbound request ledger migration 500 and explicit state-based endpoint responses.
- [x] Integrate UUID intent, same-ID status recovery, uncertainty warning and reload visibility into the Inbox. No browser persistence of patient message text.
### 4. Verification and delivery
- [x] Run full tests, typecheck, focused and aggregate lint, synthetic build and browser checks where supported.
- [x] Independent review, fix confirmed issues with regression tests.
- [x] Update readiness documentation and prepare reviewed changes for the existing authorized branch/PR. Confirm publication and remote checks separately; no production deployment.

## Final local verification

83/83 tests passed, including ten real-client synthetic HTTP fixture checks. Typecheck, build with fake Supabase settings, changed-file ESLint and diff checks passed. Independent review findings were reproduced and fixed. CUA exercised the synthetic archive and send/reload safeguards; the full automated browser runner remains unexecuted. Global lint still has seven pre-existing errors. No live schema, actual distributed PostgreSQL concurrency, WebSocket/JWT Realtime or real WhatsApp delivery was tested.
