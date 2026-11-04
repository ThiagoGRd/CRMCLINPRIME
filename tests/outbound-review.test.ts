import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../lib/outbound-review.ts';
test('manual review sends only scoped action and required bounded evidence',()=>{
  assert.equal(typeof review.buildOutboundReview,'function');
  assert.deepEqual(review.buildOutboundReview('request','conversation','finalize',' Conferido no provedor. '),{action:'reconcile',request_id:'request',conversation_id:'conversation',operation:'finalize',evidence:'Conferido no provedor.'});
  for(const operation of ['cancel','observe'])assert.equal(review.buildOutboundReview('request','conversation',operation,'Evidência').operation,operation);
  for(const args of [['','c','finalize','a'],['r','','cancel','a'],['r','c','resend','a'],['r','c','observe',' \n\t '],['r','c','observe','a'.repeat(2001)]])assert.throws(()=>review.buildOutboundReview(...args as [string,string,string,string]));
});
