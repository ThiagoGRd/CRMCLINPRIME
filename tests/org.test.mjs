import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { getMyOrg } from '../lib/org.ts';
const currentUser = '00000000-0000-0000-0000-000000000011';
const teammate = '00000000-0000-0000-0000-000000000022';
const orgA = '00000000-0000-0000-0000-000000000001';
const orgB = '00000000-0000-0000-0000-000000000002';
function member(user_id = currentUser, org_id = orgA, role = 'member') {
    return { user_id, org_id, role, display_name: role === 'admin' ? 'Administrador fictício' : 'Operador fictício', organizations: { id: org_id, name: 'Clínica fictícia' } };
}
function boundary(rows, { user = currentUser, authError = false, queryError = false } = {}) {
    const requests = [];
    const client = createClient('https://synthetic.invalid', 'synthetic-anon-key', {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { fetch: async (input) => {
                const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
                assert.equal(url.hostname, 'synthetic.invalid');
                assert.equal(url.pathname, '/rest/v1/org_members');
                requests.push(url);
                if (queryError)
                    return Response.json({ message: 'synthetic unavailable' }, { status: 403 });
                let result = [...rows];
                const filter = url.searchParams.get('user_id');
                if (filter?.startsWith('eq.'))
                    result = result.filter(row => row.user_id === filter.slice(3));
                if (url.searchParams.get('order') === 'org_id.asc')
                    result.sort((a, b) => a.org_id.localeCompare(b.org_id));
                const limit = url.searchParams.get('limit');
                if (limit)
                    result = result.slice(0, Number(limit));
                return Response.json(result);
            } },
    });
    client.auth.getUser = async () => authError
        ? { data: { user: null }, error: new Error('synthetic auth failure') }
        : { data: { user: user ? { id: user } : null }, error: null };
    return { client, requests };
}
test('membership belongs to verified user even when teammate admin is visible first', async () => {
    const b = boundary([member(teammate, orgA, 'admin'), member()]);
    const result = await getMyOrg(b.client);
    assert.equal(result?.role, 'member');
    assert.equal(result?.displayName, 'Operador fictício');
    assert.equal(b.requests[0]?.searchParams.get('user_id'), `eq.${currentUser}`);
});
test('missing verified user does not read memberships', async () => {
    const b = boundary([member()], { user: null });
    assert.equal(await getMyOrg(b.client), null);
    assert.equal(b.requests.length, 0);
});
test('auth failure does not read memberships', async () => {
    const b = boundary([member()], { authError: true });
    assert.equal(await getMyOrg(b.client), null);
    assert.equal(b.requests.length, 0);
});
test('membership errors and absent own membership fail closed', async () => {
    assert.equal(await getMyOrg(boundary([member()], { queryError: true }).client), null);
    assert.equal(await getMyOrg(boundary([member(teammate)]).client), null);
});
test('multiple organizations use stable order rather than arbitrary response order', async () => {
    const b = boundary([member(currentUser, orgB), member(currentUser, orgA)]);
    assert.equal((await getMyOrg(b.client))?.id, orgA);
});
test('missing or mismatched related organization fails closed', async () => {
    assert.equal(await getMyOrg(boundary([{ ...member(), organizations: null }]).client), null);
    assert.equal(await getMyOrg(boundary([{ ...member(), organizations: { id: orgB, name: 'Outra fictícia' } }]).client), null);
});
test('valid object and singleton-array organization relationship preserve existing fields', async () => {
    for (const organizations of [{ id: orgA, name: 'Clínica fictícia' }, [{ id: orgA, name: 'Clínica fictícia' }]]) {
        const result = await getMyOrg(boundary([{ ...member(), organizations }]).client);
        assert.deepEqual(result, { id: orgA, role: 'member', displayName: 'Operador fictício', name: 'Clínica fictícia', contactLabel: null, logoUrl: null, settings: null, front: null, isManager: false, userId: currentUser });
    }
});
test('real SDK auth processes success, 401 and absent organization without stored session', async () => {
    const cases = [
        { authStatus: 200, relation: { id: orgA } },
        { authStatus: 401, relation: { id: orgA } },
        { authStatus: 200, relation: null },
        { authStatus: 200, relation: [] },
    ];
    for (const { authStatus, relation } of cases) {
        const paths = [];
        const client = createClient('https://synthetic.invalid', 'synthetic-anon-key', {
            auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
            global: {
                headers: { Authorization: 'Bearer synthetic-test-token' },
                fetch: async (input) => {
                    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
                    assert.equal(url.hostname, 'synthetic.invalid');
                    paths.push(url.pathname);
                    if (url.pathname === '/auth/v1/user') {
                        return Response.json(authStatus === 200 ? { id: currentUser } : { message: 'synthetic invalid token' }, { status: authStatus });
                    }
                    assert.equal(url.pathname, '/rest/v1/org_members');
                    assert.equal(url.searchParams.get('user_id'), `eq.${currentUser}`);
                    assert.equal(url.searchParams.get('order'), 'org_id.asc');
                    return Response.json([{ org_id: orgA, role: 'member', organizations: relation }]);
                },
            },
        });
        const result = await getMyOrg(client);
        if (authStatus === 200 && relation && !Array.isArray(relation)) {
            assert.equal(result?.id, orgA);
        }
        else
            assert.equal(result, null);
        assert.deepEqual(paths, authStatus === 401 ? ['/auth/v1/user'] : ['/auth/v1/user', '/rest/v1/org_members']);
    }
});
test('front, manager flag and user id come from the verified membership', async () => {
    const result = await getMyOrg(boundary([{ ...member(), front: 'recepcao', is_manager: true }]).client);
    assert.equal(result?.front, 'recepcao');
    assert.equal(result?.isManager, true);
    assert.equal(result?.userId, currentUser);
});
test('front outside the known list becomes null', async () => {
    const result = await getMyOrg(boundary([{ ...member(), front: 'marketing', is_manager: 'true' }]).client);
    assert.equal(result?.front, null);
    assert.equal(result?.isManager, false);
});
test('admin is manager even when is_manager is false', async () => {
    const result = await getMyOrg(boundary([{ ...member(), role: 'admin', is_manager: false }]).client);
    assert.equal(result?.isManager, true);
});
