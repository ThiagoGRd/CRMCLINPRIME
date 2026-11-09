import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { moveLeadStage } from '../lib/funil-move.ts';
const lead = {
    id: 'patient-a', name: 'Paciente A', phone: '', source: 'Teste', channel: null,
    notes: null, tags: [], createdAt: '2026-11-01T00:00:00Z', stageId: 'stage-a',
    dealId: 'deal-a', ccStatus: null, ccAmount: 0, ccCount: 0,
};
function response(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function setup(fetch, initialLeads = [lead]) {
    let leads = initialLeads;
    const client = createClient('http://localhost:54321', 'synthetic-key', {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch },
    });
    const pendingMoves = new Set();
    const setLeads = (update) => { leads = update(leads); };
    return {
        client, pendingMoves, setLeads,
        get leads() { return leads; },
        move(movingLead = lead, targetStageId = 'stage-b') {
            return moveLeadStage({ client, lead: movingLead, targetStageId, orgId: 'org-a', pendingMoves, setLeads });
        },
    };
}
function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}
test('a confirmed update scopes the deal to its organization and keeps the optimistic stage', async () => {
    const requests = [];
    const state = setup(async (input, init) => {
        requests.push({ url: new URL(String(input)), init });
        return response({ id: 'deal-a' });
    });
    const move = state.move();
    assert.equal(state.leads[0].stageId, 'stage-b');
    assert.equal((await move).status, 'moved');
    assert.equal(requests.length, 1);
    const { url, init } = requests[0];
    assert.equal(init?.method, 'PATCH');
    assert.equal(url.searchParams.get('id'), 'eq.deal-a');
    assert.equal(url.searchParams.get('org_id'), 'eq.org-a');
    assert.equal(url.searchParams.get('select'), 'id');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.stage_id, 'stage-b');
    assert.equal(Number.isNaN(Date.parse(payload.moved_at)), false);
    assert.equal(state.leads[0].stageId, 'stage-b');
    assert.equal(state.pendingMoves.size, 0);
});
test('a returned Supabase update error rolls back instead of reporting success', async () => {
    const state = setup(async () => response({ code: '42501', message: 'Access denied', details: null, hint: null }, 403));
    assert.equal((await state.move()).status, 'failed');
    assert.equal(state.leads[0].stageId, 'stage-a');
    assert.equal(state.pendingMoves.size, 0);
});
test('an update with no confirmed row cannot report success', async () => {
    const state = setup(async () => response(null));
    assert.equal((await state.move()).status, 'failed');
    assert.equal(state.leads[0].stageId, 'stage-a');
});
test('a thrown persistence failure rolls back and releases the pending guard', async () => {
    const state = setup(async () => response({ id: 'deal-a' }));
    const client = { from() { throw new Error('Client unavailable'); } };
    const result = await moveLeadStage({ ...state, client, lead, targetStageId: 'stage-b', orgId: 'org-a' });
    assert.equal(result.status, 'failed');
    assert.equal(state.leads[0].stageId, 'stage-a');
    assert.equal(state.pendingMoves.size, 0);
});
test('a newly inserted deal is confirmed before retaining its identifier', async () => {
    const newLead = { ...lead, dealId: null, stageId: null };
    const requests = [];
    const state = setup(async (_input, init) => {
        requests.push(init);
        return response({ id: 'deal-new' }, 201);
    }, [newLead]);
    assert.equal((await state.move(newLead)).status, 'moved');
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, 'POST');
    const payload = JSON.parse(String(requests[0]?.body));
    assert.equal(payload.patient_id, 'patient-a');
    assert.equal(payload.org_id, 'org-a');
    assert.equal(payload.stage_id, 'stage-b');
    assert.equal(state.leads[0].dealId, 'deal-new');
    assert.equal(state.leads[0].stageId, 'stage-b');
});
for (const [name, data, status] of [
    ['returned insert error', { code: '42501', message: 'Access denied', details: null, hint: null }, 403],
    ['missing inserted row', null, 201],
    ['missing inserted identifier', {}, 201],
]) {
    test(`${name} restores an unassigned lead without fabricating a deal`, async () => {
        const newLead = { ...lead, dealId: null, stageId: null };
        const state = setup(async () => response(data, status), [newLead]);
        assert.equal((await state.move(newLead)).status, 'failed');
        assert.equal(state.leads[0].stageId, null);
        assert.equal(state.leads[0].dealId, null);
    });
}
test('late rollback preserves another lead move and unrelated edits to the failed lead', async () => {
    const failedResponse = deferred();
    const otherLead = { ...lead, id: 'patient-b', dealId: 'deal-b' };
    const state = setup(async (input) => new URL(String(input)).searchParams.get('id') === 'eq.deal-a'
        ? failedResponse.promise : response({ id: 'deal-b' }), [lead, otherLead]);
    const firstMove = state.move();
    await state.move(otherLead, 'stage-c');
    state.setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, notes: 'Updated while moving' } : item));
    failedResponse.resolve(response({ code: '42501', message: 'Access denied', details: null, hint: null }, 403));
    assert.equal((await firstMove).status, 'failed');
    assert.equal(state.leads[0].stageId, 'stage-a');
    assert.equal(state.leads[0].notes, 'Updated while moving');
    assert.equal(state.leads[1].stageId, 'stage-c');
});
test('late rollback does not overwrite a newer stage received from elsewhere', async () => {
    const failedResponse = deferred();
    const state = setup(async () => failedResponse.promise);
    const move = state.move();
    state.setLeads((current) => current.map((item) => ({ ...item, stageId: 'stage-c' })));
    failedResponse.resolve(response({ code: '42501', message: 'Access denied', details: null, hint: null }, 403));
    await move;
    assert.equal(state.leads[0].stageId, 'stage-c');
});
test('a second drag of the same lead waits for its first write and a failed write can be retried', async () => {
    const firstResponse = deferred();
    let requests = 0;
    const state = setup(async () => ++requests === 1 ? firstResponse.promise : response({ id: 'deal-a' }));
    const firstMove = state.move();
    assert.equal((await state.move(state.leads[0], 'stage-c')).status, 'pending');
    assert.equal(state.leads[0].stageId, 'stage-b');
    firstResponse.resolve(response({ code: '42501', message: 'Access denied', details: null, hint: null }, 403));
    await firstMove;
    assert.equal((await state.move(state.leads[0], 'stage-c')).status, 'moved');
    assert.equal(state.leads[0].stageId, 'stage-c');
    assert.equal(requests, 2);
});
