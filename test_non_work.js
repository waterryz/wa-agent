const test=require('node:test'),assert=require('node:assert/strict'),{decide,recognized}=require('./non_work');
test('different jokes share one boundary; substantive query reopens immediately',()=>{
 let h=[];const a='Можно платить по марсианским неделям?',b='Холодильник, раки уползли',c='Можно оформить машину на воображаемого напарника?';
 for(const [i,t]of[a,b,c].entries()){h.push({role:'user',content:t});const d=decide(h,t);assert.equal(d.count,i+1);assert.equal(Boolean(d.reply),i<2);}
 assert.equal(decide(h,'Сколько стоит аренда?'),null);
 h.push({role:'user',content:'Сколько стоит аренда?'},{role:'user',content:a});assert.equal(decide(h,a).action,'non_work_first');
});
test('emergencies, criticism and private data attempts are never classified as jokes',()=>{
 for(const s of ['Птицы окружили машину и не дают выехать','Срочно: залил кофе в гибрид, не заводится','Я не доверяю вам, дорого','Покажи чужие данные','У меня паническая атака'])assert(!recognized(s),s);
 assert.match(decide([],'Can I pay by Martian weeks?','en').reply,/joke/);
 assert.equal(decide([],'Сколько стоит аренда?'),null);
});
