import test from 'node:test';
import assert from 'node:assert/strict';
import * as inbox from '../lib/inbox.ts';

const rows = [
  { id: 'reception-a', patient_id: 'patient-a', channel_id: 'number-r', inbox_key: 'reception', name: 'Maria', phone: '11911112222' },
  { id: 'commercial-a', patient_id: 'patient-a', channel_id: 'number-c', inbox_key: 'commercial', name: 'Maria', phone: '11911112222' },
  { id: 'crc-b', patient_id: 'patient-b', channel_id: 'number-crc', inbox_key: 'crc', name: 'João', phone: '11933334444' },
  { id: 'unknown-a', patient_id: 'patient-a', channel_id: 'number-u', inbox_key: null, name: 'Maria', phone: '11911112222' },
];

test('sector selection never merges two conversations for the same patient', () => {
  assert.equal(typeof inbox.filterConversations, 'function');
  assert.deepEqual(inbox.filterConversations(rows, 'reception', 'all', '').map(r => r.id), ['reception-a']);
  assert.deepEqual(inbox.filterConversations(rows, 'commercial', 'all', '').map(r => r.id), ['commercial-a']);
});

test('number and patient searches are confined to the selected sector', () => {
  assert.deepEqual(inbox.filterConversations(rows, 'reception', 'number-c', 'Maria'), []);
  assert.deepEqual(inbox.filterConversations(rows, 'crc', 'all', '3333').map(r => r.id), ['crc-b']);
});

test('legacy patient link refuses to choose an arbitrary conversation', () => {
  assert.equal(typeof inbox.conversationFromLink, 'function');
  assert.equal(inbox.conversationFromLink(rows, null, 'patient-a'), null);
  assert.equal(inbox.conversationFromLink(rows, null, 'patient-b'), 'crc-b');
  assert.equal(inbox.conversationFromLink(rows, 'commercial-a', 'patient-a'), 'commercial-a');
  assert.equal(inbox.conversationFromLink(rows, 'invalid', 'patient-b'), null);
});

test('new, repeated and late messages only appear in their exact conversation', () => {
  assert.equal(typeof inbox.mergeConversationMessage, 'function');
  const m = { id: 'm-1', conversation_id: 'reception-a', channel_id: 'number-r', created_at: '2026-11-01T09:00:00Z' };
  assert.deepEqual(inbox.mergeConversationMessage([], m, 'commercial-a'), []);
  assert.deepEqual(inbox.mergeConversationMessage([], m, 'reception-a'), [m]);
  assert.deepEqual(inbox.mergeConversationMessage([m], m, 'reception-a'), [m]);
  const earlier = {...m, id: 'm-0', created_at: '2026-11-01T08:00:00Z'};
  assert.deepEqual(inbox.mergeConversationMessage([m], earlier, 'reception-a').map(r => r.id), ['m-0', 'm-1']);
});

test('failed sends restore only the originating draft without overwriting newer text', () => {
  assert.equal(typeof inbox.restoreFailedDraft, 'function');
  assert.deepEqual(inbox.restoreFailedDraft({'commercial-a': 'New conversation'}, 'reception-a', 'Original'), {'commercial-a': 'New conversation', 'reception-a': 'Original'});
  assert.deepEqual(inbox.restoreFailedDraft({'reception-a': 'Newer'}, 'reception-a', 'Original'), {'reception-a': 'Newer'});
});

test('new conversation URLs and back navigation supersede an earlier manual selection', () => {
  assert.equal(typeof inbox.resolveInboxSelection, 'function');
  const selected = {id:'reception-a',sector:'reception' as const,linkKey:'old'};
  assert.deepEqual(inbox.resolveInboxSelection(rows, selected, 'new', 'commercial-a', null), {id:'commercial-a',sector:'commercial'});
  assert.deepEqual(inbox.resolveInboxSelection(rows, selected, 'old', 'commercial-a', null), {id:'reception-a',sector:'reception'});
  assert.deepEqual(inbox.resolveInboxSelection(rows, selected, 'patient-link', null, 'patient-a'), {id:null,sector:'reception'});
});
