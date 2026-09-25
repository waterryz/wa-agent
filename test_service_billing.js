'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), express = require('express');
const { createBilling, mountBilling, validateRecord, IDS } = require('./service_billing');
const { createHttpAuth } = require('./http_auth');
const NOW = Date.parse('2026-09-25T16:00:00Z');
const form = () => ({ id: 'kimi', version: 0, data: { account: 'Test account', plan: '', balance: 0, spend: null, month: null, invoice: null, due: null, checked: '2026-09-25', reserve: 10 } });
function database() {
  const rows = IDS.map(id => ({ id, data: {}, version: 0, updated_at: new Date(NOW).toISOString() })); let updates = 0, reads = 0;
  return { rows, get updates() { return updates; }, get reads() { return reads; }, from(table) {
    assert.equal(table, 'service_billing');
    return { select: () => ({ in: async () => { reads++; return { data: structuredClone(rows), error: null }; } }),
      update: payload => { const match = {}; return { eq(k, v) { match[k] = v; return this; }, async select() {
        const row = rows.find(x => x.id === match.id && x.version === match.version);
        if (!row) return { data: [], error: null }; Object.assign(row, payload); updates++; return { data: [structuredClone(row)], error: null };
      } }; } };
  } };
}
test('manual records preserve unknown vs zero and reject invalid dates, amounts, secrets and IDs', () => {
  assert.equal(validateRecord(form(), NOW).data.balance, 0);
  for (const change of [x => x.data.balance = NaN, x => x.data.invoice = -1, x => x.data.checked = '2026-02-30', x => x.data.checked = '2026-99-99',
    x => x.data.checked = '2026-09-26', x => x.data.spend = 3, x => x.data.due = '2026-09-26', x => x.data.key = 'secret', x => x.id = '__proto__', x => x.version = -1]) {
    const f = form(); change(f); assert.throws(() => validateRecord(f, NOW), /invalid/);
  }
});
test('working Kimi key fetches USD balances only from fixed provider; no model calls or redirects', async () => {
  const calls = [], api = createBilling({ now: () => NOW, env: { MOONSHOT_API_KEY: 'test-kimi' }, fetchImpl: async (...args) => {
    calls.push(args); return Response.json({ code: 0, status: true, data: { available_balance: 2.5, cash_balance: -1, voucher_balance: 2.5 } }); } });
  const b = await api.kimi(); assert.equal(b.balance, 2.5); assert.equal(b.cash, -1); assert.equal(b.currency, 'USD');
  assert.equal(calls[0][0], 'https://api.moonshot.ai/v1/users/me/balance'); assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[0][1].headers.Authorization, 'Bearer test-kimi'); assert.ok(!JSON.stringify(b).includes('test-kimi'));
});
test('unconfigured and other-region Kimi do not transmit key', async () => {
  let called = 0;
  for (const env of [{}, { MOONSHOT_API_KEY: 'secret', KIMI_BASE_URL: 'https://outside.example/v1' }]) {
    const api = createBilling({ env, fetchImpl: async () => { called++; } }); assert.notEqual((await api.kimi()).status, 'ok');
  } assert.equal(called, 0);
});
test('provider failures are unavailable, never zero, and successful snapshots are cached', async () => {
  const db = database(); let calls = 0;
  const api = createBilling({ supabase: db, now: () => NOW, env: { MOONSHOT_API_KEY: 'test' }, fetchImpl: async () => { calls++; throw Error('secret'); } });
  const r = await api.read(); assert.equal(r.live.kimi.status, 'unavailable'); assert.equal(r.live.kimi.balance, undefined); assert.ok(!JSON.stringify(r).includes('secret'));
  await api.read(); assert.equal(calls, 1);
});
function costs(project, amount, more = false, cursor = null) {
  return { data: [{ start_time: Date.parse('2026-09-24T00:00:00Z') / 1000, end_time: Date.parse('2026-09-25T00:00:00Z') / 1000,
    results: [{ project_id: project, amount: { currency: 'usd', value: amount } }] }], has_more: more, next_page: cursor };
}
const oaEnv = { OPENAI_BILLING_ADMIN_KEY: 'test-admin', OPENAI_BILLING_PROJECT_IDS: 'proj_prime' };
test('OpenAI costs require a scoped project list and use read-only admin API, not working model key', async () => {
  let calls = [];
  const fetchImpl = async (...a) => { calls.push(a); return Response.json(costs('proj_prime', .2)); };
  const noScope = createBilling({ now: () => NOW, env: { OPENAI_API_KEY: 'ordinary', OPENAI_BILLING_ADMIN_KEY: 'admin' }, fetchImpl });
  assert.equal((await noScope.openai()).status, 'not_configured'); assert.equal(calls.length, 0);
  const r = await createBilling({ now: () => NOW, env: oaEnv, fetchImpl }).openai();
  assert.equal(r.spend, .2); assert.equal(r.balance, undefined); assert.equal(r.month, '2026-09');
  const u = new URL(calls[0][0]); assert.equal(u.origin, 'https://api.openai.com'); assert.deepEqual(u.searchParams.getAll('project_ids'), ['proj_prime']);
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-admin');
});
test('OpenAI refuses other projects, currencies, malformed values and incomplete/repeating pagination', async () => {
  for (const payload of [costs('proj_other', 1), { ...costs('proj_prime', 1), has_more: 'false' }, costs('proj_prime', '1'), costs('proj_prime', .1, true, 'again')]) {
    const api = createBilling({ now: () => NOW, env: oaEnv, fetchImpl: async () => Response.json(payload) }); await assert.rejects(api.openai());
  }
  let page = 0;
  const api = createBilling({ now: () => NOW, env: oaEnv, fetchImpl: async () => {
    const p = costs('proj_prime', .2, page++ === 0, 'next'); if (page === 2) { p.data[0].start_time -= 86400; p.data[0].end_time -= 86400; } return Response.json(p);
  } }); assert.equal((await api.openai()).spend, .4);
});
test('compare-and-set prevents a stale editor from overwriting account balances', async () => {
  const db = database(), api = createBilling({ supabase: db, env: {}, now: () => NOW });
  assert.equal((await api.save(form())).version, 1); await assert.rejects(api.save(form()), /conflict/); assert.equal(db.updates, 1);
});
test('missing, failed or incomplete ledger preserves live balance with explicit unavailable storage and no writable records', async () => {
  const good = database();
  for (const result of [{ data: [], error: null }, { data: good.rows, error: { message: 'secret-database-error' } },
    { data: [...good.rows.slice(1), good.rows[1]], error: null }, null]) {
    const api = createBilling({ env: { MOONSHOT_API_KEY: 'synthetic-key' }, now: () => NOW,
      fetchImpl: async () => Response.json({ code: 0, status: true, data: { available_balance: 3, cash_balance: 3, voucher_balance: 0 } }),
      supabase: { from: () => ({ select: () => ({ in: async () => { if (!result) throw Error('secret-network-error'); return result; } }) }) } });
    const snapshot = await api.read();
    assert.deepEqual(snapshot.manual, { status: 'unavailable', writable: false });
    assert.deepEqual(snapshot.records, []); assert.equal(snapshot.live.kimi.balance, 3);
    assert.equal(snapshot.live.openai.status, 'not_configured'); assert.ok(!JSON.stringify(snapshot).includes('secret-'));
  }
});

