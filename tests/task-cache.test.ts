import test from 'node:test';import assert from 'node:assert/strict';
import { invalidateTaskCaches } from '../lib/task-cache';
test('invalidateTaskCaches covers queue, forgotten and patient panel keys',()=>{
 const keys:unknown[][]=[];
 invalidateTaskCaches({invalidateQueries:(f)=>{keys.push(f.queryKey);}},'org-a');
 assert.deepEqual(keys,[['tasks','org-a'],['forgotten','org-a'],['patient-tasks']]);
});
