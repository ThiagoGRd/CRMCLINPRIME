import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationChannelProblem, type StartConversationChannel } from '../lib/start-conversation.ts';
const channel:StartConversationChannel={id:'one',org_id:'org',type:'whatsapp_cloud',display_name:'Recepção',status:'connected',inbox_key:'reception',phone_number_id:'123',config:null};
test('channel picker disables missing, unclassified and unsupported identities without choosing a replacement',()=>{
  assert.ok(conversationChannelProblem(undefined));
  assert.ok(conversationChannelProblem({...channel,inbox_key:null}));
  assert.ok(conversationChannelProblem({...channel,inbox_key:'unknown'}));
  assert.ok(conversationChannelProblem({...channel,phone_number_id:'   '}));
  assert.ok(conversationChannelProblem({...channel,type:'whatsapp_evolution'}));
  assert.equal(conversationChannelProblem(channel),null);
  assert.equal(conversationChannelProblem({...channel,status:'disconnected'}),null);
});
