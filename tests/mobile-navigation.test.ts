import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('mobile navigation stays above Copilot but below modal dialogs',()=>{
 const css=readFileSync(new URL('../app/globals.css',import.meta.url),'utf8');
 const z=(selector:string)=>Number(css.match(new RegExp(selector+'\\s*\\{[^}]*z-index:\\s*(\\d+)'))?.[1]);
 const backdrop=z('\\.crm-mobile-backdrop'),sidebar=z('\\.crm-app-shell > aside'),menu=z('\\.crm-mobile-menu');
 assert.ok(backdrop>40&&sidebar>backdrop&&menu>sidebar&&menu<50,'mobile controls must not cover modal dialog overlay/content');
});
