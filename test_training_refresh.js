const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const pack=require('./knowledge_current.json'),bundle=require('./reviewed-embeddings.json');
test('release index matches every current topic, no old vectors/search fallback',async()=>{
 const entries=Object.entries(pack.topics).map(([topic,t])=>({topic,content:t.text}));
 const digest=crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
 assert.equal(digest,bundle.digest);assert.equal(bundle.records.length,entries.length);
 let network=0;const index=require('./knowledge_index').createKnowledgeIndex({db:{from(){network++;throw Error('Must not query archived DB')}},embedBatch(){network++;throw Error('No paid startup build')},pack,model:bundle.model,approvedDigest:digest});
 await index.initialize();assert.equal(index.status().state,'ready');assert.equal(network,0);
 const results=await index.search(bundle.records.find(r=>r.topic==='rates').embedding,{limit:1});assert.equal(results[0].topic,'rates');assert.equal(results[0].content,pack.topics.rates.text);
 for(const row of bundle.records)assert.equal(row.content,pack.topics[row.topic].text);
});
test('reviewed context supplies intake, owner overrides and emergency guidance even if retrieval is empty',()=>{
 const text=require('./knowledge_current').publicFactsBlock([]);
 assert(text.includes('Новые цифры предлагаются соискателям сразу'));
 assert(text.includes('девять')||text.includes('Девять'));assert(text.includes('ZIP'));assert(text.includes('911'));
 assert(text.includes('депозита $5000')||text.includes('депозит $5000'));assert(text.includes('AMS Auto Doctor'));assert(text.includes('30 календарных дней ОТ ВОЗВРАТА'));
 assert(!text.includes('Сервис KRS'));assert(!text.includes('НЕ требование депозита'));
});
