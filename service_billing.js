'use strict';
// Provider reads and bookkeeping only. No purchase, top-up, subscription or key-write API.
const IDS = ['kimi', 'openai', 'railway', 'supabase', 'vercel', 'resend'];
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const obj = o => o && typeof o === 'object' && !Array.isArray(o);
const number = (n, min = 0) => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 1000000;
const date = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const FIELDS = ['account', 'plan', 'balance', 'spend', 'month', 'invoice', 'due', 'checked', 'reserve'];

function validateRecord(body, now = Date.now()) {
  if (!obj(body) || Object.keys(body).some(k => !['id', 'version', 'data'].includes(k)) || !IDS.includes(body.id) ||
      !Number.isSafeInteger(body.version) || body.version < 0 || !obj(body.data) ||
      Object.keys(body.data).length !== FIELDS.length || FIELDS.some(k => !own(body.data, k))) throw Error('invalid');
  const d = body.data;
  if (typeof d.account !== 'string' || d.account.trim().length < 1 || d.account.length > 120 ||
      typeof d.plan !== 'string' || d.plan.length > 80 ||
      (d.balance !== null && !number(d.balance, -1000000)) ||
      ['spend', 'invoice', 'reserve'].some(k => d[k] !== null && !number(d[k])) ||
      (d.month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(d.month)) ||
      (d.spend !== null && d.month === null) || (d.due !== null && !date(d.due)) ||
      (d.due !== null && d.invoice === null) || !date(d.checked) ||
      Date.parse(d.checked + 'T00:00:00Z') > now) throw Error('invalid');
  return { id: body.id, version: body.version, data: { ...d, account: d.account.trim(), plan: d.plan.trim() } };
}

