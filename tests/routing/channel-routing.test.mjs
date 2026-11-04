import { test } from 'node:test';
import assert from 'node:assert/strict';
const helper = await import('../../supabase/functions/_shared/routing.ts').catch(()=>({}));
test('delivery is explicit and fails closed for missing, wrong, disconnected or foreign channels',()=>{
 assert.equal(typeof helper.validateSendRoute,'function');
 const conversation={id:'conv',org_id:'org',patient_id:'pat',channel_id:'ch'};
 const channel={id:'ch',org_id:'org',type:'whatsapp_cloud',status:'connected',phone_number_id:'123',inbox_key:'reception'};
 assert.equal(helper.validateSendRoute({conversation_id:'conv',channel_id:'ch'},conversation,channel),null);
 for(const [input,c,ch] of [ [{},conversation,channel],[{conversation_id:'conv',channel_id:'other'},conversation,channel],[{conversation_id:'conv',channel_id:'ch'},conversation,{...channel,status:'disconnected'}],[{conversation_id:'conv',channel_id:'ch'},conversation,{...channel,org_id:'foreign'}],[{conversation_id:'conv',channel_id:'ch'},null,channel] ]) assert.ok(helper.validateSendRoute(input,c,ch));
});
