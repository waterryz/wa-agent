// twilio_whatsapp_adapter.test.js
// run: npm install --save-exact express@4.22.2 twilio@6.1.2 && node --test twilio_whatsapp_adapter.test.js
// All identities are synthetic (SM + 32 hex). No network, no live API.
'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { getExpectedTwilioSignature } = require('twilio/lib/webhooks/webhooks');
const { createTwilioWhatsAppAdapter } = require('./twilio_whatsapp_adapter');


const TOKEN = 'test-auth-token', ACCOUNT = 'ACtest123', SENDER = '+15550001111', OWNER = '+15550002222';
const INBOUND_URL = 'https://assistant.example.test/whatsapp/twilio/inbound';
const STATUS_URL = 'https://assistant.example.test/whatsapp/twilio/status';


let dir, server, base, adapter, coreCalls, coreBehavior, postCalls, postBehavior, escalations, sendSeq;


const newSid = () => 'SM' + crypto.randomBytes(16).toString('hex'); // real Twilio SID shape
const sig = (url, params, token = TOKEN) => getExpectedTwilioSignature(token, url, params);
const baseParams = (over = {}) => ({ MessageSid: newSid(),
  AccountSid: ACCOUNT, From: 'whatsapp:' + OWNER, To: 'whatsapp:' + SENDER, Body: 'hello', NumMedia: '0', ...over });


async function postTo(m, route, url, params, token = TOKEN) {
  return fetch(m.base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig(url, params, token) },
    body: new URLSearchParams(params).toString() });
}
const postInbound = (m, p, token, url = INBOUND_URL) => postTo(m, '/whatsapp/twilio/inbound', url, p, token);
const postStatus = (m, p, token) => postTo(m, '/whatsapp/twilio/status', STATUS_URL, p, token);


async function pollUntil(fn, ms, msg) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout: ' + msg);
}


function makeAdapter(extra = {}) {
  coreCalls = []; postCalls = []; escalations = []; sendSeq = 0;
  coreBehavior = extra.coreBehavior || (async () => ({ conversation_id: 'c1', reply: 'ok reply', operator_mode: false, escalate: false }));
  const defaultPost = async () => { sendSeq++; return { status: 201, json: { sid: 'SM' + String(sendSeq).padStart(32, '0') } } }; // deterministic hex32
  postBehavior = extra.postBehavior || defaultPost;
  const core = { processMessage: async (a) => { coreCalls.push(a); return coreBehavior(a); } };
  return createTwilioWhatsAppAdapter({
    enabled: extra.enabled !== undefined ? extra.enabled : true,
    stateDir: dir, accountSid: ACCOUNT, authToken: TOKEN,
    senderNumber: SENDER, ownerNumber: OWNER,
    publicInboundUrl: extra.publicInboundUrl || INBOUND_URL, publicStatusUrl: STATUS_URL,
    core, onEscalation: (e) => escalations.push(e), dailyCap: extra.dailyCap ?? 50,
    httpPost: extra.useDefaultPost ? undefined : (async (r) => { postCalls.push(r); return postBehavior(r); }),
    apiBase: extra.apiBase,
    nowImpl: extra.nowImpl || (() => Date.now()),
  });
}


async function mount(a) {
  const app = express(); app.use(a.router);
  const s = app.listen(0); await new Promise((r) => s.once('listening', r));
  return { server: s, base: 'http://127.0.0.1:' + s.address().port };
}
async function closeMount(m, a) {
  try { if (a) await a.stop(); } catch {}
  await new Promise((r) => m.server.close(r));
}
const countersFile = () => path.join(dir, 'counters', 'counters.json');
const readCounters = () => { try { return JSON.parse(fs.readFileSync(countersFile(), 'utf8')); } catch { return {}; } };
const sendJobs = () => fs.readdirSync(path.join(dir, 'outbox'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'outbox', f), 'utf8')))
  .filter((j) => j.kind === 'send');


beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-wa-'));
  adapter = makeAdapter();
  const m = await mount(adapter);
  server = m.server; base = m.base;
  await adapter.start();
});
afterEach(async () => {
  try { await adapter.stop(); } catch {}
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});
const main = () => ({ base }); // default mounted adapter from beforeEach


