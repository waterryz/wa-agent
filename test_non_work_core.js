const test=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
test('real core stops repeated and changing jokes without model, keeps takeover and session isolation',async()=>{
 const old=Module._load,history=new Map();let operator=false,paid=0;
 Module._load=function(request,parent){
  if(parent?.filename.endsWith('assistant_core.js')&&request==='./agent')return{OWNER_NAME:'Synthetic',costOf:()=>({}),retrieveContext:()=>{paid++;throw Error('Forbidden model call')},describeImages:()=>{paid++;throw Error('Forbidden vision call')}};
  if(parent?.filename.endsWith('assistant_core.js')&&request==='./assistant_store')return{getOrCreateConversation:async p=>({id:p.external_id,operator_mode:operator}),saveMessage:async(id,role,content)=>{if(!history.has(id))history.set(id,[]);history.get(id).push({role,content})},getHistory:async id=>history.get(id)||[]};
  return old.apply(this,arguments);
 };
 let core;try{delete require.cache[require.resolve('./assistant_core')];core=require('./assistant_core')}finally{Module._load=old}
 const p={channel:'web',external_id:'SYNTH-one',language:'ru',message:'Можно платить по марсианским неделям?'};
 assert.equal((await core.processMessage(p)).action,'non_work_first');
 assert.equal((await core.processMessage(p)).action,'non_work_boundary');
 assert.equal((await core.processMessage({...p,message:'Холодильник, раки уползли'})).reply,null);
 assert.equal((await core.processMessage({...p,external_id:'SYNTH-two'})).action,'non_work_first');
 assert((await core.processMessage({...p,message:'Где скачать хендбук?'})).reply);
 assert.equal((await core.processMessage(p)).action,'non_work_first');
 operator=true;assert((await core.processMessage({...p,message:'Можно оформить машину на воображаемого напарника?'})).operator_mode);
 assert.equal(paid,0);
});
