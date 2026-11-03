'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const crypto=require('node:crypto');
const {createWorker,validSignature,mountMessenger,pilotSummary,logPilotEnvelope}=require('./runtime.cjs');
const page='886266774570877',sender='1000001',app='1627739205746711';
const ts=1700000000000;
function event(mid,text,opts={}) {return {sender:{id:sender},recipient:{id:page},timestamp:ts,message:{mid,text},...opts};}
function body(...messaging){return {object:'page',entry:[{id:page,messaging}]};}
function rig(opts={}) {
 const db=opts.db || new DatabaseSync(':memory:'),calls=[],sent=[];
 const worker=createWorker({db,pageId:page,appId:app,now:()=>ts,allowSender:id=>id===sender,answer:async args=>{calls.push(args);return {ru:'Ответ.',en:'Answer.',ka:'პასუხი.'}[args.locale]},send:async(id,msg)=>{sent.push({id,msg});return 'accepted-test'},...opts});
 return {db,calls,sent,...worker};
}
for(const [locale,expected] of [['ru','Ответ.'],['en','Answer.'],['ka','პასუხი.']]) {
 test(`first question survives until ${locale} selection; duplicate callbacks cause no replays`,async()=>{
  const w=rig();const question=body(event('q','Какие машины?'));w.ingest(question);w.ingest(question);await w.processOne();assert.equal(w.calls.length,0);assert.match(w.sent[0].msg.text,/^Здравствуйте! Я Баркая, виртуальный помощник Prime Fusion\..*условиях аренды.*заполнить заявку\.[\s\S]+Выберите язык/);assert.equal(w.sent[0].msg.quick_replies.length,3);
  const choice=body(event('lang','irrelevant display',{message:{mid:'lang',quick_reply:{payload:'language:'+locale}}}));w.ingest(choice);w.ingest(choice);await w.processOne();assert.equal(w.sent.length,2);assert.equal(w.calls[0].text,'Какие машины?');assert.equal(w.calls[0].locale,locale);assert.equal(w.sent[1].msg.text,expected);
  w.ingest(body(event('more','Ещё вопрос')));await w.processOne();assert.equal(w.sent.length,3);assert.equal(w.sent[2].msg.text,expected);assert.equal(w.calls[1].history[0].content,'Какие машины?');assert.equal(await w.processOne(),false);
 });
}
test('paired owner only, one winner, test code removed before storage and engine',async()=>{
 const secret='a'.repeat(64),w=rig({allowSender:()=>false,matchesPairing:code=>code===secret});
 w.ingest(body(event('stranger','Hello'),event('q','Вопрос #test:'+secret),event('other','Question #test:'+secret,{sender:{id:'200'}}),event('lang','Русский')));
 await w.processOne();await w.processOne();assert.equal(w.calls[0].text,'Вопрос');assert(!JSON.stringify(w.db.prepare('SELECT * FROM messenger_inbox').all()).includes(secret));assert.deepEqual(w.sent.map(s=>s.id),[sender,sender]);
});
test('unknown outcome holds sender and restart never resends',async()=>{
 let calls=0;const w=rig({send:async()=>{calls++;throw Error('ambiguous timeout')}});w.ingest(body(event('q','Вопрос')));await w.processOne();assert.equal(calls,1);const restart=rig({db:w.db});restart.ingest(body(event('q','Вопрос'),event('next','ещё')));assert.equal(await restart.processOne(),false);assert.equal(restart.sent.length,0);
});
test('in-flight record found on startup is never redelivered',async()=>{const w=rig();w.ingest(body(event('q','Вопрос')));w.db.exec("UPDATE messenger_inbox SET state='working'");const restart=rig({db:w.db});assert.equal(await restart.processOne(),false);assert.equal(w.db.prepare('SELECT state FROM messenger_inbox').get().state,'unknown');});
test('STOP and staff takeover suppress queued responses; own echoes ignored',async()=>{
 for(const boundary of [event('stop','STOP'),{sender:{id:page},recipient:{id:sender},message:{is_echo:true}}]){const w=rig();w.ingest(body(event('q','Вопрос'),boundary));assert.equal(await w.processOne(),false);}
 const w=rig();w.ingest(body(event('q','Вопрос'),{sender:{id:page},recipient:{id:sender},message:{is_echo:true,app_id:app}}));assert.equal(await w.processOne(),true);assert.equal(w.sent.length,1);
});
test('expired questions never sent; timestamps and page restricted',async()=>{
 let time=ts;const w=rig({now:()=>time});w.ingest(body(event('q','Question'),event('invalid','Wrong Page',{recipient:{id:'other'}})));time+=86400000;await w.processOne();assert.equal(w.sent.length,0);assert.equal(w.db.prepare('SELECT COUNT(*) n FROM messenger_inbox').get().n,1);
});
test('verification unaffected by missing sender or SQLite; POST fails closed',()=>{
 let get,post;const response={sendStatus(status){return status},type(){return this},send(body){return body}};
 mountMessenger({get:(_,fn)=>get=fn,post:(_,raw,fn)=>post=fn},{raw:()=>{}},{env:{},verification:{matches:v=>v==='ok'}});
 assert.equal(get({query:{'hub.mode':'subscribe','hub.verify_token':'ok','hub.challenge':'challenge'}},response),'challenge');assert.equal(get({query:{}},response),403);assert.equal(post({},response),503);
});
test('signature compares exact body bytes',()=>{const a=Buffer.from('{"x":1}'),sig='sha256='+crypto.createHmac('sha256','test').update(a).digest('hex');assert(validSignature(a,sig,'test'));assert(!validSignature(Buffer.from('{"x": 1}'),sig,'test'));assert(!validSignature(a,'invalid','test'));});

test('owner diagnostics are read-only and omit all unrelated traffic and identifiers',async t=>{
 const matches=code=>code==='synthetic',w=rig({allowSender:()=>true,matchesPairing:matches});
 const other=event('other','separate',{sender:{id:'200'}}),owner=event('pilot','Question #test:synthetic');
 w.ingest(body(other)); await w.processOne();
 assert.deepEqual({...pilotSummary(w.db,page)},{paired:0,session_asked:0,session_hold:0,asked:0,answered:0,queued:0,unknown:0,skipped:0});
 w.ingest(body(owner)); await w.processOne();w.ingest(body(event('stop','STOP')));
 w.db.exec('PRAGMA query_only=ON');
 assert.deepEqual({...pilotSummary(w.db,page)},{paired:1,session_asked:1,session_hold:1,asked:1,answered:0,queued:1,unknown:0,skipped:0});
 const logs=t.mock.method(console,'log',()=>{});
 const payload=body(other,owner);payload.entry[0].standby=[owner,other];
 logPilotEnvelope(w.db,page,payload,matches);
 assert.deepEqual(logs.mock.calls.map(c=>c.arguments),[['Messenger owner pilot marker','messaging','accepted'],['Messenger owner pilot marker','standby','skipped']]);
});
