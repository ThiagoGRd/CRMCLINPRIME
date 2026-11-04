import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { testDatabaseConfig, assertFreshTestDatabase } from './safety.mjs';

const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const load = name => readFile(new URL(name, import.meta.url), 'utf8');
const rpc = async (client, name, args) => (await client.query(
  `select ${name}(${args.map((_, index) => `$${index + 1}`).join(',')}) as result`, args,
)).rows[0].result;
const claim = (client, conversation, request) => rpc(client, 'claim_crm_outbound_request',
  [request, id(11), conversation, id(201), 'Synthetic concurrency message']);
const reconcile = (client, conversation, request, operation) => rpc(client, 'reconcile_crm_outbound_request',
  [request, id(11), conversation, operation, 'Synthetic operator evidence']);

// An operation already returned but remains UNCOMMITTED in the first session.
// The contender must demonstrably wait on that backend before we release it.
// No timing assumption, Promise.all over a shared connection, or test-only SQL
// function replacement can satisfy this barrier.
async function overlap(observer, config, firstOperation, secondOperation, expectedWait) {
  const first = new Client(config);
  const second = new Client(config);
  let contender;
  let transactionOpen = false;
  try {
    await first.connect();
    await second.connect();
    const firstPid = (await first.query('select pg_backend_pid() as pid')).rows[0].pid;
    const secondPid = (await second.query('select pg_backend_pid() as pid')).rows[0].pid;
    assert.notEqual(firstPid, secondPid, 'operations must use independent PostgreSQL backends');
    await first.query('begin');
    transactionOpen = true;
    await first.query('set local role service_role');
    await second.query('set role service_role');
    const winner = await firstOperation(first);
    let settled = false;
    // Attach both handlers immediately, including expected cancellation rejection.
    contender = secondOperation(second).then(
      value => { settled = true; return { value }; },
      error => { settled = true; return { error }; },
    );
    const deadline = Date.now() + 5000;
    let blocked = false;
    while (Date.now() < deadline) {
      const { rows: [activity] } = await observer.query(`select state, wait_event_type, wait_event,
        pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1`, [secondPid]);
      if (activity?.wait_event_type === 'Lock' && activity.blockers.includes(firstPid)) {
        assert.equal(activity.state, 'active');
        assert.equal(activity.wait_event, expectedWait);
        blocked = true;
        break;
      }
      assert.equal(settled, false, 'contender finished without waiting for the uncommitted operation');
      await delay(10);
    }
    assert.equal(blocked, true, 'did not observe a real PostgreSQL lock wait before releasing the winner');
    await first.query('commit');
    transactionOpen = false;
    return { winner, contender: await contender };
  } finally {
    // Release the winner even if the wait assertion fails, then drain the loser.
    if (transactionOpen) await first.query('rollback').catch(() => {});
    await contender;
    await Promise.allSettled([first.end(), second.end()]);
  }
}

