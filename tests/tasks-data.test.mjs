import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { listOpenTasks, completeTask, snoozeTask } from '../lib/tasks-data.ts';

function response(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function setup(reply) {
    const requests = [];
    const client = createClient('http://localhost:54321', 'synthetic-key', {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: async (input, init) => { requests.push({ url: new URL(String(input)), init }); return reply(); } },
    });
    return { client, requests };
}
const row = {
    id: 't1', patient_id: 'p1', patients: { name: 'Ana', phone: '5511' }, front: 'recepcao', kind: 'demanda',
    title: 'x', owner_id: null, due_at: '2026-11-14T18:00:00Z', status: 'aberta', draft: null,
};

test('listOpenTasks filtra pela organização e só abertas', async () => {
    const { client, requests } = setup(() => response([row]));
    const tasks = await listOpenTasks(client, 'org-a');
    const { url } = requests[0];
    assert.equal(url.searchParams.get('org_id'), 'eq.org-a');
    assert.equal(url.searchParams.get('status'), 'eq.aberta');
    assert.deepEqual(tasks, [{
        id: 't1', patientId: 'p1', patientName: 'Ana', patientPhone: '5511', front: 'recepcao', kind: 'demanda',
        title: 'x', ownerId: null, dueAt: '2026-11-14T18:00:00Z', status: 'aberta', draft: null,
    }]);
});

test('listOpenTasks não quebra quando o paciente veio nulo', async () => {
    const { client } = setup(() => response([{ ...row, patients: null }]));
    const [task] = await listOpenTasks(client, 'org-a');
    assert.equal(task.patientName, '');
    assert.equal(task.patientPhone, '');
});

test('completeTask chama a rpc com os seis parâmetros', async () => {
    const { client, requests } = setup(() => response(null, 200));
    await completeTask(client, { taskId: 't1', outcome: 'ligou', nextTitle: '', nextDue: '', nextFront: null, closeReason: 'sem interesse' });
    const { url, init } = requests[0];
    assert.equal(init.method, 'POST');
    assert.equal(url.pathname, '/rest/v1/rpc/complete_task');
    assert.deepEqual(JSON.parse(String(init.body)), {
        p_task: 't1', p_outcome: 'ligou', p_next_title: null, p_next_due: null, p_next_front: null, p_close_reason: 'sem interesse',
    });
});

test('completeTask traduz tarefa_ja_concluida', async () => {
    const { client } = setup(() => response({ message: 'tarefa_ja_concluida' }, 400));
    await assert.rejects(
        completeTask(client, { taskId: 't1', outcome: 'x', nextTitle: 'y', nextDue: '2026-12-01T10:00:00Z', nextFront: 'comercial', closeReason: '' }),
        { message: 'Outra pessoa já concluiu esta tarefa.' },
    );
});

test('snoozeTask grava novo prazo e soma o contador', async () => {
    const { client, requests } = setup(() => new Response(null, { status: 204 }));
    await snoozeTask(client, { taskId: 't1', orgId: 'org-a', dueAt: new Date('2026-11-15T12:00:00Z'), snoozeCount: 2 });
    const { url, init } = requests[0];
    assert.equal(init.method, 'PATCH');
    assert.equal(url.searchParams.get('id'), 'eq.t1');
    assert.equal(url.searchParams.get('org_id'), 'eq.org-a');
    assert.deepEqual(JSON.parse(String(init.body)), { due_at: '2026-11-15T12:00:00.000Z', snooze_count: 3 });
});
