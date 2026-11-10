import test from 'node:test';
import assert from 'node:assert/strict';
import {createReceptionGatewayClient} from '../lib/server/reception-gateway-client';
const scope={orgId:'00000000-0000-4000-8000-000000000001',channelId:'00000000-0000-4000-8000-000000000002',actorId:'00000000-0000-4000-8000-000000000003'};
test('pilot client has bounded scoped binding read and predecessor guarded POST',async()=>{
 const calls:string[]=[];
 const client=createReceptionGatewayClient({...scope,origin:'https://fixture.invalid',principal:'fixture',token:'a'.repeat(32),recipientBindingId:scope.channelId},{enabled:true,fetcher:async(url,opts)=>{calls.push(String(url));assert.equal(opts?.method,'GET');return Response.json({latest:null});}});
 assert.equal(typeof client.context,'function');
 assert.equal(await client.context(scope),null);
 assert.equal(calls[0],'https://fixture.invalid/crm-recepcao/v1/bindings/'+scope.channelId);
});
