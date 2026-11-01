'use strict';
const crypto=require('node:crypto');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const BASE_ID=-2026103103000;
function createKnowledgeIndex({db,embedBatch,pack,model,approvedDigest}) {
 const entries=Object.entries(pack.topics).map(([topic,t],i)=>({id:BASE_ID-i-1,topic,content:t.text}));
 const digest=hash(JSON.stringify(entries.map(({topic,content})=>({topic,content}))));
 const source='barkai-reviewed:'+pack.version+':'+digest;
 const jobSource='barkai-index-job:'+pack.version;
 let status={state:'not_started',version:pack.version,count:0,model,digest},cached=[],pending;
 const fail=code=>{const e=new Error(code);e.code=code;throw e;};
 function validate(rows){
  if(rows.length!==entries.length)return null;
  const found=new Map(rows.map(r=>[Number(r.id),r]));
  return entries.map(e=>{const r=found.get(e.id);if(!r||r.source!==source||r.content!==e.content)fail('index_content_mismatch');
   let v=typeof r.embedding==='string'?JSON.parse(r.embedding):r.embedding;
   if(!Array.isArray(v)||v.length!==1536||!v.every(Number.isFinite)||!v.some(x=>x!==0))fail('index_vector_invalid');
   return {...e,embedding:v,norm:Math.sqrt(v.reduce((s,x)=>s+x*x,0))};});
 }
 async function load(){const r=await db.from('knowledge').select('id,source,content,embedding').eq('source',source);if(r.error)fail('index_read_failed');return validate(r.data||[]);}
 async function initialize(){
  if(status.state==='blocked'){const recovered=await load();if(recovered){cached=recovered;status={...status,state:'ready',count:cached.length,error:undefined};pending=Promise.resolve();}}
  if(pending)return pending;
  pending=(async()=>{
   status.state='loading';
   cached=await load();if(cached){status.state='ready';status.count=cached.length;return;}
   if(pack.version!=='2026-10-31.3'||digest!==approvedDigest)fail('index_build_not_authorized');
   // Deterministic primary-key claim prevents two instances creating embeddings.
   // A previous unfinished claim is UNKNOWN: never repeat its paid request.
   const claim=await db.from('knowledge').insert({id:BASE_ID,source:jobSource,content:JSON.stringify({status:'embedding_request_pending',digest,model,topics:entries.length}),embedding:null});
   if(claim.error){cached=await load();if(cached){status.state='ready';status.count=cached.length;return;}const code=String(claim.error.code||'unknown').replace(/[^a-zA-Z0-9_]/g,'');fail('index_claim_rejected_'+code);}
   status.state='embedding';
   const result=await embedBatch(entries.map(e=>e.content));
   if(result.model!==model||!Array.isArray(result.data)||result.data.length!==entries.length)fail('embedding_response_invalid');
   const ordered=[...result.data].sort((a,b)=>a.index-b.index);
   const records=entries.map((e,i)=>{if(ordered[i].index!==i)fail('embedding_index_invalid');return {id:e.id,source,content:e.content,embedding:ordered[i].embedding};});
   validate(records);
   status.state='saving';
   // One atomic PostgREST batch. Read back after any outcome; never retry insert.
   try{await db.from('knowledge').insert(records);}catch(_){}
   cached=await load();if(!cached)fail('index_write_unknown_no_retry');
   status.state='ready';status.count=cached.length;status.build_tokens=result.usage?.total_tokens||0;
   try{await db.from('knowledge').update({content:JSON.stringify({status:'ready',digest,model,topics:cached.length,tokens:status.build_tokens})}).eq('id',BASE_ID).eq('source',jobSource);}catch(_){}
  })().catch(e=>{status.state='blocked';status.error=e.code||'index_build_unknown_no_retry';cached=[];throw new Error(status.error);});
  return pending;
 }
 async function search(vector,{limit=10,threshold=.2}={}){
  await initialize();
  if(vector.length!==1536||!vector.every(Number.isFinite))fail('query_vector_invalid');
  const norm=Math.sqrt(vector.reduce((s,x)=>s+x*x,0));if(!norm)return [];
  return cached.map(r=>({content:r.content,topic:r.topic,source,similarity:r.embedding.reduce((s,x,i)=>s+x*vector[i],0)/(r.norm*norm)})).filter(r=>r.similarity>=threshold).sort((a,b)=>b.similarity-a.similarity).slice(0,limit);
 }
 return {initialize,search,status:()=>({...status}),source};
}
module.exports={createKnowledgeIndex,hash};