test('disabled adapter: 503, zero state (no counters, no files)', async () => {
  const d = makeAdapter({ enabled: false });
  const m = await mount(d);
  try {
    const before = fs.readdirSync(dir).sort();
    const p = baseParams();
    const res = await postInbound(m, p);
    assert.equal(res.status, 503);
    assert.equal(coreCalls.length, 0);
    assert.ok(!fs.existsSync(countersFile()), 'no counters written while disabled');
    assert.deepEqual(fs.readdirSync(dir).sort(), before, 'disabled adapter writes no state at all');
  } finally { await closeMount(m, d); }
});


test('stopped adapter: 503 inbound, operator reply refused', async () => {
  await adapter.stop();
  const p = baseParams();
  assert.equal((await postTo(main(), '/whatsapp/twilio/inbound', INBOUND_URL, p)).status, 503);
  await assert.rejects(adapter.sendOperatorReply('wa-twilio:+15550002222', 'hi'), /stopped/);
  const h = await (await fetch(base + '/whatsapp/twilio/health')).json();
  assert.equal(h.stopped, true);
  assert.equal(h.enabled, false);
});


test('bad signature: 403, zero state (no counters at all)', async () => {
  const p = baseParams();
  assert.equal((await postInbound(main(), p, 'wrong-token')).status, 403);
  assert.ok(!fs.existsSync(countersFile()), 'invalid signature must not populate state');
  assert.equal(fs.readdirSync(path.join(dir, 'sids')).length, 0, 'no dedupe sentinel written');
  assert.equal(fs.readdirSync(path.join(dir, 'outbox')).length, 0, 'no job written');
  assert.equal(coreCalls.length, 0); assert.equal(postCalls.length, 0);
});


test('missing form field breaks signature (ALL fields required)', async () => {
  const p = baseParams(); const full = sig(INBOUND_URL, p);
  const { Body, ...dropped } = p;
  const res = await fetch(base + '/whatsapp/twilio/inbound', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': full },
    body: new URLSearchParams(dropped).toString() });
  assert.equal(res.status, 403);
  assert.equal(coreCalls.length, 0);
});


test('query-string regression: exact configured URL validates, reordered query does not', async () => {
  await adapter.stop();
  const qsUrl = INBOUND_URL + '?src=pilot&v=2';
  const a = makeAdapter({ publicInboundUrl: qsUrl });
  const m = await mount(a); await a.start();
  try {
    const p1 = baseParams({ Body: 'exact query' });
    assert.equal((await postInbound(m, p1, TOKEN, qsUrl)).status, 200);
    const p2 = baseParams({ Body: 'reordered query' });
    assert.equal((await postInbound(m, p2, TOKEN, INBOUND_URL + '?v=2&src=pilot')).status, 403);
    await a.drain();
    assert.equal(coreCalls.length, 1, 'only the exact-URL request reached the core');
  } finally { await closeMount(m, a); }
});


test('malformed MessageSid rejected before path use', async () => {
  const p = baseParams({ MessageSid: '../../etc/passwd' });
  assert.equal((await postInbound(main(), p)).status, 400);
  assert.equal(fs.readdirSync(path.join(dir, 'sids')).length, 0);
  assert.equal(coreCalls.length, 0);
});


test('wrong AccountSid / wrong To / non-owner From rejected before AI', async () => {
  for (const over of [{ AccountSid: 'ACnope' }, { To: 'whatsapp:+19998887777' }, { From: 'whatsapp:+16667778888' }])
    assert.equal((await postInbound(main(), baseParams(over))).status, 403);
  assert.equal(coreCalls.length, 0); assert.equal(postCalls.length, 0);
});


test('valid owner message: TwiML 200, core once, explicit StatusCallback, fixed host', async () => {
  const p = baseParams({ Body: 'schedule question' });
  const res = await postInbound(main(), p);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<Response><\/Response>/);
  await adapter.drain();
  assert.equal(coreCalls.length, 1);
  assert.equal(coreCalls[0].channel, 'whatsapp');
  assert.ok(coreCalls[0].external_id.startsWith('wa-twilio:+15550002222'));
  assert.equal(coreCalls[0].contact.phone, '+15550002222'); // no identity inference
  assert.equal(postCalls.length, 1);
  assert.ok(postCalls[0].urlPath.startsWith('/2010-04-01/Accounts/' + ACCOUNT + '/Messages.json'));
  const form = new URLSearchParams(postCalls[0].form);
  assert.equal(form.get('To'), 'whatsapp:' + OWNER);
  assert.equal(form.get('From'), 'whatsapp:' + SENDER);
  assert.equal(form.get('Body'), 'ok reply');
  assert.equal(form.get('StatusCallback'), STATUS_URL, 'explicit per-message status callback');
});


