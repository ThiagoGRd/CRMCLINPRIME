import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPendingCreate, buildPendingUpdate, buildPendingResolution, pendingListScope } from '../lib/pending-items.ts';

const draft = { title: ' Retornar orçamento ', description: ' Combinar retorno ', assigned_to: 'member-a', due_at: '2026-11-04T12:00:00Z', status: 'open' };
const members = ['member-a'];
test('creation stores patient, conversation, organization and normalized required fields', () => {
  assert.deepEqual(buildPendingCreate('org-a', 'patient-a', 'conversation-a', draft, members), { org_id: 'org-a', patient_id: 'patient-a', conversation_id: 'conversation-a', title: 'Retornar orçamento', description: 'Combinar retorno', assigned_to: 'member-a', due_at: '2026-11-04T12:00:00.000Z', status: 'open' });
});
test('creation rejects absent required fields and assignment outside the organization', () => {
  for (const patch of [{title: ' '}, {assigned_to: ''}, {assigned_to: 'outsider'}, {due_at: ''}, {due_at: 'invalid'}, {status: 'resolved'}]) {
    assert.throws(() => buildPendingCreate('org-a', 'patient-a', 'conversation-a', {...draft, ...patch}, members));
  }
  assert.throws(() => buildPendingCreate('org-a', '', 'conversation-a', draft, members));
});
test('ordinary updates cannot resolve and only send responsible, deadline and nonresolved status', () => {
  assert.deepEqual(buildPendingUpdate({...draft, status: 'in_progress'}, members), { assigned_to: 'member-a', due_at: '2026-11-04T12:00:00.000Z', status: 'in_progress' });
  assert.throws(() => buildPendingUpdate({...draft, status:'resolved'}, members));
});
test('manual resolution requires evidence and produces only the resolution RPC arguments', () => {
  assert.throws(() => buildPendingResolution('item-a', '  '));
  assert.deepEqual(buildPendingResolution('item-a', ' Paciente confirmou o agendamento. '), {p_id:'item-a', p_evidence:'Paciente confirmou o agendamento.'});
});
test('durable list selection is org-scoped and independent of message activity', () => {
  assert.deepEqual(pendingListScope('org-a'), {queryKey:['pending-items', 'org-a', null, null, 'active', 0], orgId:'org-a', patientId:null, conversationId:null, statuses:['open','in_progress'], from:0, to:49});
  assert.notDeepEqual(pendingListScope('org-a'), pendingListScope('org-b'));
  assert.deepEqual(pendingListScope('org-a', 'patient-a', 'conversation-a', 'resolved', 1).statuses, ['resolved']);
  assert.equal(pendingListScope('org-a', 'patient-a', 'conversation-a', 'resolved', 1).from, 50);
});
test('creation accepts the database title boundary and rejects titles longer than 200 characters', () => {
  const payload = buildPendingCreate('org-a', 'patient-a', 'conversation-a', {...draft, title:'a'.repeat(200)}, members);
  assert.equal(payload.title.length, 200);
  assert.throws(() => buildPendingCreate('org-a', 'patient-a', 'conversation-a', {...draft, title:'a'.repeat(201)}, members));
});