async function readJson(fetchImpl, url, key, signal) {
  const res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal, redirect: 'error', cache: 'no-store' });
  if (!res.ok || !res.headers.get('content-type')?.includes('application/json') || !res.body) throw Error('provider');
  const reader = res.body.getReader(); let size = 0; const chunks = [];
  try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length;
    if (size > 1024 * 1024) throw Error('size'); chunks.push(r.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createBilling({ supabase, fetchImpl = globalThis.fetch, env = process.env, now = Date.now }) {
  const cache = new Map(), pending = new Map();
  async function cached(id, seconds, task) {
    const hit = cache.get(id); if (hit && now() - hit.time < seconds * 1000) return hit.value;
    if (pending.has(id)) return pending.get(id);
    const work = task().catch(() => ({ status: 'unavailable', checkedAt: null })).then(value => {
      cache.set(id, { time: now(), value }); return value;
    }).finally(() => pending.delete(id));
    pending.set(id, work); return work;
  }
  async function kimi() {
    if (!env.MOONSHOT_API_KEY) return { status: 'not_configured', checkedAt: null };
    // Do not send a live key to a guessed gateway, other region or browser-supplied URL.
    if ((env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/$/, '') !== 'https://api.moonshot.ai/v1')
      return { status: 'unsupported_endpoint', checkedAt: null };
    const r = await readJson(fetchImpl, 'https://api.moonshot.ai/v1/users/me/balance', env.MOONSHOT_API_KEY, AbortSignal.timeout(8000));
    if (r.code !== 0 || r.status !== true || !obj(r.data) || !number(r.data.available_balance, -1000000) ||
        !number(r.data.cash_balance, -1000000) || !number(r.data.voucher_balance)) throw Error('invalid');
    return { status: 'ok', checkedAt: new Date(now()).toISOString(), currency: 'USD', balance: r.data.available_balance,
      cash: r.data.cash_balance, vouchers: r.data.voucher_balance, scope: 'working_key_account' };
  }
  async function openai() {
    const key = env.OPENAI_BILLING_ADMIN_KEY;
    const projects = (env.OPENAI_BILLING_PROJECT_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
    if (!key || !projects.length || projects.length > 10 || projects.some(x => !/^proj_[A-Za-z0-9_-]{1,100}$/.test(x)))
      return { status: 'not_configured', checkedAt: null };
    const current = new Date(now()), start = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1) / 1000;
    const end = Math.floor(now() / 1000), signal = AbortSignal.timeout(10000);
    let total = 0, page = null; const seen = new Set(), buckets = new Set();
    for (let i = 0; i < 10; i++) {
      const url = new URL('https://api.openai.com/v1/organization/costs');
      url.searchParams.set('start_time', String(start)); url.searchParams.set('end_time', String(end));
      url.searchParams.set('limit', '31'); url.searchParams.append('group_by', 'project_id');
      for (const project of projects) url.searchParams.append('project_ids', project);
      if (page) url.searchParams.set('page', page);
      const r = await readJson(fetchImpl, url.toString(), key, signal);
      if (!Array.isArray(r.data) || typeof r.has_more !== 'boolean') throw Error('invalid');
      for (const bucket of r.data) {
        if (!Array.isArray(bucket.results) || !Number.isFinite(bucket.start_time) || !Number.isFinite(bucket.end_time) ||
            bucket.start_time < start || bucket.start_time >= end || bucket.end_time <= bucket.start_time || buckets.has(bucket.start_time)) throw Error('bucket');
        buckets.add(bucket.start_time);
        for (const result of bucket.results) {
          if (!projects.includes(result.project_id) || result.amount?.currency !== 'usd' || !number(result.amount?.value, -1000000)) throw Error('scope');
          total += result.amount.value;
        }
      }
      if (!r.has_more) return { status: 'ok', checkedAt: new Date(now()).toISOString(), currency: 'USD', spend: Math.round(total * 1000000) / 1000000,
        month: current.toISOString().slice(0, 7), scope: 'configured_projects', periodStart: new Date(start * 1000).toISOString(), periodEnd: current.toISOString() };
      if (typeof r.next_page !== 'string' || !r.next_page || r.next_page.length > 1000 || seen.has(r.next_page)) throw Error('pagination');
      seen.add(r.next_page); page = r.next_page;
    }
    throw Error('incomplete');
  }
  async function read() {
    const records = await supabase.from('service_billing').select('id,data,version,updated_at').in('id', IDS);
    if (records.error || !Array.isArray(records.data) || records.data.length !== IDS.length) throw Error('storage');
    const [k, o] = await Promise.all([cached('kimi', 60, kimi), cached('openai', 900, openai)]);
    return { version: 1, generatedAt: new Date(now()).toISOString(), currency: 'USD', records: records.data, live: { kimi: k, openai: o } };
  }
  async function save(body) {
    const v = validateRecord(body, now());
    const { data, error } = await supabase.from('service_billing').update({ data: v.data, version: v.version + 1,
      updated_at: new Date(now()).toISOString() }).eq('id', v.id).eq('version', v.version).select('id,data,version,updated_at');
    if (error) throw Error('storage');
    if (!Array.isArray(data) || data.length !== 1) throw Error('conflict');
    return data[0];
  }
  return { read, save, kimi, openai };
}

function mountBilling(router, requireAdmin, options) {
  const billing = createBilling(options);
  router.get('/billing', requireAdmin, async (req, res) => {
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'invalid' });
    try { res.json(await billing.read()); } catch { res.status(503).json({ error: 'billing_unavailable' }); }
  });
  router.post('/billing', requireAdmin, async (req, res) => {
    if (Object.keys(req.query).length || JSON.stringify(req.body || {}).length > 4096) return res.status(400).json({ error: 'invalid' });
    try { res.json(await billing.save(req.body)); }
    catch (e) { const code = ['invalid', 'conflict'].includes(e.message) ? e.message : 'billing_unavailable';
      res.status(code === 'invalid' ? 400 : code === 'conflict' ? 409 : 503).json({ error: code }); }
  });
}
module.exports = { createBilling, mountBilling, validateRecord, IDS };