// Missing URL/opt-in is a hard failure, never a silent skip that appears green.
test('independent PostgreSQL sessions apply actual migrations and serialize CRM operations', { timeout: 60000 }, async t => {
  const config = testDatabaseConfig();
  const admin = new Client(config);
  await admin.connect();
  t.after(() => admin.end());
  await assertFreshTestDatabase(admin);
  t.diagnostic((await admin.query('select version() as version')).rows[0].version);

  await t.test('preflight refuses occupied schemas, roles, functions, types and publications before fixture DDL', async () => {
    for (const ddl of [
      'create table public.unrelated_data(id integer)',
      'create schema unrelated_schema',
      'create role authenticated',
      'create function public.unrelated_function() returns integer language sql as $$ select 1 $$',
      "create type public.unrelated_type as enum ('existing')",
      'create publication unrelated_publication',
    ]) {
      await admin.query('begin');
      try {
        await admin.query(ddl);
        await assert.rejects(assertFreshTestDatabase(admin), /Refusing occupied PostgreSQL cluster/);
      } finally { await admin.query('rollback'); }
      await assertFreshTestDatabase(admin);
    }
  });

  await admin.query(await load('./fixture.sql'));
  for (const file of [
    '20261103030000_crm_foundation.sql',
    '20261103040000_crm_security_realtime.sql',
    '20261103050000_crm_outbound_requests.sql',
    '20261103060000_crm_outbound_reconciliation.sql',
    '20261103070000_whatsapp_window_templates.sql',
  ]) await admin.query(await load(`../../supabase/migrations/${file}`));
  await admin.query("update channels set inbox_key='reception'");
  const conversation = (await admin.query(`insert into crm_conversations(org_id,patient_id,channel_id)
    values ($1,$2,$3) returning id`, [id(1), id(101), id(201)])).rows[0].id;
  await admin.query(`insert into crm_messages(org_id,patient_id,channel_id,conversation_id,direction,content,created_at)
    values ($1,$2,$3,$4,'inbound','Synthetic inbound',clock_timestamp()-interval '1 hour')`,
  [id(1), id(101), id(201), conversation]);
  const count = async (table, column, value) => (await admin.query(
    `select count(*)::int as n from ${table} where ${column}=$1`, [value],
  )).rows[0].n;

  await t.test('duplicate overlapping claims produce exactly one dispatch permission', async () => {
    const request = id(501);
    const { winner, contender } = await overlap(admin, config,
      client => claim(client, conversation, request), client => claim(client, conversation, request), 'advisory');
    assert.ifError(contender.error);
    assert.equal(winner.claimed, true);
    assert.ok(winner.claim_token);
    assert.equal(contender.value.claimed, false);
    assert.equal(contender.value.claim_token, null);
    assert.equal(contender.value.state, 'in_flight');
    assert.equal(await count('crm_outbound_requests', 'request_id', request), 1);
    assert.equal((await admin.query('select claim_token from crm_outbound_requests where request_id=$1', [request])).rows[0].claim_token, winner.claim_token);
    assert.equal(await count('crm_messages', 'direction', 'outbound'), 0);
  });

  await t.test('cancellation committing first prevents the already-waiting claim of an absent request', async () => {
    const request = id(502);
    const { winner, contender } = await overlap(admin, config,
      client => reconcile(client, conversation, request, 'cancel'), client => claim(client, conversation, request), 'advisory');
    assert.ifError(contender.error);
    assert.equal(winner.state, 'cancelled');
    assert.equal(winner.reconciliation.previous_state, 'not_found');
    assert.equal(contender.value.state, 'cancelled');
    assert.equal(contender.value.claimed, false);
    assert.equal(contender.value.claim_token, null);
    assert.equal(await count('crm_outbound_requests', 'request_id', request), 0);
    assert.equal(await count('crm_outbound_cancellations', 'request_id', request), 1);
    assert.equal(await count('crm_outbound_reconciliations', 'request_id', request), 1);
  });

  await t.test('claim committing first rejects the already-waiting unsafe cancellation without a tombstone', async () => {
    const request = id(503);
    const { winner, contender } = await overlap(admin, config,
      client => claim(client, conversation, request), client => reconcile(client, conversation, request, 'cancel'), 'advisory');
    assert.equal(winner.claimed, true);
    assert.match(contender.error?.message ?? '', /outbound_cancel_unsafe/);
    assert.equal(await count('crm_outbound_cancellations', 'request_id', request), 0);
    assert.equal(await count('crm_outbound_reconciliations', 'request_id', request), 0);
    const row = (await admin.query('select state,claim_token from crm_outbound_requests where request_id=$1', [request])).rows[0];
    assert.equal(row.state, 'in_flight');
    assert.equal(row.claim_token, winner.claim_token);
  });

  await t.test('overlapping worker completions persist one message through the row lock', async () => {
    const request = id(504);
    const claimed = await claim(admin, conversation, request);
    const finish = client => rpc(client, 'complete_crm_outbound_request', [request, claimed.claim_token, 'wamid.synthetic.worker']);
    const { winner, contender } = await overlap(admin, config, finish, finish, 'transactionid');
    assert.ifError(contender.error);
    assert.equal(winner.state, 'sent');
    assert.equal(contender.value.state, 'sent');
    assert.equal(contender.value.message.id, winner.message.id);
    assert.equal(await count('crm_messages', 'whatsapp_message_id', 'wamid.synthetic.worker'), 1);
    const row = (await admin.query('select message_id,state from crm_outbound_requests where request_id=$1', [request])).rows[0];
    assert.deepEqual(row, { message_id: winner.message.id, state: 'sent' });
  });

  await t.test('overlapping operator finalizations reuse one message and retain each audit entry', async () => {
    const request = id(505);
    const claimed = await claim(admin, conversation, request);
    await rpc(admin, 'finish_crm_outbound_request', [request, claimed.claim_token, 'uncertain', 'storage_failed', 'wamid.synthetic.recovered']);
    const finalize = client => reconcile(client, conversation, request, 'finalize');
    const { winner, contender } = await overlap(admin, config, finalize, finalize, 'advisory');
    assert.ifError(contender.error);
    assert.equal(winner.state, 'sent');
    assert.equal(contender.value.state, 'sent');
    assert.equal(contender.value.message.id, winner.message.id);
    assert.equal(winner.reconciliation.previous_state, 'uncertain');
    assert.equal(contender.value.reconciliation.previous_state, 'sent');
    assert.notEqual(winner.reconciliation.id, contender.value.reconciliation.id);
    assert.equal(await count('crm_messages', 'whatsapp_message_id', 'wamid.synthetic.recovered'), 1);
    assert.equal(await count('crm_outbound_reconciliations', 'request_id', request), 2);
  });

  await t.test('overlapping first contact with equivalent phone formats creates one patient and one deal', async () => {
    const { winner, contender } = await overlap(admin, config,
      client => rpc(client, 'ensure_whatsapp_patient', [id(1), '82991112222', 'Synthetic first contact']),
      client => rpc(client, 'ensure_whatsapp_patient', [id(1), '(82) 99111-2222', 'Duplicate webhook']), 'advisory');
    assert.ifError(contender.error);
    assert.equal(contender.value, winner);
    assert.equal((await admin.query("select count(*)::int as n from crm_patients where org_id=$1 and phone_canon(phone)='8291112222'", [id(1)])).rows[0].n, 1);
    assert.equal(await count('crm_deals', 'patient_id', winner), 1);
    assert.equal((await admin.query('select name from crm_patients where id=$1', [winner])).rows[0].name, 'Synthetic first contact');
  });
});
