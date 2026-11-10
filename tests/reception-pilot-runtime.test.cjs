/* eslint-disable @typescript-eslint/no-require-imports -- Actual Next route runtime with synthetic session/network boundaries. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const config = {
  vercelProjectId: 'prj_synthetic', appOrigin: 'https://crmclinprime.vercel.app',
  orgId: id(1), actorId: id(2), channelId: id(3), recipientBindingId: id(4),
  principal: 'synthetic_principal', recipientLabel: 'Destino fictício aprovado', revision: 'synthetic-1',
};
const token = 'synthetic_' + 'x'.repeat(32);
const enabled = {
  NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production', VERCEL_PROJECT_ID: 'prj_synthetic',
  CRM_RECEPTION_PILOT_ENABLED: 'true', CRM_RECEPTION_PILOT_CONFIG: JSON.stringify(config), CRM_RECEPTION_GATEWAY_TOKEN: token,
};
const modules = [
  '../lib/server/reception-pilot-runtime', '../lib/server/reception-pilot-configured',
  '../lib/server/reception-pilot', '../lib/server/reception-gateway-client',
  ...['context', 'submit', 'status'].map(name => `../app/api/reception-pilot/${name}/route`),
];
function request(name = 'context', body, origin = config.appOrigin) {
  return new Request(`${origin}/api/reception-pilot/${name}`, {
    method: body ? 'POST' : 'GET',
    headers: {Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin'},
    ...(body ? {body: JSON.stringify(body)} : {}),
  });
}
async function harness(env = enabled, options = {}) {
  const savedEnv = {...process.env};
  const originalLoad = Module._load, originalFetch = global.fetch, originalWindow = global.window;
  const calls = []; let sessions = 0, users = 0, memberships = 0;
  const clear = () => { for (const path of modules) delete require.cache[require.resolve(path)]; };
  const state = {actor: config.actorId, member: true, getUserError: false, sessionError: false, ...options};
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('CRM_RECEPTION_') || name.startsWith('NEXT_PUBLIC_CRM_RECEPTION_') || name.startsWith('RECEPTION_') || name.startsWith('VERCEL') || name === 'NODE_ENV') delete process.env[name];
    }
    for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
    if (options.browser) global.window = {};
    global.fetch = async (url, init) => {
      calls.push({url, init});
      if (state.gateway) return state.gateway(url, init);
      if (init.method === 'GET' && String(url).includes('/bindings/')) return Response.json({latest: null});
      const intent = init.method === 'POST' ? JSON.parse(init.body).intent_id : String(url).split('/').at(-1);
      return Response.json({intent_id: intent, state: 'api_accepted', provider_message_ids: ['synthetic_msg'], delivery_state: 'unverified'});
    };
    Module._load = function(name, ...rest) {
      // Next handles this compile-time server marker; plain Node has no Next loader.
      if (name === 'server-only') return {};
      if (name === '../supabase/server') return {createClient: async () => {
        sessions++;
        if (state.sessionError) throw Error(`private session failure ${token}`);
        return {
          auth: {getUser: async () => {
            users++;
            const actor = state.actorAt ? state.actorAt(users) : state.actor;
            return {data: {user: actor ? {id: actor} : null}, error: state.getUserError ? Error(token) : null};
          }},
          from: table => {
            assert.equal(table, 'org_members');
            const filters = {};
            const query = {
              select: columns => {assert.equal(columns, 'org_id,user_id'); return query;},
              eq: (key, value) => {filters[key] = value; return query;},
              maybeSingle: async () => {
                memberships++;
                assert.deepEqual(filters, {user_id: config.actorId, org_id: config.orgId});
                const member = state.memberAt ? state.memberAt(memberships) : state.member;
                return {data: member ? {user_id: config.actorId, org_id: config.orgId} : null, error: null};
              },
            };
            return query;
          },
        };
      }};
      return originalLoad.call(this, name, ...rest);
    };
    clear();
    const routes = Object.fromEntries(['context', 'submit', 'status'].map(name => [name, require(`../app/api/reception-pilot/${name}/route`)]));
    return {routes, state, calls, counts: () => ({sessions, users, memberships}), close};
  } catch (error) {close(); throw error;}
  function close() {
    clear(); Module._load = originalLoad; global.fetch = originalFetch;
    if (originalWindow === undefined) delete global.window; else global.window = originalWindow;
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}
async function unavailable(response, status = 503) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), {error: 'pilot_unavailable'});
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
async function off(env, options) {
  const h = await harness(env, options);
  try {
    await unavailable(await h.routes.context.GET(request()));
    await unavailable(await h.routes.status.GET(request('status')));
    await unavailable(await h.routes.submit.POST(request('submit', {text: 'synthetic'})));
    assert.equal(h.counts().sessions, 0); assert.equal(h.calls.length, 0);
  } finally {h.close();}
}
// A missing gate must deny before the session or gateway boundary is reached.
test('actual exported Next handlers stay OFF even with ambient activation flags', async () => {
  await off({RECEPTION_GATEWAY_ENABLED: 'true', NEXT_PUBLIC_CRM_RECEPTION_PILOT_ENABLED: 'true'});
  await off({});
});
test('only exact deliberate activation in the configured Vercel Production project is allowed', async () => {
  for (const key of Object.keys(enabled)) await off({...enabled, [key]: undefined});
  for (const change of [
    {NODE_ENV: 'development'}, {NODE_ENV: 'test'}, {VERCEL: 'true'}, {VERCEL_ENV: 'preview'},
    {VERCEL_ENV: 'development'}, {VERCEL_TARGET_ENV: 'staging'}, {VERCEL_TARGET_ENV: 'preview'},
    {VERCEL_PROJECT_ID: 'prj_other'}, {CRM_RECEPTION_PILOT_ENABLED: 'TRUE'},
    {CRM_RECEPTION_PILOT_ENABLED: '1'}, {CRM_RECEPTION_PILOT_ENABLED: ' true'},
  ]) await off({...enabled, ...change});
  await off(enabled, {browser: true});
});
test('strict all-or-nothing configuration rejects missing, extra, malformed and duplicate fields without side effects', async () => {
  for (const key of Object.keys(config)) {
    const missing = {...config}; delete missing[key];
    for (const value of [missing, {...config, [key]: ''}, {...config, [key]: null}, {...config, [key]: 42}]) {
      await off({...enabled, CRM_RECEPTION_PILOT_CONFIG: JSON.stringify(value)});
    }
  }
  for (const invalid of [
    null, [], {}, {...config, origin: 'https://attacker.invalid'}, {...config, token},
    ...['orgId', 'actorId', 'channelId', 'recipientBindingId'].map(key => ({...config, [key]: 'not-a-uuid'})),
    {...config, channelId: id(3).toUpperCase().replace('0000', 'ABCD')},
    {...config, vercelProjectId: '../private'}, {...config, principal: 'has spaces'},
    {...config, principal: 'x'.repeat(129)}, {...config, revision: 'invalid/revision'},
    {...config, revision: 'x'.repeat(65)}, {...config, recipientLabel: ' '},
    {...config, recipientLabel: '\nprivate'}, {...config, recipientLabel: 'x'.repeat(101)},
    ...['https://unapproved.invalid', 'https://crmclinprime.vercel.app/', 'https://crmclinprime.vercel.app:8443', 'http://crm.invalid', 'https://crm.invalid/', 'https://user@crm.invalid', 'https://crm.invalid/path', 'https://crm.invalid?query', 'https://crm.invalid#hash'].map(appOrigin => ({...config, appOrigin})),
  ]) await off({...enabled, CRM_RECEPTION_PILOT_CONFIG: JSON.stringify(invalid)});
  const raw = JSON.stringify(config);
  for (const invalid of ['', '{', raw + '{}', raw.slice(0, -1) + ',"actorId":"' + id(9) + '"}', raw.slice(0, -1) + ',"act\\u006frId":"' + id(9) + '"}', ' '.repeat(4097) + raw]) {
    await off({...enabled, CRM_RECEPTION_PILOT_CONFIG: invalid});
  }
  for (const invalid of ['', 'short', token + '\n', 'a'.repeat(257), 'has spaces'.repeat(8)]) await off({...enabled, CRM_RECEPTION_GATEWAY_TOKEN: invalid});
});
// Fails against the prior hard-OFF runtime: the route must use the existing authenticated factory.
test('complete trusted configuration wires actual routes with fixed gateway origin, binding and credential', async () => {
  const h = await harness();
  try {
    assert.equal(h.calls.length, 0, 'construction does not send or probe');
    assert.equal(h.counts().sessions, 0);
    const response = await h.routes.context.GET(request());
    assert.equal(response.status, 200);
    const context = await response.json();
    assert.deepEqual(Object.keys(context).sort(), ['actorId', 'contextKey', 'latest', 'orgId', 'recipientLabel']);
    assert.equal(context.actorId, id(2)); assert.equal(context.orgId, id(1));
    assert.equal(context.recipientLabel, 'Destino fictício aprovado'); assert.equal(context.latest, null);
    assert.match(context.contextKey, /^[a-f0-9]{64}$/);
    assert.deepEqual(h.counts(), {sessions: 2, users: 2, memberships: 2});
    assert.equal(h.calls[0].url, 'https://evolution.clinprime.shop/crm-recepcao/v1/bindings/' + id(4));
    const body = {contextKey: context.contextKey, intentId: id(6), previousIntentId: null, text: 'Texto fictício'};
    const sent = await h.routes.submit.POST(request('submit', body)); assert.equal(sent.status, 200);
    const result = await sent.json(); assert.equal(result.delivery_state, 'unverified');
    const posted = JSON.parse(h.calls[1].init.body);
    assert.deepEqual(Object.keys(posted).sort(), ['intent_id', 'previous_intent_id', 'recipient_binding_id', 'text']);
    assert.equal(posted.recipient_binding_id, id(4)); assert.equal(posted.previous_intent_id, null);
    assert.equal(posted.text, 'Texto fictício'); assert.notEqual(posted.intent_id, id(6));
    assert.equal(h.calls[1].url, 'https://evolution.clinprime.shop/crm-recepcao/v1/text-intents-pilot');
    const status = await h.routes.status.GET(request(`status?contextKey=${context.contextKey}&intentId=${id(6)}`));
    assert.equal(status.status, 200); assert.equal((await status.json()).intent_id, posted.intent_id);
    assert.equal(h.calls[2].url, 'https://evolution.clinprime.shop/crm-recepcao/v1/text-intents/' + posted.intent_id);
    assert.deepEqual(h.calls.map(call => call.init.method), ['GET', 'POST', 'GET']);
    for (const {init} of h.calls) {
      assert.equal(init.headers.Authorization, `Bearer ${token}`);
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit'); assert.equal(init.cache, 'no-store');
    }
    assert.deepEqual(h.counts(), {sessions: 7, users: 7, memberships: 7});
    for (const value of [token, config.principal, config.recipientBindingId, 'evolution.clinprime.shop']) assert.ok(!JSON.stringify({context, result}).includes(value));
  } finally {h.close();}
});
test('runtime config is immutable after construction and browser assertions cannot override authority', async () => {
  const h = await harness();
  try {
    process.env.CRM_RECEPTION_PILOT_CONFIG = JSON.stringify({...config, actorId: id(9), recipientBindingId: id(8)});
    process.env.CRM_RECEPTION_GATEWAY_TOKEN = 'other_' + 'z'.repeat(32);
    const response = await h.routes.context.GET(request()); assert.equal(response.status, 200);
    const context = await response.json();
    const body = {contextKey: context.contextKey, intentId: id(6), previousIntentId: null, text: 'Texto fictício'};
    for (const extra of [{actorId: id(9)}, {orgId: id(9)}, {channelId: id(9)}, {principal: 'evil'}, {recipientBindingId: id(9)}, {origin: 'https://evil.invalid'}, {token: 'evil'}]) {
      await unavailable(await h.routes.submit.POST(request('submit', {...body, ...extra})), 400);
    }
    await unavailable(await h.routes.submit.POST(request('submit', body, 'https://alias.invalid')), 403);
    await unavailable(await h.routes.submit.POST(request('submit', {...body, contextKey: 'stale'})), 409);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.headers.Authorization, `Bearer ${token}`);
    assert.equal(h.calls[0].url, 'https://evolution.clinprime.shop/crm-recepcao/v1/bindings/' + id(4));
  } finally {h.close();}
});
test('verified actor and live exact membership are required and errors never expose private configuration', async () => {
  for (const options of [{actor: id(9)}, {actor: null}, {member: false}, {getUserError: true}, {sessionError: true}]) {
    const h = await harness(enabled, options);
    try {
      await unavailable(await h.routes.context.GET(request()), options.sessionError ? 503 : 403);
      assert.equal(h.calls.length, 0);
    } finally {h.close();}
  }
  const h = await harness(enabled, {gateway: async () => {throw Error(`private ${token} ${config.principal}`);}});
  try {await unavailable(await h.routes.context.GET(request())); assert.equal(h.calls.length, 1);} finally {h.close();}
});
test('account or membership change before dispatch prevents sending, and change after gateway withholds state', async () => {
  for (const action of ['context', 'status', 'submit']) {
    const h = await harness();
    try {
      const initial = await h.routes.context.GET(request()); assert.equal(initial.status, 200);
      const {contextKey} = await initial.json(); const before = h.counts().users;
      h.state.actorAt = call => call === before + 1 ? config.actorId : id(9);
      const response = action === 'context' ? await h.routes.context.GET(request()) : action === 'status'
        ? await h.routes.status.GET(request(`status?contextKey=${contextKey}&intentId=${id(6)}`))
        : await h.routes.submit.POST(request('submit', {contextKey, intentId: id(6), previousIntentId: null, text: 'Texto fictício'}));
      await unavailable(response, 403);
      assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 0);
    } finally {h.close();}
  }
  const revoked = await harness();
  try {
    const initial = await revoked.routes.context.GET(request()); assert.equal(initial.status, 200);
    const {contextKey} = await initial.json(); const before = revoked.counts().memberships;
    revoked.state.memberAt = call => call === before + 1;
    await unavailable(await revoked.routes.submit.POST(request('submit', {contextKey, intentId: id(6), previousIntentId: null, text: 'Texto fictício'})), 403);
    assert.equal(revoked.calls.filter(call => call.init.method === 'POST').length, 0);
  } finally {revoked.close();}
  const h = await harness();
  try {
    const initial = await h.routes.context.GET(request()); assert.equal(initial.status, 200);
    const {contextKey} = await initial.json();
    h.state.gateway = async (_url, init) => {
      h.state.member = false;
      return Response.json({intent_id: JSON.parse(init.body).intent_id, state: 'api_accepted', provider_message_ids: ['synthetic_msg'], delivery_state: 'unverified'});
    };
    await unavailable(await h.routes.submit.POST(request('submit', {contextKey, intentId: id(6), previousIntentId: null, text: 'Texto fictício'})), 403);
    assert.equal(h.calls.filter(call => call.init.method === 'POST').length, 1, 'already-issued dispatch cannot be undone or retried');
  } finally {h.close();}
});
