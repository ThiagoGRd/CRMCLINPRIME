# CRM Operator Workflows

**Goal:** Safely reconcile uncertain outbound attempts and enforce WhatsApp sending policy without touching production.
**Architecture:** Preserve per-UUID at-most-once dispatch. Add auditable admin-only recovery RPCs; cancellation must serialize with the original claim. Treat the service window per conversation/channel and validate approved template metadata at the server.
**Constraints:** Synthetic data/provider boundaries only; same draft branch, no merge/deploy/migrations applied, no agents or credentials.

## Tasks
- [x] Audited recovery backend: finalize only recorded provider acceptance, cancel only absent/unclaimed intent with a durable tombstone, observations do not erase uncertainty.
- [x] Operator UI: explicit evidence, action explanation, confirmation and immutable audit history; late results remain scoped to their original conversation.
- [x] 24-hour guard and text-only approved-template workflow where feasible, fail closed on unknown metadata and unsupported template shapes.
- [x] Synthetic tests for roles/tenant boundaries, cancel-claim races, late acceptance, time boundaries, template binding and replay.
- [x] Independent review, regression fixes, full checks, safe preview/branch update and remote verification.

## Safety choices
Human observations do not manufacture proof of provider delivery. Unknown claimed attempts cannot be cancelled as if they never happened. A cancellation of an absent UUID is a server-side tombstone, not deletion of a local marker. No recovery action automatically sends a message.

Implementation and independent review are complete. Final source/remote publication verification is recorded in the PR. Live schema/provider validation and verified legacy AI control remain staging gates, not completed integration claims.