test('duplicate MessageSid (concurrent) processed once', async () => {
  const p = baseParams();
  const m = main();
  const [r1, r2] = await Promise.all([postInbound(m, p), postInbound(m, p)]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  await adapter.drain();
  assert.equal(coreCalls.length, 1); assert.equal(postCalls.length, 1);
});


test('two distinct sids both accepted (no false dedup)', async () => {
  const m = main();
  await postInbound(m, baseParams({ Body: 'one' }));
  await postInbound(m, baseParams({ Body: 'two' }));
  await adapter.drain();
  assert.equal(coreCalls.length, 2); assert.equal(postCalls.length, 2);
});


test('slow core: message arriving during AI work is not stranded', async () => {
  await adapter.stop();
  let release; const gate = new Promise((r) => { release = r; });
  const a = makeAdapter({ coreBehavior: async (arg) => { await gate; return { conversation_id: 'c1', reply: 'r:' + arg.message, operator_mode: false, escalate: false }; } });
  const m = await mount(a); await a.start();
  try {
    assert.equal((await postInbound(m, baseParams({ Body: 'first' }))).status, 200);
    await pollUntil(() => coreCalls.length >= 1, 3000, 'core did not start on first message');
    assert.equal((await postInbound(m, baseParams({ Body: 'second' }))).status, 200);
    release();
    await pollUntil(() => coreCalls.length >= 2, 5000, 'second message stranded (pump did not re-scan)');
    await a.drain();
    assert.equal(postCalls.length, 2);
  } finally { await closeMount(m, a); }
});


test('restart recovers queued job exactly once', async () => {
  await adapter.stop();
  // deterministic crash state, no HTTP race: inbound accepted + job queued, worker never ran
  const sid = newSid();
  fs.writeFileSync(path.join(dir, 'sids', sid), '');
  fs.writeFileSync(path.join(dir, 'inbound', sid + '.json'),
    JSON.stringify({ sid, from: OWNER, body: 'queued msg', numMedia: 0, profileName: null, at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'last_inbound', OWNER + '.json'), JSON.stringify({ at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'outbox', 'job-' + sid + '.json'), JSON.stringify({
    id: 'job-' + sid, kind: 'ai', convKey: 'wa-twilio:' + OWNER, from: OWNER, to: OWNER,
    body: 'queued msg', profileName: null, status: 'queued', createdAt: Date.now(),
  }));
  const a2 = makeAdapter();
  const m2 = await mount(a2);
  try {
    await a2.start(); await a2.drain();
    assert.equal(coreCalls.length, 1, 'exactly one core run');
    assert.equal(postCalls.length, 1, 'exactly one send');
    assert.equal(coreCalls[0].message, 'queued msg');
  } finally { await closeMount(m2, a2); }
});


test('orphaned inbound record (crash before job write) is recovered', async () => {
  await adapter.stop();
  const sid = newSid();
  for (const n of ['sids', 'inbound']) fs.mkdirSync(path.join(dir, n), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sids', sid), '');
  fs.writeFileSync(path.join(dir, 'inbound', sid + '.json'),
    JSON.stringify({ sid, from: '+15550002222', body: 'orphan msg', numMedia: 0, profileName: null, at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'last_inbound', '+15550002222.json'), JSON.stringify({ at: Date.now() }));
  const a2 = makeAdapter();
  const m2 = await mount(a2);
  try {
    await a2.start(); await a2.drain();
    assert.equal(coreCalls.length, 1); assert.equal(postCalls.length, 1);
    assert.equal(coreCalls[0].message, 'orphan msg');
    assert.equal(readCounters().recovered, 1);
  } finally { await closeMount(m2, a2); }
});


test('crash between dedupe sentinel and queue write: counted lost, retry accepted', async () => {
  await adapter.stop();
  const sid = newSid();
  fs.mkdirSync(path.join(dir, 'sids'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sids', sid), ''); // sentinel only: no inbound record
  const a2 = makeAdapter();
  const m2 = await mount(a2);
  try {
    await a2.start();
    assert.equal(readCounters().lost_inbound, 1);
    assert.ok(!fs.existsSync(path.join(dir, 'sids', sid)), 'sentinel removed so a retry can be accepted');
    const p = baseParams({ MessageSid: sid, Body: 'retry after crash' });
    assert.equal((await postInbound(m2, p)).status, 200);
    await a2.drain();
    assert.equal(coreCalls.length, 1); assert.equal(postCalls.length, 1);
  } finally { await closeMount(m2, a2); }
});


test('crash mid-send becomes unknown, never retried', async () => {
  await adapter.stop();
  let calls = 0;
  const a = makeAdapter({ postBehavior: async () => { calls++; const e = new Error('boom'); e.name = 'AbortError'; throw e; } });
  const m = await mount(a); await a.start();
  try {
    const p = baseParams();
    assert.equal((await postInbound(m, p)).status, 200);
    await a.drain();
    assert.equal(calls, 1);
    assert.equal(sendJobs()[0].status, 'unknown');
    await a.stop();
    const a3 = makeAdapter();
    const m3 = await mount(a3);
    try {
      await a3.start(); await a3.drain();
      assert.equal(calls, 1, 'no blind retry of unknown send outcome');
    } finally { await closeMount(m3, a3); }
  } finally { await closeMount(m, a); }
});


test('HTTP 400 terminal failure; 429/500/malformed-201 are unknown, never retried', async () => {
  await adapter.stop();
  const mounts = [];
  const run = async (postBehavior) => {
    const a = makeAdapter({ postBehavior });
    const m = await mount(a); mounts.push([m, a]); await a.start();
    const beforeIds = new Set(sendJobs().map((j) => j.id));
    assert.equal((await postInbound(m, baseParams({ Body: 'x' }))).status, 200);
    await a.drain();
    const fresh = sendJobs().filter((j) => !beforeIds.has(j.id) && j.label === 'ai-reply');
    assert.equal(fresh.length, 1, 'exactly one new send job per run');
    return fresh[0];
  };
  try {
    const j400 = await run(async () => ({ status: 400, json: { code: 21211, message: 'Invalid To' } }));
    assert.equal(j400.status, 'failed');
    assert.match(j400.detail, /21211/);
    const j429 = await run(async () => ({ status: 429, json: { code: 20429, message: 'Rate limited' } }));
    assert.equal(j429.status, 'unknown', '429 is uncertain: check console before any manual retry');
    const j500 = await run(async () => ({ status: 500, json: null }));
    assert.equal(j500.status, 'unknown');
    const jBad201 = await run(async () => ({ status: 201, json: {} }));
    assert.equal(jBad201.status, 'unknown', 'malformed 201 (no sid) is uncertain, not failed');
    // restart must not retry terminal OR unknown sends
    const again = makeAdapter(); const m4 = await mount(again); mounts.push([m4, again]);
    await again.start(); await again.drain();
    const sends = sendJobs().filter((j) => j.label === 'ai-reply');
    assert.equal(sends.length, 4);
    assert.deepEqual(sends.map((j) => j.status).sort(), ['failed', 'unknown', 'unknown', 'unknown']);
  } finally {
    for (const [m, a] of mounts) await closeMount(m, a);
  }
});


test('fetch does not follow redirects (no credential leak on redirect)', async () => {
  await adapter.stop();
  const hits = [];
  const s2 = http.createServer((rq, rs) => { hits.push(rq.url); rs.end('x'); });
  await new Promise((r) => s2.listen(0, r));
  const s1 = http.createServer((rq, rs) => { rs.writeHead(302, { Location: 'http://127.0.0.1:' + s2.address().port + '/collect' }); rs.end(); });
  await new Promise((r) => s1.listen(0, r));
  const a = makeAdapter({ useDefaultPost: true, apiBase: 'http://127.0.0.1:' + s1.address().port });
  const m = await mount(a); await a.start();
  try {
    assert.equal((await postInbound(m, baseParams({ Body: 'x' }))).status, 200);
    await a.drain();
    assert.equal(hits.length, 0, 'redirect target never hit: Authorization not leaked');
    assert.equal(sendJobs()[0].status, 'unknown');
  } finally {
    await closeMount(m, a);
    await new Promise((r) => s1.close(r));
    await new Promise((r) => s2.close(r));
  }
});


test('expired 24h window blocks operator reply, provider untouched', async () => {
  fs.writeFileSync(path.join(dir, 'last_inbound', '+15550002222.json'),
    JSON.stringify({ at: Date.now() - 25 * 60 * 60 * 1000 }));
  await assert.rejects(adapter.sendOperatorReply('wa-twilio:+15550002222', 'hi'), /window-expired/);
  assert.equal(postCalls.length, 0);
});


test('operator_mode from core: nothing sent, hold recorded', async () => {
  await adapter.stop();
  const a = makeAdapter({ coreBehavior: async () => ({ conversation_id: 'c1', reply: null, operator_mode: true, escalate: false }) });
  const m = await mount(a); await a.start();
  try {
    const p = baseParams();
    assert.equal((await postInbound(m, p)).status, 200);
    await a.drain();
    assert.equal(postCalls.length, 0, 'operator took over: no reply sent');
    assert.equal(fs.readdirSync(path.join(dir, 'holds')).length, 1);
  } finally { await closeMount(m, a); }
});


test('status callback: monotonic, read->failed contradiction ignored, forged rejected', async () => {
  const m = main();
  await postInbound(m, baseParams()); await adapter.drain();
  const outSid = 'SM' + '1'.padStart(32, '0');
  const st = (s) => ({ MessageSid: outSid, MessageStatus: s, AccountSid: ACCOUNT, From: 'whatsapp:' + SENDER, To: 'whatsapp:' + OWNER });
  assert.equal((await postStatus(m, st('delivered'))).status, 200);
  assert.equal((await postStatus(m, st('read'))).status, 200);
  assert.equal((await postStatus(m, st('sent'))).status, 200); // stale regression ignored
  let snap = JSON.parse(fs.readFileSync(path.join(dir, 'msgstatus', outSid + '.json'), 'utf8'));
  assert.equal(snap.state, 'read');
  assert.equal((await postStatus(m, st('failed'))).status, 200); // contradiction ignored
  snap = JSON.parse(fs.readFileSync(path.join(dir, 'msgstatus', outSid + '.json'), 'utf8'));
  assert.equal(snap.state, 'read', 'delivered/read never regresses to failed');
  assert.equal(readCounters().status_contradiction, 1);
  assert.equal((await postStatus(m, st('delivered'), 'wrong-token')).status, 403);
  snap = JSON.parse(fs.readFileSync(path.join(dir, 'msgstatus', outSid + '.json'), 'utf8'));
  assert.equal(snap.state, 'read', 'forged callback changed nothing');
  const unknown = { MessageSid: newSid(), MessageStatus: 'delivered', AccountSid: ACCOUNT, From: 'whatsapp:' + SENDER, To: 'whatsapp:' + OWNER };
  assert.equal((await postStatus(m, unknown)).status, 200);
  assert.ok(fs.existsSync(path.join(dir, 'uncorrelated', unknown.MessageSid + '.json')), 'early/unknown callback persisted for review');
});


test('media without text: instruction reply, core not called', async () => {
  const m = main();
  const p = baseParams({ Body: '', NumMedia: '1', MediaUrl0: 'https://x.example/m.jpg', MediaContentType0: 'image/jpeg' });
  assert.equal((await postInbound(m, p)).status, 200);
  await adapter.drain();
  assert.equal(coreCalls.length, 0, 'no model work for unsupported media');
  assert.equal(postCalls.length, 1);
  assert.match(new URLSearchParams(postCalls[0].form).get('Body'), /as text/);
});


test('daily cap: cap gate before core; total sends <= cap; refusal has no bypass', async () => {
  await adapter.stop();
  const a = makeAdapter({ dailyCap: 1 });
  const m = await mount(a); await a.start();
  try {
    const send = (body) => postInbound(m, baseParams({ Body: body }));
    assert.equal((await send('first')).status, 200); await a.drain();   // sent, count=1
    assert.equal((await send('second')).status, 200); await a.drain();  // refusal queued, dropped by cap gate
    assert.equal((await send('third')).status, 200); await a.drain();   // silent
    assert.equal((await send('fourth')).status, 200); await a.drain();  // silent
    assert.equal(coreCalls.length, 1, 'only the first message reached the core');
    assert.equal(postCalls.length, 1, 'total sends stay <= cap; cap-refusal has no bypass');
    const jobs = fs.readdirSync(path.join(dir, 'outbox')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'outbox', f), 'utf8')));
    const refusal = jobs.find((j) => j.label === 'cap-refusal');
    assert.ok(refusal && refusal.status === 'done' && refusal.detail === 'cap-exceeded', 'refusal dropped cleanly at the cap gate');
    assert.equal(readCounters().rejected_cap_silent, 2);
    assert.equal(readCounters().cap_exceeded_skip, 1);
  } finally { await closeMount(m, a); }
});

test('cap checked before core: backlog during slow core does not burn model calls', async () => {
  await adapter.stop();
  let release; const gate = new Promise((r) => { release = r; });
  const a = makeAdapter({ dailyCap: 2, coreBehavior: async () => { await gate; return { conversation_id: 'c1', reply: 'ok', operator_mode: false, escalate: false }; } });
  const m = await mount(a); await a.start();
  try {
    for (const b of ['m1', 'm2', 'm3', 'm4', 'm5']) assert.equal((await postInbound(m, baseParams({ Body: b }))).status, 200);
    await pollUntil(() => coreCalls.length >= 1, 3000, 'core did not start');
    release();
    await pollUntil(() => coreCalls.length >= 2, 5000, 'second core call missing');
    await a.drain();
    await new Promise((r) => setTimeout(r, 200)); // any stray work would appear here
    assert.equal(coreCalls.length, 2, 'no unbounded model calls after cap');
    assert.ok(postCalls.length <= 2, 'total sends stay <= cap');
  } finally { await closeMount(m, a); }
});


test('operator replies respect the daily cap (no bypass)', async () => {
  await adapter.stop();
  const a = makeAdapter({ dailyCap: 1 });
  const m = await mount(a); await a.start();
  try {
    assert.equal((await postInbound(m, baseParams({ Body: 'one' }))).status, 200);
    await a.drain(); // count=1, cap exhausted
    await assert.rejects(a.sendOperatorReply('wa-twilio:+15550002222', 'op'), /cap-exceeded/);
    assert.equal(postCalls.length, 1, 'operator send refused, provider untouched');
  } finally { await closeMount(m, a); }
});


test('STOP while jobs queued: queued AI cancelled, in-flight send refused', async () => {
  await adapter.stop();
  let release; const gate = new Promise((r) => { release = r; });
  const a = makeAdapter({ coreBehavior: async () => { await gate; return { conversation_id: 'c1', reply: 'should-not-send', operator_mode: false, escalate: false }; } });
  const m = await mount(a); await a.start();
  try {
    assert.equal((await postInbound(m, baseParams({ Body: 'msg1' }))).status, 200);
    await pollUntil(() => coreCalls.length >= 1, 3000, 'core did not start on msg1');
    assert.equal((await postInbound(m, baseParams({ Body: 'msg2' }))).status, 200); // queued behind slow core
    assert.equal((await postInbound(m, baseParams({ Body: 'STOP' }))).status, 200);
    release();
    await a.drain();
    assert.equal(postCalls.length, 0, 'nothing sent after STOP');
    assert.equal(coreCalls.length, 1, 'queued msg2 never reached the core');
    assert.equal((await postInbound(m, baseParams({ Body: 'later' }))).status, 200);
    await a.drain();
    assert.equal(coreCalls.length, 1, 'opted-out sender gets no AI work');
  } finally { await closeMount(m, a); }
});


test('STOP opts out; only START re-enables (unrelated messages do not)', async () => {
  const m = main();
  assert.equal((await postInbound(m, baseParams({ Body: 'STOP' }))).status, 200);
  await adapter.drain();
  assert.equal(postCalls.length, 0, 'no reply to STOP itself');
  assert.equal((await postInbound(m, baseParams({ Body: 'are you there' }))).status, 200);
  await adapter.drain();
  assert.equal(coreCalls.length, 0, 'opted-out sender gets no AI work');
  assert.equal(postCalls.length, 0, 'opted-out sender gets no reply either');
  await assert.rejects(adapter.sendOperatorReply('wa-twilio:+15550002222', 'hi'), /opted-out/);
  assert.equal((await postInbound(m, baseParams({ Body: 'hello again' }))).status, 200); // unrelated: no re-enable
  await adapter.drain();
  assert.equal(coreCalls.length, 0);
  assert.equal((await postInbound(m, baseParams({ Body: 'START' }))).status, 200);
  const ok = await adapter.sendOperatorReply('wa-twilio:+15550002222', 'back');
  assert.equal(ok.outcome, 'sent', 'START re-enables and the 24h window is open');
});


test('escalation goes through injected handler with namespaced external_id', async () => {
  await adapter.stop();
  const a = makeAdapter({ coreBehavior: async () => ({ conversation_id: 'db-uuid-999', reply: 'escalated', operator_mode: false, escalate: true, reason: 'billing', user_text: 'charge?', contact_name: 'Owner' }) });
  const m = await mount(a); await a.start();
  try {
    const p = baseParams();
    assert.equal((await postInbound(m, p)).status, 200);
    await a.drain();
    assert.equal(escalations.length, 1);
    assert.equal(escalations[0].reason, 'billing');
    assert.equal(escalations[0].external_id, 'wa-twilio:' + OWNER, 'operator routing key stays namespaced, not the core internal id');
  } finally { await closeMount(m, a); }
});


test('health exposes counters only, no PII', async () => {
  const h = await (await fetch(base + '/whatsapp/twilio/health')).json();
  assert.equal(h.enabled, true);
  assert.ok(!JSON.stringify(h).includes(OWNER));
  assert.ok(!JSON.stringify(h).includes(TOKEN));
  assert.ok(typeof h.counters === 'object');
});

test('restart does not repeat acknowledged STOP/START (typed receipts, no duplicates)', async () => {
  const m = main();
  const stopP = baseParams({ Body: 'STOP' });
  assert.equal((await postInbound(m, stopP)).status, 200);
  await adapter.drain();
  await adapter.stop();
  const a2 = makeAdapter(); const m2 = await mount(a2);
  try {
    await a2.start();
    assert.equal((await postInbound(m2, stopP)).status, 200); // retry after restart
    await a2.drain();
    assert.equal(readCounters().opted_out, 1, 'STOP processed exactly once despite retry after restart');
    assert.equal(postCalls.length, 0);
    const startP = baseParams({ Body: 'START' });
    assert.equal((await postInbound(m2, startP)).status, 200);
    await a2.drain();
    await a2.stop();
    const a3 = makeAdapter(); const m3 = await mount(a3);
    try {
      await a3.start();
      assert.equal((await postInbound(m3, startP)).status, 200); // retry after restart
      await a3.drain();
      assert.equal(readCounters().opted_in, 1, 'START processed exactly once despite retry after restart');
      const ok = await a3.sendOperatorReply('wa-twilio:+15550002222', 'back');
      assert.equal(ok.outcome, 'sent');
    } finally { await closeMount(m3, a3); }
  } finally { await closeMount(m2, a2); }
});

test('corrupt counters fail closed: unhealthy, 503, files preserved', async () => {
  await adapter.stop();
  const dp = path.join(dir, 'counters', 'daily-' + new Date().toISOString().slice(0, 10) + '.json');
  fs.writeFileSync(dp, '{corrupt');
  const a2 = makeAdapter(); const m2 = await mount(a2);
  try {
    const r = await a2.start();
    assert.equal(r.started, false);
    assert.match(r.reason, /corrupt/);
    assert.equal((await postInbound(m2, baseParams())).status, 503);
    await assert.rejects(a2.sendOperatorReply('wa-twilio:+15550002222', 'x'), /unhealthy|corrupt/);
    const h = await (await fetch(m2.base + '/whatsapp/twilio/health')).json();
    assert.equal(h.healthy, false);
    assert.equal(h.enabled, false);
    assert.ok(fs.readFileSync(dp, 'utf8') === '{corrupt', 'corrupt file preserved, limits not reset');
  } finally { await closeMount(m2, a2); }
});

test('corrupt outbox job fails closed without touching other state', async () => {
  await adapter.stop();
  fs.writeFileSync(path.join(dir, 'outbox', 'job-bad.json'), '{nope');
  const a2 = makeAdapter(); const m2 = await mount(a2);
  try {
    const r = await a2.start();
    assert.equal(r.started, false);
    assert.match(r.reason, /corrupt/);
    assert.ok(fs.readFileSync(path.join(dir, 'outbox', 'job-bad.json'), 'utf8') === '{nope', 'corrupt file preserved');
  } finally { await closeMount(m2, a2); }
});

test('media with caption: text-only instruction, core not called', async () => {
  const m = main();
  const p = baseParams({ Body: 'look at this photo', NumMedia: '1', MediaUrl0: 'https://x.example/m.jpg', MediaContentType0: 'image/jpeg' });
  assert.equal((await postInbound(m, p)).status, 200);
  await adapter.drain();
  assert.equal(coreCalls.length, 0, 'core never sees the image, even with a caption');
  assert.equal(postCalls.length, 1);
  assert.match(new URLSearchParams(postCalls[0].form).get('Body'), /as text/);
});

test('restart recovery treats any NumMedia>0 as text-only (no core)', async () => {
  await adapter.stop();
  const sid = newSid();
  for (const n of ['sids', 'inbound']) fs.mkdirSync(path.join(dir, n), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sids', sid), '');
  fs.writeFileSync(path.join(dir, 'inbound', sid + '.json'),
    JSON.stringify({ kind: 'message', sid, from: OWNER, body: 'caption here', numMedia: 2, profileName: null, at: Date.now() }));
  fs.writeFileSync(path.join(dir, 'last_inbound', OWNER + '.json'), JSON.stringify({ at: Date.now() }));
  const a2 = makeAdapter(); const m2 = await mount(a2);
  try {
    await a2.start(); await a2.drain();
    assert.equal(coreCalls.length, 0, 'recovered media never reaches the core');
    assert.equal(postCalls.length, 1);
  } finally { await closeMount(m2, a2); }
});

test('From/To must carry whatsapp: channel strings', async () => {
  const m = main();
  const p1 = baseParams({ To: '+15550001111' }); // valid signature, but not a whatsapp: URI
  assert.equal((await postInbound(m, p1)).status, 403);
  const p2 = baseParams({ From: '+15550002222' });
  assert.equal((await postInbound(m, p2)).status, 403);
  assert.equal(coreCalls.length, 0);
  assert.equal(readCounters().rejected_channel, 2);
});

test('invalid status signature: 403 with no persistent counter write', async () => {
  const m = main();
  const before = readCounters();
  const p = { MessageSid: newSid(), MessageStatus: 'delivered', AccountSid: ACCOUNT, From: 'whatsapp:' + SENDER, To: 'whatsapp:' + OWNER };
  assert.equal((await postStatus(m, p, 'wrong-token')).status, 403);
  assert.deepEqual(readCounters(), before, 'no state written for invalid status signature');
});

test('early status callback is validated, persisted, and reconciled on send', async () => {
  await adapter.stop();
  const earlySid = newSid();
  const a = makeAdapter({ postBehavior: async () => ({ status: 201, json: { sid: earlySid } }) });
  const m = await mount(a); await a.start();
  try {
    const cb = { MessageSid: earlySid, MessageStatus: 'delivered', AccountSid: ACCOUNT, From: 'whatsapp:' + SENDER, To: 'whatsapp:' + OWNER };
    assert.equal((await postStatus(m, cb)).status, 200);
    assert.ok(fs.existsSync(path.join(dir, 'uncorrelated', earlySid + '.json')), 'early callback persisted');
    const badSid = newSid();
    const bad = { MessageSid: badSid, MessageStatus: 'delivered', AccountSid: ACCOUNT, From: 'whatsapp:+19990001111', To: 'whatsapp:' + OWNER };
    assert.equal((await postStatus(m, bad)).status, 403, 'unknown SID still requires valid parties');
    assert.ok(!fs.existsSync(path.join(dir, 'uncorrelated', badSid + '.json')), 'forged callback not persisted');
    assert.equal((await postInbound(m, baseParams({ Body: 'x' }))).status, 200);
    await a.drain();
    const snap = JSON.parse(fs.readFileSync(path.join(dir, 'msgstatus', earlySid + '.json'), 'utf8'));
    assert.equal(snap.state, 'delivered', 'early delivered not reset to sent');
    assert.ok(snap.history.some((h) => h.reconciled), 'reconciliation recorded in history');
    assert.ok(!fs.existsSync(path.join(dir, 'uncorrelated', earlySid + '.json')), 'early record consumed');
    assert.equal(readCounters().status_reconciled, 1);
  } finally { await closeMount(m, a); }
});
