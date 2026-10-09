// twilio_whatsapp_adapter.js
// Isolated Twilio WhatsApp adapter for the FAQ assistant. Disabled by default.
// Owner-only pilot. Does NOT touch Telegram or the legacy whatsapp-web.js adapter.
// Single process/replica only.
//
// Signature verification: official Twilio SDK only (twilio.validateRequest),
// pinned dependency "twilio": "6.1.2". The URL passed to the validator is the
// EXACT webhook URL configured in the Twilio console (verbatim, query string
// included) — never reconstructed from Host / X-Forwarded-* headers.
//
// Safety model:
// - Nothing is persisted before a valid signature (not even counters).
// - Accept order: dedupe sentinel -> inbound record -> job file -> TwiML ack.
//   Crash between sentinel and job write is detected on start(): the sentinel
//   is removed and counted as lost_inbound so a Twilio retry can be accepted;
//   an orphaned inbound record gets its job recreated.
// - Outbound is persisted as pending-send BEFORE the network call. Timeout,
//   network error, HTTP 429/5xx, redirect, or malformed 201 => 'unknown', NEVER
//   auto-retried. Other HTTP 4xx with a Twilio error => terminal 'failed' (known).
// - Status callbacks are authenticated, monotonic, and can never authorize a
//   send. delivered/read -> failed/undelivered is treated as a contradiction
//   and ignored. Callbacks for unknown SIDs are stored under uncorrelated/
//   for operator review.
// - STOP is honored immediately: opt-out flag, queued jobs for that sender
//   cancelled, in-flight sends refused at send time. Only explicit START
//   re-enables; unrelated messages never do.
'use strict';


const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio'); // pinned "twilio": "6.1.2"


const EXTERNAL_ID_PREFIX = 'wa-twilio:'; // new namespace; legacy numeric ids keep the old route
const DEFAULT_API_BASE = 'https://api.twilio.com';
const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;
const STATUS_ORDER = { sent: 1, delivered: 2, read: 3, failed: 4, undelivered: 4 };
const SEEN_DELIVERED = new Set(['delivered', 'read']);
const SID_RE = /^SM[0-9a-fA-F]{32}$/;
const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'стоп']);
const OPT_IN_WORDS = new Set(['start', 'unstop', 'старт']);
const MEDIA_NOTE = 'Please send your message as text. / Пожалуйста, отправьте сообщение текстом.';


const digitsOnly = (v) => String(v || '').replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
const convKeyOf = (toDigits) => EXTERNAL_ID_PREFIX + toDigits;


function signatureOk(authToken, signature, url, params) {
  try { return twilio.validateRequest(authToken, signature, url, params) === true; }
  catch { return false; }
}


