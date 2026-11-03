import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import {
  LEGACY_PAGE_SIZE,
  legacyPageRange,
  fetchLegacyPatients,
  fetchLegacyPatient,
  fetchLegacyMessages,
} from '../lib/legacy-history.ts';

type FixtureRow = Record<string, string | null>;
const patients: FixtureRow[] = [
  {id: 'patient-a', org_id: 'org-a', name: 'Ana Teste', phone: '11911112222'},
  {id: 'patient-b', org_id: 'org-a', name: 'Bruno Teste', phone: '11933334444'},
  {id: 'patient-other', org_id: 'org-b', name: 'Ana Outra', phone: '11911112222'},
];
const message = (id: string, extra: Partial<FixtureRow> = {}): FixtureRow => ({
  id, org_id: 'org-a', patient_id: 'patient-a', channel_id: null, conversation_id: null,
  direction: 'inbound', content: `Texto ${id}`, created_at: '2026-11-01T10:00:00Z',
  ...extra,
} as FixtureRow);

function fixture(messages: FixtureRow[] = [], failure: boolean | {code: string; status: number} = false) {
  const requests: URL[] = [];
  const client = createClient('https://synthetic.invalid', 'synthetic-test-key', {
    auth: {persistSession: false, autoRefreshToken: false},
    global: {fetch: async (input, init) => {
      assert.equal(init?.method, 'GET', 'legacy history must only read');
      const url = new URL(String(input));
      requests.push(url);
      if (failure) return new Response(JSON.stringify({message: 'synthetic read failure', code: typeof failure === 'object' ? failure.code : 'SYNTHETIC'}), {status: typeof failure === 'object' ? failure.status : 500});
      let rows = (url.pathname.endsWith('/crm_patients') ? patients : messages).filter(row =>
        [...url.searchParams].every(([key, value]) => {
          if (value.startsWith('eq.')) return row[key] === value.slice(3);
          if (value === 'is.null') return row[key] === null;
          return true;
        })
      );
      for (const order of (url.searchParams.get('order') ?? '').split(',').reverse()) {
        const [column, direction] = order.split('.');
        rows = [...rows].sort((a, b) => {
          if (a[column] === null) return b[column] === null ? 0 : 1;
          if (b[column] === null) return -1;
          return String(a[column]).localeCompare(String(b[column])) * (direction === 'desc' ? -1 : 1);
        });
      }
      const total = rows.length;
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      // PostgREST returns an error, not an empty successful page, past an exact count.
      if (offset > 0 && offset >= total) return new Response(JSON.stringify({
        code: 'PGRST103', message: 'Requested range not satisfiable',
        details: `An offset of ${offset} was requested, but there are only ${total} rows.`, hint: null,
      }), {status: 416, headers: {'content-type': 'application/json', 'content-range': `*/${total}`}});
      return new Response(JSON.stringify(rows.slice(offset, offset + limit)), {
        headers: {'content-type': 'application/json', 'content-range': `${offset}-${offset + limit - 1}/${total}`},
      });
    }},
  });
  return {client, requests};
}

test('legacy history reads only unknown-channel unassigned messages for the exact org and patient', async () => {
  const {client, requests} = fixture([
    message('legacy'), message('wrong-org', {org_id: 'org-b'}),
    message('wrong-patient', {patient_id: 'patient-b'}),
    message('known-channel', {channel_id: 'channel-a'}),
    message('blank-channel', {channel_id: ''}),
    message('assigned', {channel_id: 'channel-a', conversation_id: 'conversation-a'}),
    message('inconsistent', {conversation_id: 'conversation-a'}),
  ]);
  const result = await fetchLegacyMessages(client, {orgId: 'org-a', patientId: 'patient-a', page: 0});
  assert.deepEqual(result.rows.map(row => row.id), ['legacy']);
  assert.equal(result.total, 1);
  assert.equal(requests[0].searchParams.get('org_id'), 'eq.org-a');
  assert.equal(requests[0].searchParams.get('patient_id'), 'eq.patient-a');
  assert.equal(requests[0].searchParams.get('channel_id'), 'is.null');
  assert.equal(requests[0].searchParams.get('conversation_id'), 'is.null');
});

test('legacy message pages use chronological order with an id tie-breaker and bounded ranges', async () => {
  const records = Array.from({length: LEGACY_PAGE_SIZE + 2}, (_, i) => message(`m-${String(i).padStart(3, '0')}`)).reverse();
  records.push(message('later', {created_at: '2026-11-02T10:00:00Z'}));
  records.push(message('undated', {created_at: null}));
  const {client, requests} = fixture(records);
  const first = await fetchLegacyMessages(client, {orgId: 'org-a', patientId: 'patient-a', page: 0});
  const second = await fetchLegacyMessages(client, {orgId: 'org-a', patientId: 'patient-a', page: 1});
  assert.equal(first.rows.length, LEGACY_PAGE_SIZE);
  assert.equal(first.rows[0].id, 'm-000');
  assert.deepEqual(second.rows.map(row => row.id), ['m-040', 'm-041', 'later', 'undated']);
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, records.length);
  assert.equal(requests[0].searchParams.get('order'), 'created_at.asc.nullslast,id.asc');
  assert.equal(requests[1].searchParams.get('offset'), String(LEGACY_PAGE_SIZE));
  assert.equal(requests[1].searchParams.get('limit'), String(LEGACY_PAGE_SIZE));
});

