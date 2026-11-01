'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const knowledge = require('./knowledge_current');
const pack = require('./knowledge_current.json');
const target = {exports:{}};
const blocked = () => { throw new Error('No external effects in policy tests'); };
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'agent.js'),'utf8'), {
  module:target, exports:target.exports, console, performance, Buffer, setTimeout, clearTimeout,
  process:{env:{OPENAI_API_KEY:'test',MOONSHOT_API_KEY:'test',SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_KEY:'test'}},
  require(name) {
    if(name==='dotenv')return {config(){}};
    if(name==='openai')return class {constructor(){this.chat={completions:{create:blocked}};this.embeddings={create:blocked};}};
    if(name==='@supabase/supabase-js')return {createClient:()=>({rpc:blocked,from:blocked})};
    if(name==='./channel_context')return require('./channel_context');
    if(name==='./knowledge_current')return knowledge;
    if(name==='./knowledge_current.json')return pack;
    if(name==='./knowledge_index')return require('./knowledge_index');
    throw Error(name);
  }
});
const build = facts => target.exports.buildSystemPrompt({facts,examples:[{trigger:'private',reply:'PRIVATE_STYLE_SENTINEL'}],firstTurn:true,channel:'web'});
test('unreviewed admin and archived style cannot inject old business terms',()=>{
  const prompt=build([{priority:true,content:'LEGACY_SENTINEL full coverage $1000 deductible; use DMV paper forms'}]);
  assert(!prompt.includes('LEGACY_SENTINEL'));assert(!prompt.includes('PRIVATE_STYLE_SENTINEL'));
  assert(prompt.includes('Баркай'));assert(prompt.includes('веб-чате'));
});
test('current tariffs preserve start date and liability/deposit distinction',()=>{
  const prompt=build([]);
  for(const term of ['2027-01-01','New Style','Old School Style','2500','3500','4500','НЕ требование депозита $5000'])assert(prompt.includes(term),term);
  assert(!prompt.includes('бесплатная неделя за 6 месяцев'));
});
test('retired forms and absolute second-driver prohibition cannot recur',()=>{
  const prompt=build([]);
  assert(prompt.includes('бланки отменены'));
  assert(!prompt.includes('нужны ВСЕ шесть'));
  assert(!prompt.includes('Арендатору категорически нельзя'));
  assert(prompt.includes('предварительного подтверждённого допуска'));
});
test('deposit deadline, takeover escalation and factual limits remain explicit',()=>{
  const prompt=build([]);
  assert(prompt.includes('30 календарных дней после окончания аренды'));
  assert(!prompt.includes('после возврата машины и урегулирования долгов'));
  assert(prompt.includes('[[ESCALATE]]'));
  assert(prompt.includes('Не утверждай, что сообщение доставлено'));
});
test('service and crash safety survive cleanup',()=>{
  const prompt=build([]);
  for(const term of ['6 000','7 000','каждой второй замене масла','911','не советуй скрывать свою страховку'])assert(prompt.includes(term),term);
});
test('all archived rows accounted for and internal content excluded',()=>{
  assert.equal(pack.mapping.length,211);
  assert.equal(new Set(pack.mapping.map(x=>x.hash)).size,211);
  for(const row of pack.mapping){for(const topic of row.topics)assert(pack.topics[topic]);if(['archive','internal','verify'].includes(row.decision))assert.equal(row.topics.length,0);}
  assert(!pack.topics.owner_workflow);
});

test('failed retrieval still supplies weekly payment and READY safety boundaries',()=>{
  const prompt=build([]);
  for(const term of ['еженедельно авансом','READY','12-вольтовой','НЕ обязательный минимальный','Ставка $600 не предлагается'])assert(prompt.includes(term),term);
  assert(!prompt.includes('предложи сделать это здесь без перехода'));
  assert(prompt.includes('Личному ассистенту Алексу по установленному рабочему каналу'));
});
