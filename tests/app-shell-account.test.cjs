/* eslint-disable @typescript-eslint/no-require-imports -- Render the real shell with synthetic navigation, organization, and auth boundaries. */
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function withShell(run) {
  const calls = [];
  const org = { id: 'synthetic-org', name: 'Clínica de exemplo', displayName: 'Pessoa de exemplo' };
  const originalLoad = Module._load;
  const originalFetch = global.fetch;
  let finishSignOut;
  const signedOut = new Promise(resolve => { finishSignOut = resolve; });
  global.fetch = () => { calls.push('fetch'); throw new Error('Unexpected network access'); };
  Module._load = function (name, ...rest) {
    if (name === 'next/navigation') return {
      usePathname: () => '/fila',
      useRouter: () => ({ push: url => calls.push(['push', url]), refresh: () => calls.push('refresh') }),
    };
    if (name === '@tanstack/react-query') return { useQuery: () => ({ data: undefined }) };
    if (name === '@/components/org-context') return { useOrg: () => org };
    if (name === '@/lib/supabase/client') return { createClient: () => {
      calls.push('createClient');
      return { auth: { signOut: () => { calls.push('signOut'); return signedOut; } } };
    } };
    // o shell é chamado como função (sem renderizador): hooks de estado viram stubs
    if (name === 'react' && rest[0]?.filename?.endsWith(path.join('components', 'app-shell.tsx'))) {
      return { ...originalLoad.call(this, name, ...rest), useState: init => [init, () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
    }
    return originalLoad.call(this, name.startsWith('@/') ? path.join(__dirname, '..', name.slice(2)) : name, ...rest);
  };
  const modulePath = require.resolve('../components/app-shell');
  delete require.cache[modulePath];
  try {
    const { AppShell } = require(modulePath);
    await run({
      tree: userEmail => AppShell({ userEmail, children: React.createElement('p', null, 'Conteúdo de exemplo') }),
      calls, org, finishSignOut,
    });
  } finally {
    Module._load = originalLoad;
    global.fetch = originalFetch;
    delete require.cache[modulePath];
  }
}

function accountMarkup(html) {
  const account = html.match(/<dl\b[^>]*><dt\b[^>]*>Conta em uso<\/dt><dd\b([^>]*)>([^<]*)<\/dd><\/dl>/);
  assert.ok(account, 'The current account must have a visible semantic label and value');
  return { attributes: account[1], value: account[2] };
}

function findElement(node, predicate) {
  if (!React.isValidElement(node)) return;
  if (predicate(node)) return node;
  for (const child of React.Children.toArray(node.props.children)) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
}

test('shell identifies the supplied account even when organization and display names exist', () => withShell(({ tree, calls }) => {
  const html = renderToStaticMarkup(tree('operator.one@example.test'));
  assert.equal(accountMarkup(html).value, 'operator.one@example.test');
  assert.match(html, /Clínica de exemplo/);
  assert.match(html, /Pessoa de exemplo/);
  assert.match(html, /Conteúdo de exemplo/);
  assert.deepEqual(calls, [], 'Showing the account must not read or mutate an external service');
}));

test('different supplied accounts are shown independently of the same organization', () => withShell(({ tree, calls }) => {
  const first = renderToStaticMarkup(tree('operator.one@example.test'));
  const second = renderToStaticMarkup(tree('operator.two@example.test'));
  assert.equal(accountMarkup(first).value, 'operator.one@example.test');
  assert.equal(accountMarkup(second).value, 'operator.two@example.test');
  assert.doesNotMatch(second, /operator\.one@example\.test/);
  assert.deepEqual(calls, []);
}));

test('missing account email is explicit and never replaced by organization identity', () => withShell(({ tree, calls }) => {
  for (const absent of ['', undefined, null]) {
    assert.equal(accountMarkup(renderToStaticMarkup(tree(absent))).value, 'E-mail não identificado');
  }
  assert.deepEqual(calls, []);
}));

test('long account email remains complete, selectable, and allowed to wrap in the narrow sidebar', () => withShell(({ tree, calls }) => {
  const email = `${'synthetic.operator.'.repeat(3)}fixture@${'synthetic-domain-'.repeat(3)}example.test`;
  const account = accountMarkup(renderToStaticMarkup(tree(email)));
  assert.equal(account.value, email);
  assert.match(account.attributes, /select-text/);
  assert.match(account.attributes, /whitespace-normal/);
  assert.match(account.attributes, /\[overflow-wrap:anywhere\]/);
  assert.doesNotMatch(account.attributes, /truncate|line-clamp|overflow-hidden/);
  assert.deepEqual(calls, []);
}));

test('existing logout still awaits sign-out before navigating to login and refreshing', () => withShell(async ({ tree, calls, finishSignOut }) => {
  const logout = findElement(tree('operator.one@example.test'), node => node.type === 'button' && node.props.title === 'Sair');
  assert.ok(logout);
  const pending = logout.props.onClick();
  assert.deepEqual(calls, ['createClient', 'signOut']);
  finishSignOut();
  await pending;
  assert.deepEqual(calls, ['createClient', 'signOut', ['push', '/login'], 'refresh']);
}));

test('mobile menu button controls the single sidebar and every nav item is rendered once', () => withShell(({ tree }) => {
  const html = renderToStaticMarkup(tree('operator.one@example.test'));
  const button = html.match(/<button\b[^>]*aria-label="Abrir menu"[^>]*>/);
  assert.ok(button, 'menu button must be rendered');
  const controls = button[0].match(/aria-controls="([^"]+)"/)[1];
  assert.equal(html.split('<aside').length - 1, 1);
  assert.match(html, new RegExp(`<aside\\b[^>]*id="${controls}"`));
  const labels = [...html.matchAll(/<a\b[^>]*>(.*?)<\/a>/g)].map(m => m[1].replace(/<[^>]*>/g, ''));
  for (const label of ['Minha fila', 'Conversas', 'Pacientes', 'Agenda', 'Funil', 'Cadências', 'Gestão', 'Configurações']) {
    assert.equal(labels.filter(l => l === label).length, 1, label);
  }
}));
