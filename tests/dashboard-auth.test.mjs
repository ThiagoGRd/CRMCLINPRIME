import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../app/(app)/dashboard/page.tsx', import.meta.url), 'utf8');
function loadPage(org) {
  let queries = 0;
  const supabase = { rpc() { queries++; throw Error('Unexpected query'); }, from() { queries++; throw Error('Unexpected query'); } };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports,
    require(name) {
      if (name === '@/lib/supabase/server') return { createClient: async () => supabase };
      if (name === '@/lib/org') return { getMyOrg: async () => org };
      if (name === 'react/jsx-runtime') return require(name);
      return {};
    },
  });
  return { page: exports.default, queries: () => queries };
}
test('dashboard handles membership revoked after layout without querying or crashing', async () => {
  const state = loadPage(null);
  const result = await state.page();
  assert.match(result.props.children, /organização/);
  assert.equal(state.queries(), 0);
});