function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, p);
}
function createOnce(p) { // atomic dedupe reservation; true if we won
  try { fs.writeFileSync(p, '', { flag: 'wx' }); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
}


function createTwilioWhatsAppAdapter(opts) {
  const {
    enabled = false,
    stateDir, accountSid, authToken, senderNumber, ownerNumber,
    publicInboundUrl, publicStatusUrl, // must EXACTLY match Twilio console webhook URLs (query string included)
    core, onEscalation = () => {},
    dailyCap = 50, maxMessageLength = 2000,
    httpPost, // injectable; default uses global fetch against apiBase with redirect:'error'
    apiBase = DEFAULT_API_BASE, // production MUST leave the default (fixed api.twilio.com)
    nowImpl = () => Date.now(),
    sendTimeoutMs = 15000,
  } = opts || {};


  const sender = digitsOnly(senderNumber);
  const owner = digitsOnly(ownerNumber);
  const reasons = [];
  if (enabled) {
    if (!stateDir || !fs.existsSync(stateDir) || !fs.statSync(stateDir).isDirectory())
      reasons.push('stateDir missing/not a directory (refusing implicit cwd state)');
    for (const [k, v] of [['accountSid', accountSid], ['authToken', authToken],
        ['senderNumber', sender], ['ownerNumber', owner],
        ['publicInboundUrl', publicInboundUrl], ['publicStatusUrl', publicStatusUrl]])
      if (!v) reasons.push(k + ' missing');
    for (const [k, v] of [['publicInboundUrl', publicInboundUrl], ['publicStatusUrl', publicStatusUrl]])
      if (v && !/^https:\/\//i.test(v)) reasons.push(k + ' must be https');
  }
  const ready = enabled && reasons.length === 0;
  const disabledReason = ready ? null : (enabled ? reasons.join('; ') : 'TWILIO_WA_ENABLED != 1');
  let stopped = false;


  const D = (name) => path.join(stateDir || '/nonexistent', name);
  const SUBDIRS = ['sids', 'inbound', 'outbox', 'msgstatus', 'uncorrelated', 'optout', 'holds', 'last_inbound', 'counters'];
  if (ready) for (const n of SUBDIRS) fs.mkdirSync(D(n), { recursive: true });


  let stateError = null; // fail-closed: set on any corrupt/unreadable state file; never reset limits/dedupe
  function readJsonStrict(p) {
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return undefined; throw e; }
    try { return JSON.parse(raw); }
    catch { stateError = 'corrupt: ' + p; throw new Error('corrupt state file: ' + p); }
  }

  const countersPath = () => D(path.join('counters', 'counters.json'));
  function bump(name, by = 1) {
    if (!ready) return; // no state at all unless fully configured+enabled
    const c = readJsonStrict(countersPath()) || {}; // throws (fail closed) on corrupt; never silently resets
    c[name] = (c[name] || 0) + by;
    try { writeJsonAtomic(countersPath(), c); } catch {}
  }
  const utcDay = () => new Date(nowImpl()).toISOString().slice(0, 10);
  const dailyPath = () => D(path.join('counters', 'daily-' + utcDay() + '.json'));
  function dailyCount() { const d = readJsonStrict(dailyPath()); return (d && d.count) || 0; } // throws (fail closed) on corrupt; never defaults the limit to 0
  function dailyIncr() {
    const d = readJsonStrict(dailyPath()) || {};
    writeJsonAtomic(dailyPath(), { count: (d.count || 0) + 1 });
  }


  const defaultHttpPost = async ({ urlPath, authHeader, form }) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), sendTimeoutMs);
    try {
      const res = await fetch(apiBase + urlPath, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form, signal: ctrl.signal, redirect: 'error', // never follow redirects (no credential leak)
      });
      let json = null; try { json = await res.json(); } catch {}
      return { status: res.status, json };
    } finally { clearTimeout(t); }
  };
  const post = httpPost || defaultHttpPost;


  const optoutPath = (toDigits) => D(path.join('optout', toDigits + '.json'));
  function lastInboundAt(toDigits) {
    const d = readJsonStrict(D(path.join('last_inbound', toDigits + '.json')));
    return (d && d.at) || 0;
  }


  // ---- outbound: persisted BEFORE network; unknown never auto-retried ----
  async function deliverText(convKey, toDigits, text, label) {
    if (!ready || stopped) return { ok: false, outcome: stopped ? 'stopped' : 'disabled' };
    if (toDigits !== owner) return { ok: false, outcome: 'not-owner' };
    if (fs.existsSync(optoutPath(toDigits))) return { ok: false, outcome: 'opted-out' };
    const last = lastInboundAt(toDigits);
    if (!last || nowImpl() - last > TWENTY_FOUR_H) return { ok: false, outcome: 'window-expired' };
    if (String(text).length > maxMessageLength) return { ok: false, outcome: 'too-long' };
    if (dailyCount() >= dailyCap) return { ok: false, outcome: 'cap-exceeded' }; // no bypass: total sends stay <= cap
    dailyIncr();


    const jobId = 'send-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const jobPath = D(path.join('outbox', jobId + '.json'));
    writeJsonAtomic(jobPath, { id: jobId, kind: 'send', label, convKey, to: toDigits,
      body: String(text), status: 'pending-send', createdAt: nowImpl(), providerSid: null });
    const authHeader = 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64');
    const form = new URLSearchParams({
      To: 'whatsapp:' + toDigits, From: 'whatsapp:' + sender, Body: String(text),
      StatusCallback: publicStatusUrl, // explicit per-message status callback
    }).toString();
    let outcome, providerSid = null, detail = null;
    try {
      const r = await post({ urlPath: '/2010-04-01/Accounts/' + accountSid + '/Messages.json', authHeader, form });
      if (r.status === 201 && r.json && SID_RE.test(r.json.sid || '')) {
        outcome = 'sent'; providerSid = r.json.sid;
        let initial = 'sent';
        const hist = [{ at: nowImpl(), state: 'sent' }];
        const earlyPath = D(path.join('uncorrelated', providerSid + '.json'));
        if (fs.existsSync(earlyPath)) { // early callback arrived before the 201: reconcile, do not reset delivered/read to sent
          try {
            const early = readJsonStrict(earlyPath);
            const es = String(early && early.params && early.params.MessageStatus || '').toLowerCase();
            if ((STATUS_ORDER[es] || 0) > (STATUS_ORDER[initial] || 0)) {
              initial = es;
              hist.push({ at: nowImpl(), state: es, reconciled: true, errorCode: (early.params && early.params.ErrorCode) || null });
            }
          } catch {}
          try { fs.unlinkSync(earlyPath); } catch {}
          bump('status_reconciled');
        }
        writeJsonAtomic(D(path.join('msgstatus', providerSid + '.json')),
          { providerSid, convKey, state: initial, history: hist });
      } else if (r.status === 429) {
        outcome = 'unknown'; // rate-limited: uncertain, check console before any manual retry
        detail = 'http 429 rate-limited (uncertain outcome)';
      } else if (r.status >= 400 && r.status < 500) {
        outcome = 'failed'; // terminal KNOWN rejection (Twilio refused the request)
        detail = 'http ' + r.status + (r.json && r.json.code ? ' code ' + r.json.code : '');
      } else {
        outcome = 'unknown'; // 5xx / malformed 201 / anything else: uncertain, never auto-retry
        detail = 'http ' + r.status + ' (uncertain outcome)';
      }
    } catch (e) {
      outcome = 'unknown'; // timeout / network / redirect error: uncertain, never auto-retry
      detail = e && e.name === 'AbortError' ? 'timeout' : 'network: ' + (e && e.message);
    }
    writeJsonAtomic(jobPath, { id: jobId, kind: 'send', label, convKey, to: toDigits,
      body: String(text), status: outcome, createdAt: nowImpl(), providerSid, detail });
    bump(outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'unknown');
    return { ok: outcome === 'sent', outcome, providerSid, detail };
  }


  // ---- sequential worker: re-scans until empty; real stop() ----
  let pumping = false;
  function queuedJobs() {
    try {
      return fs.readdirSync(D('outbox'))
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJsonStrict(D(path.join('outbox', f)))) // throws on corrupt -> fail closed (stateError set)
        .filter((j) => j && j.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt);
    } catch (e) {
      if (stateError) throw e;
      return [];
    }
  }
  const jobPathOf = (id) => D(path.join('outbox', id + '.json'));
  async function processJob(job) {
    const jobPath = jobPathOf(job.id);
    const save = (s, extra = {}) => writeJsonAtomic(jobPath, { ...job, ...extra, status: s });
    if (job.from && fs.existsSync(optoutPath(job.from))) {
      save('cancelled', { detail: 'opted-out' }); bump('cancelled_optout'); return;
    }
    // cap + 24h window BEFORE any core work: a queued backlog must not burn model calls after cap
    const winAt = lastInboundAt(job.to);
    if (!winAt || nowImpl() - winAt > TWENTY_FOUR_H) { save('done', { detail: 'window-expired' }); bump('window_expired_skip'); return; }
    if (dailyCount() >= dailyCap) { save('done', { detail: 'cap-exceeded' }); bump('cap_exceeded_skip'); return; }
    save('processing');
    try {
      if (job.kind === 'ai') {
        const res = await core.processMessage({
          channel: 'whatsapp', external_id: job.convKey, message: job.body, language: null,
          contact: { name: job.profileName || null, phone: job.from }, is_driver: null, driver_id: null, images: null,
        });
        if (res && res.escalate) { try { onEscalation({ external_id: job.convKey, name: res.contact_name || null, question: res.user_text || job.body, reason: res.reason || null }); } catch {} }
        if (!res || res.operator_mode || res.reply == null) {
          writeJsonAtomic(D(path.join('holds', encodeURIComponent(job.convKey) + '.json')), { at: nowImpl(), convKey: job.convKey });
          save('done', { operatorHeld: true }); bump('operator_held'); return;
        }
        const d = await deliverText(job.convKey, job.to, res.reply, 'ai-reply');
        save('done', { sendOutcome: d.outcome, providerSid: d.providerSid || null });
      } else if (job.kind === 'note') {
        const d = await deliverText(job.convKey, job.to, job.body, job.label || 'note');
        save('done', { sendOutcome: d.outcome, providerSid: d.providerSid || null });
      }
    } catch {
      save('unknown', { detail: 'ai-error' }); bump('unknown'); // do not fabricate a model response
    }
  }
  async function pump() {
    if (pumping || !ready || stopped || stateError) return;
    pumping = true;
    try {
      for (;;) {
        if (stopped || stateError) break;
        let jobs;
        try { jobs = queuedJobs(); } catch { break; } // corrupt -> stateError set, fail closed
        if (jobs.length === 0) break;
        for (const job of jobs) {
          if (stopped || stateError) break;
          let fresh = null;
          try { fresh = readJsonStrict(jobPathOf(job.id)); } catch { break; }
          if (!fresh || fresh.status !== 'queued') continue; // cancelled/claimed meanwhile
          try { await processJob(fresh); } catch (e) { if (stateError) break; throw e; }
        }
      }
    } finally { pumping = false; }
  }
  const scheduleSoon = () => { if (!stopped) setImmediate(() => pump().catch(() => {})); };


  // ---- inbound webhook ----
  const twimlEmpty = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  const okTwiml = (res) => res.status(200).type('text/xml').send(twimlEmpty);


  function enqueueNote(from, sid, label, text) {
    if (!createOnce(D(path.join('sids', sid)))) return false; // dedupe refusals too
    const jobId = 'job-' + sid;
    writeJsonAtomic(jobPathOf(jobId),
      { id: jobId, kind: 'note', label, convKey: convKeyOf(from), from, to: from, body: text, status: 'queued', createdAt: nowImpl() });
    writeJsonAtomic(D(path.join('last_inbound', from + '.json')), { at: nowImpl() });
    writeJsonAtomic(D(path.join('inbound', sid + '.json')), { kind: 'note', label, sid, from, body: text, at: nowImpl() }); // typed receipt, after side effects
    scheduleSoon();
    return true;
  }


  function handleStop(from, sid) {
    writeJsonAtomic(optoutPath(from), { at: nowImpl(), via: sid });
    writeJsonAtomic(D(path.join('last_inbound', from + '.json')), { at: nowImpl() }); // STOP opens the 24h window too
    let cancelled = 0; // cancel queued jobs for this sender: no AI work, no sends after STOP
    try {
      for (const f of fs.readdirSync(D('outbox'))) {
        if (!f.endsWith('.json')) continue;
        const jp = D(path.join('outbox', f));
        let j; try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { continue; }
        if (j.status === 'queued' && j.from === from) {
          writeJsonAtomic(jp, { ...j, status: 'cancelled', detail: 'opted-out' }); cancelled++;
        }
      }
    } catch {}
    bump('opted_out'); bump('cancelled_optout', cancelled);
  }


  async function handleInbound(req, res) {
    if (!ready || stopped || stateError) return res.status(503).type('text/plain').send('rejected');
    const p = req.body || {};
    // official SDK validator; ALL form fields; URL verbatim as configured in Twilio console.
    // NOTHING is persisted before this passes (no counters, no files).
    if (!signatureOk(authToken, req.get('X-Twilio-Signature'), publicInboundUrl, p))
      return res.status(403).type('text/plain').send('rejected');
    bump('received');
    const bad = (counter) => { bump('rejected'); bump(counter); return res.status(403).type('text/plain').send('rejected'); };
    if (p.AccountSid !== accountSid) return bad('rejected_account');
    const rawTo = String(p.To || ''), rawFrom = String(p.From || '');
    if (!/^whatsapp:/i.test(rawTo) || !/^whatsapp:/i.test(rawFrom)) return bad('rejected_channel'); // channel strings required before number matching
    const to = digitsOnly(p.To), from = digitsOnly(p.From);
    if (to !== sender) return bad('rejected_recipient');
    if (from !== owner) return bad('rejected_sender'); // unapproved sender: before any AI work
    const sid = String(p.MessageSid || '');
    if (!SID_RE.test(sid)) { bump('rejected'); bump('rejected_sid_format'); return res.status(400).type('text/plain').send('rejected'); }


    const body = String(p.Body || '');
    const word = body.trim().toLowerCase();
    if (OPT_OUT_WORDS.has(word)) {
      if (!createOnce(D(path.join('sids', sid)))) { bump('duplicate'); return okTwiml(res); }
      handleStop(from, sid); // opt-out + window + cancel queued jobs
      writeJsonAtomic(D(path.join('inbound', sid + '.json')), { kind: 'stop', sid, from, at: nowImpl() }); // typed receipt, after side effects
      return okTwiml(res);
    }
    if (OPT_IN_WORDS.has(word)) {
      if (!createOnce(D(path.join('sids', sid)))) { bump('duplicate'); return okTwiml(res); }
      try { fs.unlinkSync(optoutPath(from)); } catch {}
      writeJsonAtomic(D(path.join('last_inbound', from + '.json')), { at: nowImpl() }); // START opens the 24h window
      writeJsonAtomic(D(path.join('inbound', sid + '.json')), { kind: 'start', sid, from, at: nowImpl() }); // typed receipt, after side effects
      bump('opted_in'); return okTwiml(res);
    }
    if (fs.existsSync(optoutPath(from))) { bump('rejected_optout'); return okTwiml(res); } // silent: no AI, no reply
    if (dailyCount() >= dailyCap) {
      bump('rejected_cap');
      const rkey = utcDay() + '-' + from; // at most ONE paid cap-refusal per sender per day
      if (fs.existsSync(D(path.join('counters', 'refusals', rkey)))) { bump('rejected_cap_silent'); return okTwiml(res); }
      if (enqueueNote(from, sid, 'cap-refusal',
          'Pilot daily limit reached. Please try tomorrow. / Дневной лимит пилота исчерпан. Попробуйте завтра.')) {
        fs.mkdirSync(D(path.join('counters', 'refusals')), { recursive: true });
        writeJsonAtomic(D(path.join('counters', 'refusals', rkey)), { at: nowImpl() });
      } else bump('duplicate');
      return okTwiml(res);
    }
    if (body.length > maxMessageLength) {
      if (enqueueNote(from, sid, 'length-refusal',
          'Message too long, please shorten it. / Сообщение слишком длинное, сократите его.')) bump('rejected_length');
      else bump('duplicate');
      return okTwiml(res);
    }
    if (!createOnce(D(path.join('sids', sid)))) { bump('duplicate'); return okTwiml(res); }


    const convKey = convKeyOf(from);
    const numMedia = parseInt(p.NumMedia || '0', 10) || 0;
    const profileName = p.ProfileName || null;
    writeJsonAtomic(D(path.join('inbound', sid + '.json')),
      { kind: 'message', sid, from, body: body.slice(0, 4000), numMedia, profileName, at: nowImpl() });
    writeJsonAtomic(D(path.join('last_inbound', from + '.json')), { at: nowImpl() });
    bump('accepted');


    const jobId = 'job-' + sid;
    if (numMedia > 0) {
      // media/audio not implemented: text-only instruction even with a caption; core NOT called
      writeJsonAtomic(jobPathOf(jobId), { id: jobId, kind: 'note', label: 'media-instruction',
        convKey, from, to: from, body: MEDIA_NOTE, status: 'queued', createdAt: nowImpl() });
      bump('media_instruction');
    } else {
      writeJsonAtomic(jobPathOf(jobId), { id: jobId, kind: 'ai',
        convKey, from, to: from, body, profileName, status: 'queued', createdAt: nowImpl() });
    }
    okTwiml(res); // ack fast; AI work runs after
    scheduleSoon();
  }


  // ---- status callback: authenticated, monotonic, never authorizes sending ----
  async function handleStatus(req, res) {
    if (!ready || stopped || stateError) return res.status(503).type('text/plain').send('disabled');
    const p = req.body || {};
    if (!signatureOk(authToken, req.get('X-Twilio-Signature'), publicStatusUrl, p)) return res.status(403).type('text/plain').send('rejected'); // no state write on invalid signature
    if (p.AccountSid !== accountSid) { bump('status_rejected_account'); return res.status(403).type('text/plain').send('rejected'); }
    const psid = String(p.MessageSid || '');
    if (!SID_RE.test(psid)) { bump('status_rejected_sid'); return res.status(400).type('text/plain').send('rejected'); }
    const sFrom = String(p.From || ''), sTo = String(p.To || '');
    const partiesOk = /^whatsapp:/i.test(sFrom) && /^whatsapp:/i.test(sTo) && digitsOnly(sFrom) === sender && digitsOnly(sTo) === owner;
    const sp = D(path.join('msgstatus', psid + '.json'));
    if (!fs.existsSync(sp)) {
      if (!partiesOk) { bump('status_rejected_parties'); return res.status(403).type('text/plain').send('rejected'); }
      // early or uncorrelated callback: persist for operator review, never authorize a send
      writeJsonAtomic(D(path.join('uncorrelated', psid + '.json')),
        { at: nowImpl(), params: { MessageSid: psid, MessageStatus: p.MessageStatus || null, From: p.From || null, To: p.To || null, ErrorCode: p.ErrorCode || null } });
      bump('status_uncorrelated'); return res.status(200).type('text/plain').send('ignored');
    }
    if (!partiesOk) { bump('status_rejected_parties'); return res.status(403).type('text/plain').send('rejected'); }
    const st = readJsonStrict(sp); // throws on corrupt -> fail closed (stateError set)
    const next = String(p.MessageStatus || '').toLowerCase();
    if (SEEN_DELIVERED.has(st.state) && (next === 'failed' || next === 'undelivered')) {
      bump('status_contradiction'); return res.status(200).type('text/plain').send('ignored'); // terminal seen: contradiction ignored
    }
    if ((STATUS_ORDER[next] || 0) > (STATUS_ORDER[st.state] || 0)) { // monotonic only
      st.state = next; st.history.push({ at: nowImpl(), state: next, errorCode: p.ErrorCode || null });
      writeJsonAtomic(sp, st); bump('status_' + next);
    } else bump('status_stale');
    return res.status(200).type('text/plain').send('ok');
  }


  function handleHealth(req, res) {
    let counters = {}; try { counters = JSON.parse(fs.readFileSync(countersPath(), 'utf8')); } catch {}
    let queueDepth = -1;
    try { queueDepth = (ready && !stopped && !stateError) ? queuedJobs().length : 0; } catch { queueDepth = -1; }
    res.json({ enabled: ready && !stopped && !stateError, stopped, healthy: !stateError,
      reason: stateError || (stopped ? 'stopped' : disabledReason),
      counters, queueDepth,
      config: { senderConfigured: !!sender, ownerConfigured: !!owner, dailyCap, maxMessageLength } });
  }


  const router = express.Router();
  const form = express.urlencoded({ extended: false, limit: '64kb' });
  const safe = (fn) => (req, res) => fn(req, res).catch(() => { try { res.status(500).end(); } catch {} });
  router.post('/whatsapp/twilio/inbound', form, safe(handleInbound));
  router.post('/whatsapp/twilio/status', form, safe(handleStatus));
  router.get('/whatsapp/twilio/health', handleHealth);


  async function start() {
    if (stopped) return { started: false, reason: 'stopped' };
    if (!ready) return { started: false, reason: disabledReason };
    // fail closed: any corrupt/unreadable JSON -> unhealthy, do not start, preserve files (no resets)
    const bad = [];
    for (const n of ['counters', 'outbox', 'inbound', 'msgstatus', 'uncorrelated', 'optout', 'holds', 'last_inbound']) {
      let files = [];
      try { files = fs.readdirSync(D(n)); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        try { JSON.parse(fs.readFileSync(D(path.join(n, f)), 'utf8')); }
        catch { bad.push(n + '/' + f); }
      }
    }
    if (bad.length > 0) {
      stateError = 'corrupt-state: ' + bad.join(', ');
      return { started: false, reason: stateError };
    }
    try {
      // mid-flight jobs -> UNKNOWN (never blindly retried)
      for (const f of fs.readdirSync(D('outbox'))) {
        if (!f.endsWith('.json')) continue;
        const jp = D(path.join('outbox', f));
        let j; try { j = JSON.parse(fs.readFileSync(jp, 'utf8')); } catch { continue; }
        if (j.status === 'processing' || j.status === 'pending-send') {
          writeJsonAtomic(jp, { ...j, status: 'unknown', detail: 'restart-during-flight' }); bump('unknown');
        }
      }
      // orphaned receipts (crash between receipt write and job write) -> recreate queued job.
      // stop/start receipts are terminal: nothing to recover, and the kept sentinel dedupes retries.
      for (const f of fs.readdirSync(D('inbound'))) {
        if (!f.endsWith('.json')) continue;
        const sid = f.slice(0, -5);
        if (!SID_RE.test(sid)) continue;
        if (fs.existsSync(jobPathOf('job-' + sid))) continue;
        let ib; try { ib = readJsonStrict(D(path.join('inbound', f))); } catch { continue; } // corrupt caught by validation above
        if (!ib || ib.from !== owner) continue; // owner-only pilot
        const kind = ib.kind || 'message';
        if (kind === 'stop' || kind === 'start') continue; // terminal receipts
        if (kind === 'note') {
          writeJsonAtomic(jobPathOf('job-' + sid), {
            id: 'job-' + sid, kind: 'note', label: ib.label, convKey: convKeyOf(ib.from), from: ib.from, to: ib.from,
            body: ib.body, status: 'queued', createdAt: ib.at || nowImpl(), recovered: true,
          });
          bump('recovered'); continue;
        }
        const isMedia = (ib.numMedia || 0) > 0; // any media -> text-only instruction; core never sees it
        writeJsonAtomic(jobPathOf('job-' + sid), {
          id: 'job-' + sid, kind: isMedia ? 'note' : 'ai', label: isMedia ? 'media-instruction' : undefined,
          convKey: convKeyOf(ib.from), from: ib.from, to: ib.from,
          body: isMedia ? MEDIA_NOTE : ib.body, profileName: ib.profileName || null,
          status: 'queued', createdAt: ib.at || nowImpl(), recovered: true,
        });
        bump('recovered');
      }
      // dedupe sentinel with NO inbound record: crash before the inbound write.
      // The message body is unrecoverable; count it and remove the sentinel so a
      // Twilio retry (same MessageSid) can be accepted. Never silently dropped.
      for (const f of fs.readdirSync(D('sids'))) {
        if (!SID_RE.test(f)) continue;
        if (fs.existsSync(D(path.join('inbound', f + '.json')))) continue;
        try { fs.unlinkSync(D(path.join('sids', f))); } catch {}
        bump('lost_inbound');
      }
    } catch {}
    scheduleSoon();
    return { started: true };
  }


  async function stop() { stopped = true; } // pump loop exits; scheduled pumps no-op; in-flight job finishes


  return {
    router, start, stop,
    isTwilioExternalId: (id) => typeof id === 'string' && id.startsWith(EXTERNAL_ID_PREFIX),
    sendOperatorReply: async (externalId, text) => {
      if (stopped) throw new Error('stopped');
      if (stateError) throw new Error('unhealthy: ' + stateError);
      if (!ready) throw new Error('disabled: ' + disabledReason);
      if (!String(externalId).startsWith(EXTERNAL_ID_PREFIX)) throw new Error('not a twilio external_id');
      const to = String(externalId).slice(EXTERNAL_ID_PREFIX.length);
      const r = await deliverText(convKeyOf(to), to, text, 'operator-reply');
      if (!r.ok) throw new Error('refused: ' + r.outcome);
      return r;
    },
    drain: async () => {
      while (!stopped && !stateError && (pumping || queuedJobs().length)) await new Promise((r) => setTimeout(r, 10));
      if (!stopped && !stateError) await pump();
      while (!stopped && !stateError && pumping) await new Promise((r) => setTimeout(r, 10));
    },
    healthSnapshot: () => ({ enabled: ready && !stopped, stopped, reason: stopped ? 'stopped' : disabledReason }),
    _paths: { stateDir: D('') },
  };
}


module.exports = { createTwilioWhatsAppAdapter, EXTERNAL_ID_PREFIX };
