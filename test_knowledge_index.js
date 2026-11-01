const test=require('node:test'),assert=require('node:assert/strict'),{createKnowledgeIndex,hash}=require('./knowledge_index');
function fixture(options={}){
 const pack={version:'2026-10-31.3',topics:{rates:{text:'current rates'},oil:{text:'current oil'}}},rows=new Map([[1052,{id:1052,source:'old',content:'obsolete',embedding:Array(1536).fill(0)}]]);let calls=0;
 const db={async rpc(name,{p_rows}){assert.equal(name,'barkai_insert_reviewed_index_20261031');return this.from().insert(p_rows.length===1?p_rows[0]:p_rows);},from(){const q={filters:[],mode:'select',select(){return this;},eq(k,v){this.filters.push([k,v]);return this;},update(v){this.mode='update';this.value=v;return this;},async insert(v){const list=Array.isArray(v)?v:[v];if(list.some(r=>rows.has(r.id)))return{error:{code:'23505'}};if(Array.isArray(v)&&options.writeFails)return{error:{code:'xx'}};for(const r of list)rows.set(r.id,{...r});if(Array.isArray(v)&&options.unknownWrite)throw Error('network');return{error:null};},then(resolve,reject){return Promise.resolve().then(()=>{const selected=[...rows.values()].filter(r=>this.filters.every(([k,v])=>r[k]===v));if(this.mode==='update')for(const r of selected)Object.assign(r,this.value);return{data:selected,error:null};}).then(resolve,reject);}};return q;}};
 const args={db,pack,model:'text-embedding-3-small',approvedDigest:hash(JSON.stringify(Object.entries(pack.topics).map(([topic,t])=>({topic,content:t.text})))),embedBatch:async input=>{calls++;if(options.embeddingFails)throw Error('unknown');return{model:'text-embedding-3-small',data:input.map((_,i)=>({index:i,embedding:Array.from({length:1536},(_,j)=>j===i?1:0)})),usage:{total_tokens:12}};}};
 return{args,rows,calls:()=>calls};
}
test('new index persists, searches current vectors, keeps old data and reuses without payment',async()=>{
 const f=fixture(),i=createKnowledgeIndex(f.args);await Promise.all([i.initialize(),i.initialize()]);assert.equal(f.calls(),1);assert.equal(i.status().count,2);assert.equal(f.rows.get(1052).content,'obsolete');
 const hits=await i.search(Array.from({length:1536},(_,j)=>j===1?1:0));assert.equal(hits[0].topic,'oil');assert(!hits.some(h=>h.content==='obsolete'));
 await createKnowledgeIndex(f.args).initialize();assert.equal(f.calls(),1);
});
test('unknown embedding outcome is never automatically retried even after restart',async()=>{
 const f=fixture({embeddingFails:true}),i=createKnowledgeIndex(f.args);await assert.rejects(i.initialize());await assert.rejects(i.initialize());await assert.rejects(createKnowledgeIndex(f.args).initialize());assert.equal(f.calls(),1);
});
test('unknown insert with committed rows succeeds only after exact readback',async()=>{const f=fixture({unknownWrite:true}),i=createKnowledgeIndex(f.args);await i.initialize();assert.equal(i.status().state,'ready');assert.equal(f.calls(),1);});
test('failed insert and tampered current content fail closed without old fallback',async()=>{
 const f=fixture({writeFails:true}),i=createKnowledgeIndex(f.args);await assert.rejects(i.initialize());assert.equal(i.status().state,'blocked');assert.equal(f.calls(),1);
 const g=fixture(),j=createKnowledgeIndex(g.args);await j.initialize();g.rows.get(-2026103103001).content='tampered';await assert.rejects(createKnowledgeIndex(g.args).initialize());assert.equal(g.calls(),1);
});
test('unapproved pack cannot start paid build',async()=>{const f=fixture();f.args.approvedDigest='different';await assert.rejects(createKnowledgeIndex(f.args).initialize());assert.equal(f.calls(),0);assert.equal(f.rows.size,1);});
