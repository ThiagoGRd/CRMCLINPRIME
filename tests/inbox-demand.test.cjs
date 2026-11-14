/* eslint-disable @typescript-eslint/no-require-imports -- Source-level test, same style as inbox-route-effect. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../components/inbox/inbox-client.tsx'), 'utf8');

test('Inbox no longer has the AI on/off toggle', () => {
  assert.doesNotMatch(src, /ai_service/);
  assert.doesNotMatch(src, /aiPaused/);
  assert.doesNotMatch(src, /toggleAi/);
});

test('Inbox can turn a conversation or message into a demand', () => {
  assert.match(src, /createTask\(/);
  assert.match(src, /Virar demanda/);
  assert.match(src, /sourceMessageId/);
  assert.match(src, /kind: "demanda"/);
  // a invalidação de tasks/forgotten/patient-tasks agora passa por lib/task-cache.ts (coberto em task-cache.test.ts)
  assert.match(src, /invalidateTaskCaches\(qc, org\.id\)/);
  assert.match(src, /hourCycle: "h23"/);
});
