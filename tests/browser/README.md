# Synthetic UI fixture

The fixture bundles the real Inbox, start-conversation dialog, template picker,
operator-review panel, pending-item and legacy-history components.
Queries and function invocations use the real Supabase browser client and a local
HTTP server. Only `auth.getSession` is adapted to an in-memory synthetic user.
The fixture never reads environment files, signs in to Supabase, contacts a real
provider or sends a WhatsApp message. Synthetic tokens are not credentials.

## Local checks without browser automation

Run the HTTP fixture checks with the application's installed dependencies:

```sh
node --test tests/browser/fixture-contract.test.mjs
```

These exercise the real Supabase HTTP request builder against a localhost server.
They verify UUID send identity, matching responses, status-only queries, uncertain
transport, loss before claim, scoped ledger/audit reads, legacy null filtering and
pagination, name/phone search, escaped `ilike`, `single`/`maybeSingle`, insertion,
route reuse, concurrent insert recovery and lost-insert-response recovery. The
real `openConversation` and patient-search helpers use the installed Supabase
client over HTTP, not a fluent-client mock.

Template checks exercise read-only catalogs/windows, explicit template payloads,
preview integrity, expired-window free-text rejection and message-kind/provider-ID
ledger fields. Operator checks cover successful audit acknowledgement with an
unchanged uncertain state, local finalization and cancellation without transport.
The fixture imports the real pure route, policy and outbound-response helpers.
It does **not** execute the Edge handlers or SQL; its in-memory reconciliation,
uniqueness and window gating are test scaffolding, not evidence about production
atomicity, RLS, authorization or provider behavior. The production suites remain
`npm test`.

The optional bundler is kept outside application dependencies:

```sh
npm install --prefix /tmp/crm-ui-tools esbuild
CRM_BROWSER_TOOLS=/tmp/crm-ui-tools/node_modules CRM_BROWSER_BUILD_ONLY=1 node tests/browser/run.mjs
```

`BUILD_ONLY` creates `/tmp/crm-browser-output/app.js` and `style.css`, without
starting a browser or importing Playwright. `CRM_BROWSER_OUTPUT` overrides that
output directory. In this workspace an existing esbuild is available under
`/workspace/shared/crm-preview/node_modules`.

## Manual CUA inspection

Where browser policy requires CUA, use only serve mode and inspect the printed
URL through the approved browser tool:

```sh
CRM_BROWSER_TOOLS=/tmp/crm-ui-tools/node_modules CRM_BROWSER_SERVE_ONLY=1 node tests/browser/run.mjs
```

The printed localhost URL is available only from the same execution environment.
Set `CRM_BROWSER_PORT` for a fixed port; otherwise the server chooses a free one.
Ctrl-C ends the fixture. Serve mode does not require or import Playwright.
A read-only `/__fixture__/state` endpoint exposes synthetic send counts, status
lookups, outbound rows, audit records, cancellations, conversation/pending records,
request payloads and fixture errors for verification.
No production data is present in this endpoint.

The initial delivery scenario is selectable before starting the server:

- `CRM_BROWSER_SCENARIO=success` (default): confirm a synthetic message.
- `CRM_BROWSER_SCENARIO=uncertain-after-claim`: the first send creates an
  uncertain server row and drops the response. Querying its status never sends.
- `CRM_BROWSER_SCENARIO=drop-before-claim`: the first send loses the network
  connection before any outbound row or simulated provider delivery exists.
  Reload must recover its browser marker and keep sending blocked, even though
  the server returns `not_found`. Later sends default to success.
- `CRM_BROWSER_SCENARIO=accepted-before-storage`: the simulated provider accepts
  once, but the CRM message is not yet saved. The operator can finalize it locally.

