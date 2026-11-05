import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {validateControl,nativeControl}=require('@areal/workbench-service/desktop/core/remote-session-controls.cjs');
test('Remote controls reject arbitrary Core fields and targets',()=>{
  for(const params of [
    {threadId:'t',operation:'shell',expectedRevision:1},
    {threadId:'t',operation:'configure',expectedRevision:1,values:{token:'secret'}},
    {threadId:'t',operation:'queueRemove',expectedRevision:1,values:{queueItemId:'q',cwd:'/tmp'}},
    {threadId:'t',operation:'goalCreate',expectedRevision:1,values:{objective:''}},
  ])assert.throws(()=>validateControl(params));
});
test('Remote controls retain exact versions and only map supported GUI intent',()=>{
  const p={threadId:'t',operation:'goalCreate',expectedRevision:7,values:{objective:'Finish task',inferLimits:true}};
  validateControl(p);
  assert.deepEqual(nativeControl(p),{method:'areal/goal/create',params:{threadId:'t',expectedRevision:7,objective:'Finish task',inferLimits:true}});
  const queue={threadId:'t',operation:'queueSteer',expectedRevision:3,values:{queueItemId:'q',expectedTurnId:'turn'}};
  validateControl(queue);
  assert.equal(nativeControl(queue).method,'areal/queue/steer');
  assert.equal(nativeControl(queue).params.expectedTurnId,'turn');
});
