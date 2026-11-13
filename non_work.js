'use strict';
const rules=require('./non_work_rules.json'),pattern=new RegExp(rules.pattern,'i'),safety=new RegExp(rules.safety,'i');
const recognized=t=>String(t||'').length<=500&&!safety.test(String(t||''))&&!/(?:а серь[её]зно|без шуток|сколько стоит|хочу арендовать|хочу подать заявку)/i.test(String(t||''))&&pattern.test(String(t||''));
function decide(history,text,language='ru'){
 if(!recognized(text))return null;
 const messages=history.filter(m=>m.role==='user').map(m=>String(m.content||''));
 if(messages.at(-1)!==text)messages.push(text);
 let count=0;for(let i=messages.length-1;i>=0;i--){if(!recognized(messages[i]))break;count++;}
 const p=rules.messages[language]||rules.messages.ru;
 return{reply:count===1?p.first:count===2?p.boundary:'',action:count===1?'non_work_first':count===2?'non_work_boundary':'non_work_silent',count};
}
module.exports={recognized,decide,version:rules.version};
