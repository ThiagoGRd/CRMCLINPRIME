# Synthetic UI fixture

The fixture bundles the real Inbox, pending-item and legacy-history components.
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
They verify the UUID send contract, matching response identity, status-only
no-send behavior, uncertain transport, loss before claim, scoped outbound reads
and legacy null filtering/pagination. They validate the test boundary, not the
production database or browser UI. The production suites remain `npm test`.

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
lookups, outbound rows, request payloads and fixture errors for verification.
No production data is present in this endpoint.

The initial delivery scenario is selectable before starting the server:

- `CRM_BROWSER_SCENARIO=success` (default): confirm a synthetic message.
- `CRM_BROWSER_SCENARIO=uncertain-after-claim`: the first send creates an
  uncertain server row and drops the response. Querying its status never sends.
- `CRM_BROWSER_SCENARIO=drop-before-claim`: the first send loses the network
  connection before any outbound row or simulated provider delivery exists.
  Reload must recover its browser marker and keep sending blocked, even though
  the server returns `not_found`. Later sends default to success.

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
6. Repeat narrow/mobile viewport inspection; the fixture provides a viewport
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
pagination and read-only behavior. Successful runs save synthetic screenshots in
`/tmp/crm-browser-output`.

**Verification status:** HTTP boundary tests, bundling and typechecking were run
successfully. The automated browser runner was not executed in this environment,
where browser operation must use CUA. No automated browser pass or new screenshot
is claimed by those checks. Any separate manual CUA results must be reported
independently. The synthetic server does not prove production RLS, authentication,
realtime or WhatsApp integration; run the database/edge suites and staging QA too.
