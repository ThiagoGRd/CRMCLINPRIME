# Synthetic UI fixture

This fixture bundles the real Inbox and pending-item components and the real
Supabase browser client, using a local HTTP server with synthetic records only.
It does not read environment files or send messages to WhatsApp.

Optional tools (kept outside the application dependencies):

```sh
npm install --prefix /tmp/crm-ui-tools esbuild playwright
CRM_BROWSER_TOOLS=/tmp/crm-ui-tools/node_modules CHROMIUM_PATH=/usr/bin/chromium node tests/browser/run.mjs
```

The script covers sector separation, an explicit send route, switching
conversations while delivery is pending, creating an item without a description,
reloading, evidence-backed resolution, disabled disconnected channels and an
ambiguous patient link. It saves a synthetic screenshot under
/tmp/crm-browser-output when successful.

For manual inspection, set CRM_BROWSER_SERVE_ONLY=1. The printed localhost URL is
accessible only from the same execution environment. Ctrl-C ends the fixture.

**Execution status:** bundling succeeded; browser launch was blocked by the
execution environment's local socket restriction. No browser pass or screenshot
has been claimed. Run these checks in a normal development environment before
staging sign-off.