The default fixture has a one-hour-old inbound in each seeded conversation, based
on startup time rather than a fixed date. Use `CRM_BROWSER_WINDOW=expired` for a
25-hour-old inbound and a template-only UI. All routing/database identities are
synthetic UUIDs in `fixture-identities.ts`. Maria Teste has three routed
conversations; João Sintético has none initially and is available in patient search.
The synthetic catalog contains one text template, `retorno_sintetico · pt_BR`,
with one body variable. No catalog request contacts Meta.

Manual checks:

1. Choose Recepção and Maria Teste. Send a synthetic response, switch to Comercial
   before it finishes, and verify the response stays in the original history.
2. Create a pending item without a description. Reload and resolve it only after
   entering evidence. Confirm CRC's disconnected channel cannot send.
3. Use each failure scenario. Check “Consultar tentativa” emits only
   `{request_id, action: "status"}` and never increases the simulated send count.
4. With `drop-before-claim`, reload the same conversation. Verify recovery blocks
   sending even a different draft. Its localStorage key contains organization,
   authenticated user and request identity; the value has only `request_id`,
   `conversation_id`, `channel_id`, `created_at`, never text or patient details.
5. Open “Consultar histórico antigo sem canal”. Check its 41 synthetic legacy
   rows paginate 40/1, routed and partially routed records never appear, no send
   control exists, and Back/Forward returns to the correct page.
6. Use “Abrir conversa”, find João Sintético by name or phone, select Recepção,
   then Cancel. Reopen and check the selection reset. Open the conversation and
   repeat: only one route is created, no send occurs, and free text stays blocked
   because João has no inbound. Opening a disconnected CRC route is also allowed
   to organize work, but sending remains blocked.
7. Open “Templates aprovados” in João's conversation or an expired-window fixture.
   Select the approved template, fill its variable and inspect the rendered preview.
   “Voltar” must not send. Confirming sends an explicit `kind: "template"` request,
   not free text; it does not open the free-text window.
8. In `uncertain-after-claim`, use “Conferir tentativa”, supply evidence and register
   an observation. The dialog closes and the audit appears, but delivery remains
   uncertain and the duplicate draft stays blocked. Unsafe cancellation/finalization
   must fail without adding another transport.
9. In `accepted-before-storage`, finalize after entering evidence. The message
   appears once and the simulated send count stays one. In `drop-before-claim`,
   cancel the recovered marker after entering evidence. Reload and verify the
   cancellation stays terminal with no transport.
10. Repeat narrow/mobile viewport inspection; the fixture provides a viewport
   meta tag. Realtime is not emulated, so local websocket connection errors are
   expected and realtime delivery itself is not part of this fixture's coverage.

## Optional automated runner

On a normal developer machine where direct Playwright is allowed:

```sh
npm install --prefix /tmp/crm-ui-tools esbuild playwright
CRM_BROWSER_TOOLS=/tmp/crm-ui-tools/node_modules CHROMIUM_PATH=/usr/bin/chromium node tests/browser/run.mjs
```

The standard script covers sector separation, UUID send routing, late response
isolation, durable pending items, evidence-only resolution, disconnected channels,
ambiguous patient links, uncertain delivery, duplicate protection, status-only
lookups, metadata-only reload-before-claim protection and legacy page navigation,
pagination and read-only behavior. `operator-scenarios.mjs` additionally covers
open/cancel/reopen/reuse, no-inbound template policy, preview dismissal, explicit
template serialization, audit evidence, observation, accepted-send finalization
and absent-request cancellation/reload. The automated suite manages its own
failure modes and requires the default `success`/`open` settings. Successful runs
save synthetic screenshots in `/tmp/crm-browser-output`.

**Verification status:** 27 HTTP boundary tests, build-only bundling, syntax checks,
typechecking and fixture lint were run successfully. The automated browser runner
was not executed in this environment,
where browser operation must use CUA. No automated browser pass or new screenshot
is claimed by those checks. Any separate manual CUA results must be reported
independently. The synthetic server does not prove production RLS, authentication,
realtime or WhatsApp integration; run the database/edge suites and staging QA too.
