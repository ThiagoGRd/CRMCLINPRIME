/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test transpilation hook only. */
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
 const source = require('fs').readFileSync(filename, 'utf8');
 module._compile(ts.transpileModule(source, {compilerOptions:{esModuleInterop:true,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}}).outputText, filename);
};
require.extensions['.tsx'] = require.extensions['.ts'];