test('preview billing with an available ledger is still read-only', async () => {
  const db = database(), api = createBilling({ supabase: db, env: {}, readOnly: true });
  assert.deepEqual((await api.read()).manual, { status: 'available', writable: false });
  await assert.rejects(api.save(form()), /read_only/); assert.equal(db.updates, 0);
});
test('HTTP billing rejects non-admins, URL keys and payment operations; authenticated save persists only metadata', async () => {
  const app = express(), db = database(); app.use(express.json());
  const router = express.Router(); mountBilling(router, createHttpAuth('test-only-secret').requireAdmin, { supabase: db, env: {}, now: () => NOW }); app.use(router);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    assert.equal((await fetch(base + '/billing')).status, 401);
    assert.equal((await fetch(base + '/billing?key=test-only-secret')).status, 401);
    assert.equal((await fetch(base + '/billing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form()) })).status, 401);
    assert.equal(db.updates, 0); assert.equal(db.reads, 0);
    const headers = { 'x-admin-key': 'test-only-secret', 'content-type': 'application/json' };
    assert.equal((await fetch(base + '/billing', { headers })).status, 200);
    assert.equal((await fetch(base + '/billing', { method: 'POST', headers, body: JSON.stringify(form()) })).status, 200);
    assert.equal((await fetch(base + '/billing', { method: 'POST', headers, body: JSON.stringify(form()) })).status, 409);
    assert.equal((await fetch(base + '/billing', { method: 'POST', headers, body: JSON.stringify({ action: 'pay', amount: 10 }) })).status, 400);
    assert.equal((await fetch(base + '/billing/pay', { method: 'POST', headers })).status, 404);
  } finally { await new Promise(r => server.close(r)); }
});
