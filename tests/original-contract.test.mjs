import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getMyOrg } from '../lib/org.ts';
import { moveLeadStage } from '../lib/funil-move.ts';

test('organization request preserves original columns and public Org shape', async () => {
  const client = createClient('https://synthetic.invalid', 'synthetic-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: 'Bearer synthetic-token' }, fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === '/auth/v1/user') return Response.json({ id: 'synthetic-user' });
      assert.equal(url.pathname, '/rest/v1/org_members');
      assert.equal(url.searchParams.get('select'), 'role,display_name,org_id,organizations(id,name,contact_label,logo_url,settings)');
      return Response.json([{ org_id: 'synthetic-org', role: 'member', organizations: { id: 'synthetic-org' } }]);
    } },
  });
  const org = await getMyOrg(client);
  assert.deepEqual(Object.keys(org).sort(), ['id','role','displayName','name','contactLabel','logoUrl','settings'].sort());
});

for (const dealId of ['synthetic-deal', null]) {
  test(`funnel ${dealId ? 'update' : 'insert'} uses only original deals fields`, async () => {
    const client = createClient('https://synthetic.invalid', 'synthetic-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: async (input, init) => {
        const url = new URL(String(input));
        assert.equal(url.pathname, '/rest/v1/deals');
        const keys = Object.keys(JSON.parse(init.body)).sort();
        assert.deepEqual(keys, (dealId ? ['stage_id','moved_at'] : ['patient_id','stage_id','org_id','position','moved_at']).sort());
        assert.equal(url.searchParams.get('select'), 'id');
        return Response.json({ id: dealId ?? 'synthetic-new-deal' });
      } },
    });
    const lead = { id: 'synthetic-patient', dealId, stageId: null };
    let leads = [lead];
    assert.equal((await moveLeadStage({ client, orgId: 'synthetic-org', lead, targetStageId: 'synthetic-stage', pendingMoves: new Set(), setLeads: update => { leads = update(leads); } })).status, 'moved');
    assert.equal(leads[0].stageId, 'synthetic-stage');
  });
}
