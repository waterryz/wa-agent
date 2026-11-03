'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ENDPOINT = '/messenger/webhook';
const MAX_AGE = 24 * 60 * 60 * 1000;
const KEEP = 7 * MAX_AGE;
const LABELS = { ru: 'Русский', en: 'English', ka: 'ქართული' };
const INTRO = {
  ru: 'Я ИИ-ассистент Prime Fusion.',
  en: 'I’m the Prime Fusion AI assistant.',
  ka: 'მე Prime Fusion-ის ხელოვნური ინტელექტის ასისტენტი ვარ.'
};
const INVITATION = { ru: 'Чем могу помочь?', en: 'How can I help?', ka: 'რით შემიძლია დაგეხმაროთ?' };
const UNSUPPORTED = { ru: 'Пожалуйста, напишите вопрос текстом.', en: 'Please send your question as text.', ka: 'გთხოვთ, კითხვა ტექსტურად მომწეროთ.' };

function validSignature(raw, signature, secret) {
  if (!Buffer.isBuffer(raw) || !/^sha256=[a-f\d]{64}$/.test(signature || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

function languageChoice(text) {
  const value = String(text || '').trim().toLowerCase();
  return Object.keys(LABELS).find(code => [code, `language:${code}`, LABELS[code].toLowerCase()].includes(value));
}

function languagePrompt() {
  return {
    text: 'Выберите язык общения / Choose your language / აირჩიეთ ენა',
    quick_replies: Object.entries(LABELS).map(([code, title]) => ({ content_type: 'text', title, payload: `language:${code}` }))
  };
}

function createWorker({ db, pageId, appId, allowSender, matchesPairing, answer, send, now = Date.now }) {
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS messenger_session (
      page TEXT, sender TEXT, locale TEXT, pending TEXT, asked INTEGER DEFAULT 0,
      hold INTEGER DEFAULT 0, last_seen INTEGER DEFAULT 0, PRIMARY KEY(page,sender));
    CREATE TABLE IF NOT EXISTS messenger_inbox (
      seq INTEGER PRIMARY KEY, page TEXT, sender TEXT, mid TEXT, at INTEGER,
      text TEXT, choice TEXT, state TEXT DEFAULT 'queued', reply TEXT, accepted_id TEXT,
      UNIQUE(page,mid));
    CREATE INDEX IF NOT EXISTS messenger_queue ON messenger_inbox(state,seq);
    CREATE INDEX IF NOT EXISTS messenger_history ON messenger_inbox(page,sender,seq);
    CREATE TABLE IF NOT EXISTS messenger_test_pair (page TEXT PRIMARY KEY, sender TEXT NOT NULL);
  `);
  const exec = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const allowed = sender => allowSender(sender) || (matchesPairing && get('SELECT sender FROM messenger_test_pair WHERE page=?',pageId)?.sender===sender);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const hold = (page, sender) => exec('UPDATE messenger_session SET hold=1 WHERE page=? AND sender=?', page, sender);
  // One Railway replica owns this local volume. A crash during a paid call or
  // sending has an unknown result. Reconciliation is manual, never a replay.
  transaction(() => {
    for (const row of db.prepare("SELECT DISTINCT page,sender FROM messenger_inbox WHERE state='working'").all()) hold(row.page,row.sender);
    exec("UPDATE messenger_inbox SET state='unknown' WHERE state='working'");
  });

  function ingest(payload) {
    return transaction(() => {
      for (const entry of payload.entry) {
        if (entry?.id !== pageId || !Array.isArray(entry.messaging)) continue;
        for (const event of entry.messaging) {
          const message = event?.message;
          if (message?.is_echo) {
            const recipient = event.recipient?.id;
            if (event.sender?.id === pageId && typeof recipient === 'string' && allowed(recipient) && String(message.app_id || '') !== appId) {
              exec('INSERT OR IGNORE INTO messenger_session(page,sender) VALUES(?,?)',pageId,recipient);
              hold(pageId,recipient);
            }
            continue;
          }
          const sender = event?.sender?.id;
          if (event?.recipient?.id !== pageId || typeof sender !== 'string' || !/^\d+$/.test(sender)) continue;
          const at = event.timestamp;
          if (typeof message?.mid !== 'string' || !message.mid || !Number.isSafeInteger(at) || at > now()+60000 || now()-at >= MAX_AGE) continue;
          let text = typeof message.text === 'string' ? message.text.slice(0,10000) : '';
          const pair = text.match(/(?:^|\s)#test:([^\s]{1,256})\s*$/u);
          if (pair) {
            text = text.slice(0,pair.index).trim();
            if (matchesPairing && matchesPairing(pair[1])) exec('INSERT OR IGNORE INTO messenger_test_pair(page,sender) VALUES(?,?)', pageId,sender);
          }
          if (!allowed(sender)) continue;
          const choice = typeof message.quick_reply?.payload === 'string' ? message.quick_reply.payload.slice(0,100) : '';
          const inserted = exec('INSERT OR IGNORE INTO messenger_inbox(page,sender,mid,at,text,choice) VALUES(?,?,?,?,?,?)',pageId,sender,message.mid,at,text,choice);
          if (!inserted.changes) continue;
          exec(`INSERT INTO messenger_session(page,sender,last_seen) VALUES(?,?,?) ON CONFLICT(page,sender) DO UPDATE SET last_seen=max(last_seen,excluded.last_seen)`,pageId,sender,at);
          if (/^(stop|стоп|остановись|остановить|შეჩერება)[.!\s]*$/iu.test(text.trim())) hold(pageId,sender);
        }
      }
    });
  }

  let busy = false;
  async function processOne() {
    if (busy) return false;
    busy = true;
    let row;
    try {
      row = transaction(() => {
        const next = get(`SELECT i.* FROM messenger_inbox i JOIN messenger_session s USING(page,sender) WHERE i.page=? AND i.state='queued' AND s.hold=0 ORDER BY i.seq LIMIT 1`, pageId);
        if (next) exec("UPDATE messenger_inbox SET state='working' WHERE seq=?",next.seq);
        return next;
      });
      if (!row) return false;
      const live = () => allowed(row.sender) && now()-row.at < MAX_AGE && !get('SELECT hold FROM messenger_session WHERE page=? AND sender=?',pageId,row.sender)?.hold;
      const skip = () => exec("UPDATE messenger_inbox SET state='skipped' WHERE seq=?",row.seq);
      if (!live()) { skip(); return true; }
      const session = get('SELECT * FROM messenger_session WHERE page=? AND sender=?',pageId,row.sender);
      let locale = session.locale, pending = session.pending, output;
      if (!session.asked || (!locale && !languageChoice(row.choice || row.text))) {
        if (!session.asked) pending = languageChoice(row.choice || row.text) ? '' : row.text;
        output = languagePrompt();
      } else {
        const selected = !locale;
        if (selected) locale = languageChoice(row.choice || row.text);
        const question = selected ? pending : row.text;
        let response = selected ? INVITATION[locale] : UNSUPPORTED[locale];
        if (question) {
          const previous = db.prepare(`SELECT text,reply FROM messenger_inbox WHERE page=? AND sender=? AND state='answered' AND text<>'' ORDER BY seq DESC LIMIT 5`).all(pageId,row.sender).reverse();
          const history = previous.flatMap(turn => [{role:'user',content:turn.text},{role:'assistant',content:turn.reply}]);
          response = await answer({pageId,sender:row.sender,locale,text:question,history});
          if (typeof response !== 'string' || !response.trim()) throw Error('No answer');
        }
        output = {text: selected ? `${INTRO[locale]}\n\n${response.trim()}` : response.trim()};
        // Store the actual opening question as history, not its quick-reply label.
        if (selected) exec('UPDATE messenger_inbox SET text=? WHERE seq=?',question || '',row.seq);
        pending = null;
      }
      if (!live()) { skip(); return true; }
      const chars = Array.from(output.text);
      if (chars.length>1900) output.text=chars.slice(0,1899).join('')+'…';
      const receipt = await send(row.sender,output);
      if (typeof receipt !== 'string' || !receipt) throw Error('Missing acceptance');
      transaction(() => {
        exec('UPDATE messenger_session SET locale=?,pending=?,asked=1 WHERE page=? AND sender=?',locale||null,pending,pageId,row.sender);
        exec('UPDATE messenger_inbox SET state=?,reply=?,accepted_id=? WHERE seq=?',locale?'answered':'asked',output.text,receipt,row.seq);
      });
      return true;
    } catch (err) {
      if (!row) throw err;
      transaction(() => { exec("UPDATE messenger_inbox SET state='unknown' WHERE seq=?",row.seq); hold(pageId,row.sender); });
      console.error('Messenger event held for reconciliation; automatic retry disabled');
      return false;
    } finally { busy = false; }
  }
  function prune() {
    exec("DELETE FROM messenger_inbox WHERE at < ? AND state NOT IN ('working','unknown')", now()-KEEP);
    exec('DELETE FROM messenger_session WHERE last_seen < ? AND hold=0 AND NOT EXISTS(SELECT 1 FROM messenger_inbox i WHERE i.page=messenger_session.page AND i.sender=messenger_session.sender)', now()-KEEP);
  }
  return {ingest,processOne,prune};
}

function mountMessenger(app,express,{env=process.env, verification=require('./verification.cjs'), fetchImpl=globalThis.fetch}={}) {
  const verify = verification.matches;
  app.get(ENDPOINT,(req,res) => {
    const q=req.query;
    if(q['hub.mode']!=='subscribe' || typeof q['hub.verify_token']!=='string' || typeof q['hub.challenge']!=='string' || !verify(q['hub.verify_token'])) return res.sendStatus(403);
    return res.type('text/plain').send(q['hub.challenge']);
  });
  const pageId=env.META_PAGE_ID || '886266774570877', appId=env.META_APP_ID || '1627739205746711';
  const mount=env.RAILWAY_VOLUME_MOUNT_PATH, version=env.META_GRAPH_VERSION || 'v26.0';
  const allowSender = id => env.META_LIVE_APPROVED==='1' || id===env.META_TEST_PSID;
  const matchesPairing = env.META_LIVE_APPROVED!=='1' && !env.META_TEST_PSID && typeof verification.matchesPairing==='function' ? verification.matchesPairing : null;
  let worker;
  if(pageId==='886266774570877' && env.META_APP_SECRET && env.META_PAGE_ACCESS_TOKEN && /^v\d+\.\d+$/.test(version) && mount && path.isAbsolute(mount) && fs.existsSync(mount) && (matchesPairing || env.META_LIVE_APPROVED==='1' || /^\d+$/.test(env.META_TEST_PSID||''))) {
    try {
      const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(path.join(mount,'prime-fusion-messenger.sqlite'));
      worker=createWorker({db,pageId,appId,allowSender,matchesPairing,answer:require('./answer.cjs').answer,
        send:async(sender,message) => {
          const r=await fetchImpl(`https://graph.facebook.com/${version}/${pageId}/messages`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.META_PAGE_ACCESS_TOKEN},body:JSON.stringify({recipient:{id:sender},messaging_type:'RESPONSE',message})});
          if(!r.ok)throw Error('Send rejected');
          const result=await r.json();
          return result.recipient_id===sender && result.message_id;
        }});
      worker.prune();
      const tick=()=>worker.processOne().catch(()=>console.error('Messenger worker unavailable'));
      setInterval(tick,500).unref();
      setInterval(()=>{try{worker.prune();}catch{console.error('Messenger retention failed');}},3600000).unref();
    } catch { worker=null; console.error('Messenger worker initialization failed'); }
  }
  app.post(ENDPOINT,express.raw({type:'application/json',limit:'1mb',inflate:false}), (req,res)=>{
    if(!worker)return res.sendStatus(503);
    if(!validSignature(req.body,req.get('X-Hub-Signature-256'),env.META_APP_SECRET))return res.sendStatus(403);
    let body;try{body=JSON.parse(req.body.toString('utf8'));}catch{return res.sendStatus(400);}
    if(body?.object!=='page'||!Array.isArray(body.entry))return res.sendStatus(400);
    try{worker.ingest(body);return res.sendStatus(200);}catch{return res.sendStatus(503);}
  });
}

module.exports={mountMessenger,createWorker,validSignature};
