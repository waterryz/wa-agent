'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const express = require('express');
const { createWebDigestSource, period } = require('./web_digest');

const start = '2026-09-23T13:00:00Z', end = '2026-09-24T13:00:00Z';
const now = () => Date.parse('2026-09-25T15:00:00Z');
const row = (id, role, at = '2026-09-23T15:00:00.000Z', channel = 'web', conversation = 10) => ({
  id, conversation_id: conversation, role, content: `${role}-${id}`, created_at: at,
  meta: { raw_secret: 'must-not-export', escalate: false },
  assistant_conversations: { id: conversation, channel, contact_name: 'Synthetic client' },
});

function database(rows, fail = false) {
  const reads = [];
  return { reads, from(table) {
    const filters = [], orders = [];
    const request = { table, filters, orders, limit: Infinity }; reads.push(request);
    const value = (row, path) => path.split('.').reduce((out, key) => out?.[key], row);
    const q = {
      select(fields) { request.fields = fields; return q; },
      eq(field, wanted) { filters.push({op:'eq',field,wanted}); return q; },
      in(field, wanted) { filters.push({op:'in',field,wanted}); return q; },
      gt(field, wanted) { filters.push({op:'gt',field,wanted}); return q; },
      gte(field, wanted) { filters.push({op:'gte',field,wanted}); return q; },
      lt(field, wanted) { filters.push({op:'lt',field,wanted}); return q; },
      lte(field, wanted) { filters.push({op:'lte',field,wanted}); return q; },
      order(field, opts) { orders.push({field,ascending:opts.ascending}); return q; },
      limit(number) { request.limit = number; return q; },
      abortSignal(signal) { request.signal = signal; return q; },
      then(resolve, reject) {
        let data = rows.filter(row => filters.every(({op,field,wanted}) => {
          const got = value(row, field);
          if (op === 'eq') return String(got) === String(wanted);
          if (op === 'in') return wanted.includes(got);
          if (op === 'gt') return got > wanted;
          if (op === 'gte') return got >= wanted;
          if (op === 'lt') return got < wanted;
          return got <= wanted;
        }));
        data.sort((a,b) => {
          for (const {field,ascending} of orders) {
            const x=value(a,field), y=value(b,field);
            if(x!==y) return (x<y?-1:1)*(ascending?1:-1);
          }
          return 0;
        });
        return Promise.resolve(fail ? {error:new Error('private database details')} : {data:data.slice(0,request.limit)}).then(resolve,reject);
      },
    }; return q;
  }};
}

test('web export includes all roles, excludes other channels and never reads future status', async () => {
  const rows = [row(1,'user','2026-09-23T12:00:00.000Z'), row(2,'assistant'),
    row(3,'user'), row(4,'assistant'), row(5,'operator'),
    row(6,'user','2026-09-24T13:00:00.000Z'), row(7,'user',undefined,'telegram'),
    row(8,'user',undefined,'whatsapp'), row(9,'system')];
  rows[3].meta.escalate = true;
  const db=database(rows);
  const result=await createWebDigestSource(db,{now,coverageStart:'2026-09-22T00:00:00Z'}).readWindow(start,end);
  assert.equal(result.complete,true);
  assert.equal(result.message_count,4);
  assert.deepEqual(result.conversations[0].messages.map(x=>x.id),['2','3','4','5']);
  assert.equal(result.conversations[0].context_before_period.id,'1');
  assert.equal(result.conversations[0].messages[2].escalated,true);
  assert.ok(!JSON.stringify(result).includes('raw_secret'));
  assert.ok(!JSON.stringify(result).includes('external_id'));
  assert.ok(db.reads.every(r=>r.table==='assistant_messages' && r.signal));
  assert.ok(db.reads.filter(r=>r.fields.includes('!inner')).every(r=>r.filters.some(f=>f.field==='assistant_conversations.channel'&&f.wanted==='web')));
});

test('keyset paging includes more than one provider page without duplicates', async () => {
  const db=database(Array.from({length:405},(_,i)=>row(i+1,i%2?'assistant':'user')));
  const result=await createWebDigestSource(db,{now,coverageStart:start}).readWindow(start,end);
  assert.equal(result.message_count,405);
  assert.equal(new Set(result.conversations[0].messages.map(x=>x.id)).size,405);
  assert.equal(db.reads.filter(r=>r.limit===200).length,3);
  assert.ok(db.reads.filter(r=>r.limit===200).every(r=>r.filters.some(f=>f.op==='lte'&&f.field==='id'&&f.wanted===405)));
});

test('unknown coverage stays incomplete even if no messages were returned', async () => {
  const source=createWebDigestSource(database([]),{now});
  const result=await source.readWindow(start,end);
  assert.equal(result.message_count,0); assert.equal(result.complete,false);
  assert.deepEqual(result.warnings,['web_coverage_not_verified_for_period']);
  assert.equal((await createWebDigestSource(database([]),{now,coverageStart:end}).readWindow(start,end)).complete,false);
});

test('provider failure does not become an empty successful export', async () => {
  await assert.rejects(createWebDigestSource(database([],true),{now}).readWindow(start,end),/unavailable/);
});

test('invalid/future/unbounded periods rejected; 25-hour DST period accepted', () => {
  for(const args of [['bad',end],[start,start],['2026-09-20T13:00:00Z',end],[start,'2027-09-24T13:00:00Z'],['2026-09-23T13:00:00',end]]) {
    assert.throws(()=>period(...args,now()),/invalid_report_period/);
  }
  assert.equal(period('2026-11-01T13:00:00Z','2026-11-02T14:00:00Z',Date.parse('2026-12-01T00:00:00Z')).end,'2026-11-02T14:00:00.000Z');
});

test('HTTP export is admin-only, fails closed and returns sanitized failures', async () => {
  const db=database([row(1,'user')]);
  const old=Module._load;
  Module._load=function(request,parent) {
    if(parent?.filename.endsWith('assistant_routes.js')) {
      if(request==='./assistant_store') return {supabase:db};
      if(['./assistant_core','./agent','./store','./admin_assistant','./kb_collector'].includes(request)) return {};
    }
    return old.apply(this,arguments);
  };
  let create;
  try {create=require('./assistant_routes').createAssistantRouter;} finally {Module._load=old;}
  const app=express();app.use('/assistant',create({adminKey:'synthetic-key'}));app.use('/missing',create());
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  const path='/reports/web-messages?'+new URLSearchParams({start,end});
  try {
    assert.equal((await fetch(base+'/assistant'+path)).status,401);
    assert.equal((await fetch(base+'/assistant'+path+'&key=synthetic-key')).status,401);
    assert.equal((await fetch(base+'/missing'+path)).status,503);
    assert.equal(db.reads.length,0);
    const response=await fetch(base+'/assistant'+path,{headers:{'x-admin-key':'synthetic-key'}});
    assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal((await response.json()).message_count,1);
    const bad=await fetch(base+'/assistant/reports/web-messages?start=wrong&end=wrong',{headers:{'x-admin-key':'synthetic-key'}});
    assert.equal(bad.status,400);assert.deepEqual(await bad.json(),{error:'invalid_report_period'});
  } finally {await new Promise(r=>server.close(r));}
});
