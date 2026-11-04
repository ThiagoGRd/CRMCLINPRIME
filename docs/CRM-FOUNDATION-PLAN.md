# CRM Foundation Implementation Plan

**Goal:** Separate channel conversations and persist manually resolved patient work in Supabase.
**Architecture:** Incremental database migrations enforce identity and tenant boundaries; an explicit send route and channel-specific Inbox consume these records. A separate pending-item screen and conversation panel share the same durable data.
**Tech Stack:** Next.js 16, React 19, TypeScript, Supabase PostgreSQL and Edge Functions.
**Spec:** docs/CRM-FOUNDATION-DESIGN.md

## Global Constraints
- No production data, number migration, deploy, agent supervision, agent credentials/API or auto-close.
- Keep existing Next.js/Supabase architecture; use synthetic fixtures only.
- No silent channel fallback or guessed assignment of old messages.

## Review Focus
- Cross-organization IDs must be rejected by the database and sending endpoint.
- Late requests after changing the selected conversation must not leak into the new chat.
- A disconnected or missing channel must fail closed.
- Duplicate webhook events and out-of-order timestamps must preserve identity and latest activity.
- Reloading or receiving a message must not resolve or remove an open pending item.

### Task 1: Data integrity and explicit delivery
**Files:** supabase/migrations/20261103030000_crm_foundation.sql, supabase/functions/whatsapp-send/index.ts, supabase/functions/whatsapp-webhook/index.ts, tests/database, tests/routing.
**Interfaces:** crm_conversations(id,org_id,patient_id,channel_id,assigned_to,status,last_message_at); channels.inbox_key = reception|commercial|crc|null. crm_pending_items(id,org_id,patient_id,conversation_id,title,description,assigned_to,due_at,status,resolution_evidence,resolved_by,resolved_at,created_at,updated_at) with status open|in_progress|resolved. Resolution RPC resolve_pending_item(p_id,p_evidence). Send body conversation_id,channel_id,text; response message includes conversation_id and channel_id.
- [x] Write and run failing database/routing tests for identity, tenant isolation, required fields, explicit resolution, duplicate events and invalid send channel.
- [x] Implement migrations and deterministic delivery without production calls.
- [x] Run synthetic database and routing checks and record limits.

### Task 2: Channel Inbox and setup mapping
**Files:** components/inbox/inbox-client.tsx, lib/inbox.ts, components/conexoes/conexoes-client.tsx, tests/inbox.test.ts.
**Interfaces:** Query crm_conversations joined with crm_patients and channels. Select by conversation_id, never patient_id alone. Render PendingItemsPanel with patientId/conversationId.
- [x] Write failing tests for sector selection, duplicate patients, ambiguous legacy links and send-response isolation.
- [x] Implement three sector tabs, explicit number selection, message filtering, safe per-conversation drafts and channel mapping UI.
- [x] Run tests, typecheck and scoped lint.

### Task 3: Durable pending-item workflow
**Files:** components/pendencias/pending-items-panel.tsx, components/pendencias/pendencias-client.tsx, app/(app)/pendencias/page.tsx, lib/pending-items.ts, lib/nav.ts, tests/pending-items.test.ts.
**Interfaces:** PendingItemsPanel({patientId:string,conversationId:string}), reads/writes crm_pending_items; calls resolve_pending_item(p_id,p_evidence). Page lists open items independent of message activity.
- [x] Write failing tests for validation, explicit resolution and durable list selection.
- [x] Implement creation, assignment, due date, state updates and evidence-backed manual resolution, with clear errors and refresh.
- [x] Run tests, typecheck and scoped lint.

### Task 4: Verification and handoff
**Files:** docs/CRM-FOUNDATION-READINESS.md and test infrastructure as needed.
- [x] Run baseline and final test/lint/typecheck/build checks, distinguish pre-existing failures.
- [x] Independently review complete diff and fix important findings with regression tests.
- [x] Document phased readiness, migration prerequisites, untested live integration and exact remaining steps; preserve branch without production deployment.

## Status final desta branch

23 testes automatizados passaram. Typecheck, build Next.js e lint dos arquivos alterados passaram. A revisão encontrou quatro defeitos e todos foram corrigidos com testes de regressão que falharam antes da correção.

A validação visual no navegador e a validação no esquema real do Supabase ainda estão pendentes; não são cobertas pelos checks acima. O lint global permanece com sete erros preexistentes fora deste trabalho. Consulte CRM-FOUNDATION-READINESS.md antes de integrar ou aplicar.

## Continuação: preparação operacional

O status de 23 testes acima registra a primeira entrega. A continuação em `docs/superpowers/plans/2026-11-03-crm-readiness.md` acrescenta histórico legado somente leitura, segurança/preflight/Realtime e envio com identidade durável. Verificação atual: **83/83 testes**, typecheck, build sintético e lint dos arquivos alterados passaram. Foram exercitados fluxos sintéticos no navegador; o script completo e as integrações reais permanecem pendentes. Consulte a versão atual de CRM-FOUNDATION-READINESS.md.