test('page bounds normalize unsafe input and recover from PostgREST 416 after rows disappear', async () => {
  for (const input of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(legacyPageRange(input), {page: 0, from: 0, to: LEGACY_PAGE_SIZE - 1});
  }
  assert.deepEqual(legacyPageRange(2), {page: 2, from: 80, to: 119});
  const {client, requests} = fixture([message('legacy')]);
  const result = await fetchLegacyMessages(client, {orgId: 'org-a', patientId: 'patient-a', page: 20});
  assert.equal(result.page, 0);
  assert.deepEqual(result.rows.map(row => row.id), ['legacy']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(url => url.searchParams.get('offset')), ['800', '0']);
  assert.equal(requests[1].searchParams.get('org_id'), 'eq.org-a');
  assert.equal(requests[1].searchParams.get('patient_id'), 'eq.patient-a');
  assert.equal(requests[1].searchParams.get('channel_id'), 'is.null');
  const cleared = fixture();
  assert.deepEqual(await fetchLegacyMessages(cleared.client, {orgId: 'org-a', patientId: 'patient-a', page: 1}), {rows: [], total: 0, page: 0});
  assert.equal(cleared.requests.length, 2);
  const patientList = fixture();
  assert.deepEqual((await fetchLegacyPatients(patientList.client, {orgId: 'org-a', search: '', page: 1})).rows.map(row => row.id), ['patient-a', 'patient-b']);
  assert.equal(patientList.requests.length, 2);
  const empty = await fetchLegacyMessages(fixture().client, {orgId: 'org-a', patientId: 'patient-a', page: 0});
  assert.deepEqual(empty, {rows: [], total: 0, page: 0});
});

test('patient search stays organization-scoped, paginated, and cannot inject PostgREST filters', async () => {
  const {client, requests} = fixture();
  const all = await fetchLegacyPatients(client, {orgId: 'org-a', page: 0, search: ''});
  assert.deepEqual(all.rows.map(row => row.id), ['patient-a', 'patient-b']);
  await fetchLegacyPatients(client, {orgId: 'org-a', page: 0, search: '  Ana  '});
  assert.equal(requests[1].searchParams.get('or'), '(name.ilike.*Ana*,phone.ilike.*Ana*)');
  await fetchLegacyPatients(client, {orgId: 'org-a', page: 0, search: 'Ana),org_id.neq.org-a,phone.ilike.*'});
  const injected = requests[2].searchParams;
  assert.equal(injected.get('org_id'), 'eq.org-a');
  assert.equal((injected.get('or')?.match(/,/g) ?? []).length, 1);
  assert.equal(requests[0].searchParams.get('order'), 'name.asc,id.asc');
  assert.equal(requests[0].searchParams.get('limit'), String(LEGACY_PAGE_SIZE));
  await fetchLegacyPatients(client, {orgId: 'org-a', page: 0, search: '(11) 91111-2222'});
  assert.equal(requests[3].searchParams.get('or'), '(name.ilike.*11 91111-2222*,phone.ilike.*11911112222*)');
});

test('direct patient links never resolve a patient from another organization', async () => {
  const {client, requests} = fixture();
  assert.equal((await fetchLegacyPatient(client, 'org-a', 'patient-a'))?.id, 'patient-a');
  assert.equal(await fetchLegacyPatient(client, 'org-a', 'patient-other'), null);
  assert.equal(requests[1].searchParams.get('org_id'), 'eq.org-a');
  assert.equal(requests[1].searchParams.get('id'), 'eq.patient-other');
});

test('missing scope fails before reading and server errors remain visible', async () => {
  const {client, requests} = fixture();
  await assert.rejects(fetchLegacyMessages(client, {orgId: '', patientId: 'patient-a', page: 0}));
  await assert.rejects(fetchLegacyMessages(client, {orgId: 'org-a', patientId: '', page: 0}));
  await assert.rejects(fetchLegacyPatients(client, {orgId: '', page: 0, search: ''}));
  await assert.rejects(fetchLegacyPatient(client, 'org-a', ''));
  assert.equal(requests.length, 0);
  await assert.rejects(fetchLegacyMessages(fixture([], true).client, {orgId: 'org-a', patientId: 'patient-a', page: 0}), /synthetic read failure/);
});


test('range recovery retries at most once and never masks other PostgREST errors', async () => {
  const persistent = fixture([], {code: 'PGRST103', status: 416});
  await assert.rejects(fetchLegacyMessages(persistent.client, {orgId: 'org-a', patientId: 'patient-a', page: 1}), /synthetic read failure/);
  assert.deepEqual(persistent.requests.map(url => url.searchParams.get('offset')), ['40', '0']);
  const firstPage = fixture([], {code: 'PGRST103', status: 416});
  await assert.rejects(fetchLegacyMessages(firstPage.client, {orgId: 'org-a', patientId: 'patient-a', page: 0}), /synthetic read failure/);
  assert.equal(firstPage.requests.length, 1);
  for (const failure of [{code: '42501', status: 403}, {code: 'PGRST100', status: 400}, {code: 'UNKNOWN_RANGE', status: 416}]) {
    const failed = fixture([], failure);
    await assert.rejects(fetchLegacyMessages(failed.client, {orgId: 'org-a', patientId: 'patient-a', page: 1}), /synthetic read failure/);
    assert.equal(failed.requests.length, 1);
  }
});
