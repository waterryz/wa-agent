'use strict';
const {createHmac,randomBytes}=require('node:crypto'),{isIP}=require('node:net');
const VERSION='2026-11-01.1';
const normal=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[.!?,…]+$/g,'').replace(/\s+/g,' ').trim();
const closing=/^(?:stop|стоп|не продолжай(?: этот разговор)?|спасибо(?:,? вопрос реш[её]н)?|вопрос реш[её]н|до свидания|пока|thanks|thank you|bye|goodbye|მადლობა|ნახვამდის)$/i;
const phrases={ru:{closed:'Понял. До связи.',paused:'Разговор временно приостановлен из-за повторяющихся сообщений. Попробуйте через 15 минут.',busy:'Слишком много запросов. Подождите минуту.',repeat:'На этот вопрос уже ответил. Если нужно уточнение, напишите, что осталось непонятно.'},en:{closed:'Understood. Take care.',paused:'This conversation is paused for repeated messages. Please try again in 15 minutes.',busy:'Too many requests. Please wait a minute.',repeat:'I have answered that question. Please say what needs clarification.'},ka:{closed:'გასაგებია. ნახვამდის.',paused:'განმეორებითი შეტყობინებების გამო საუბარი დროებით შეჩერებულია. სცადეთ 15 წუთში.',busy:'ძალიან ბევრი მოთხოვნაა. გთხოვთ, მოიცადოთ ერთი წუთი.',repeat:'ამ კითხვას უკვე ვუპასუხე. დაწერეთ, რისი დაზუსტება გჭირდებათ.'}};
function createDialogueGuard({now=Date.now,maxEntries=5000}={}){
 const sessions=new Map(),ips=new Map(),salt=randomBytes(32);
 const hash=s=>createHmac('sha256',salt).update(String(s)).digest('hex');
 function prune(map){const t=now();for(const[k,v]of map)if(v.expires<=t)map.delete(k);while(map.size>=maxEntries)map.delete(map.keys().next().value);}
 function begin({id,ip,text,language='ru',hasAttachment=false}){
  prune(sessions);prune(ips);const t=now(),key=hash(id),ipkey=isIP(ip||'')?hash(ip):null;
  const p=phrases[language]||phrases.ru;
  const deny=(reason,reply,seconds=0)=>({allowed:false,reason,reply,retryAfter:seconds});
  let rate=ipkey&&ips.get(ipkey);if(ipkey&&!rate){rate={count:0,active:0,expires:t+60000};ips.set(ipkey,rate);}
  if(rate&&(rate.count>=60||rate.active>=4))return deny('ip_rate_limit',p.busy,Math.max(1,Math.ceil((rate.expires-t)/1000)));
  if(rate)rate.count++;
  let s=sessions.get(key);if(!s){s={expires:t+1800000,last:'',repeat:0,active:false,pausedUntil:0};sessions.set(key,s);}
  if(s.pausedUntil>t)return deny('session_pause',p.paused,Math.ceil((s.pausedUntil-t)/1000));
  const n=normal(text);
  if(!hasAttachment&&closing.test(n)){s.closed=true;s.expires=t+1800000;return deny('conversation_closed',p.closed);}
  if(s.active)return deny('session_inflight',p.busy,10);
  if(!hasAttachment&&n&&n===s.last){s.repeat++;if(s.repeat>=2){s.pausedUntil=t+900000;s.expires=s.pausedUntil;return deny('session_pause',p.paused,900);}return deny('duplicate_answered',p.repeat);}
  s.closed=false;s.active=true;s.expires=t+1800000;if(rate)rate.active++;
  let done=false;
  return{allowed:true,finish(success){if(done)return;done=true;s.active=false;if(rate)rate.active=Math.max(0,rate.active-1);if(success){s.last=hasAttachment?'':n;s.repeat=0;}}};
 }
 return{begin};
}
// Only the documented Railway ingress header, never caller-supplied body/IP/XFF.
// Outside Railway use the direct peer; this is cost protection, not authentication.
function clientIP(req,railway=Boolean(process.env.RAILWAY_ENVIRONMENT_ID)){
 const ip=railway?req.get('x-real-ip'):req.socket?.remoteAddress;
 return typeof ip==='string'&&isIP(ip)?ip:null;
}
module.exports={createDialogueGuard,clientIP,VERSION};
