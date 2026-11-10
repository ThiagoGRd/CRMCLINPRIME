import test from 'node:test';import assert from 'node:assert/strict';import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {InboxMobileNavigation,inboxPaneClass} from '../components/inbox/inbox-mobile-navigation';
test('mobile navigation exposes list/chat/details and only selected pane while desktop retains columns',()=>{
 assert.match(inboxPaneClass('list','list'),/flex/);assert.match(inboxPaneClass('chat','list'),/^hidden /);assert.match(inboxPaneClass('details','list'),/^hidden /);
 for(const pane of ['list','chat','details'] as const)assert.match(inboxPaneClass(pane,pane),/^flex lg:flex/);
 const html=renderToStaticMarkup(<InboxMobileNavigation view="list" hasPatient={false} onChange={()=>{}}/>);
 assert.match(html,/Conversas/);assert.match(html,/Conversa/);assert.match(html,/Detalhes/);assert.match(html,/lg:hidden/);assert.match(html,/disabled/);
});
