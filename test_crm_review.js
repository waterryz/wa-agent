const test=require('node:test'),assert=require('node:assert/strict');const {registerCrmReview}=require('./crm_review');
test('CRM review is authenticated, bounded and tool-free',async()=>{
 let handler,calls=0;registerCrmReview({post:(path,fn)=>{assert.equal(path,'/crm-review');handler=fn;}},{adminKey:'fixture-key',generate:async()=>{calls++;return{text:'Проверьте источник',model:'fixture',usage:{output_tokens:5}};}});
 async function invoke(body,key){let status=200,result;await handler({body,get:()=>key},{status:n=>({json:v=>{status=n;result=v;}}),json:v=>{result=v;}});return {status,result};}
 const body={documentation:'a'.repeat(200),findings:[{kind:'bank_stale'}]};assert.equal((await invoke(body,'bad')).status,401);
 assert.equal((await invoke({...body,tools:['send']},'fixture-key')).status,400);
 const result=await invoke(body,'fixture-key');assert.equal(calls,1);assert.deepEqual(result.result.actions_performed,[]);assert.equal(result.result.scope,'owner_crm_review');
});
