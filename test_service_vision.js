const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

process.env.MOONSHOT_API_KEY = 'synthetic';
process.env.OPENAI_API_KEY = 'synthetic';
process.env.SUPABASE_URL = 'https://example.test';
process.env.SUPABASE_SERVICE_KEY = 'synthetic';
let parsed = {};
let request;
const oldLoad = Module._load;
Module._load = function(name, parent) {
  if (parent?.filename.endsWith('agent.js')) {
    if (name === 'dotenv') return { config() {} };
    if (name === 'openai') return class OpenAI {
      constructor() { this.chat = { completions: { create: async (body) => {
        request = body;
        return { choices: [{ message: { content: JSON.stringify(parsed) }, finish_reason: 'stop' }], usage: {} };
      } } }; }
    };
    if (name === '@supabase/supabase-js') return { createClient: () => ({}) };
  }
  return oldLoad.apply(this, arguments);
};
let describeServicePhotos;
try { ({ describeServicePhotos } = require('./agent')); } finally { Module._load = oldLoad; }

test('service vision returns explicit image and receipt evidence without DMV requirement', async () => {
  parsed = {
    receipt_date: '9/28/26', service_date: '9/28/26', receipt_total: '$162.00', plate: 'ABC123', customer: 'ANTON',
    image_evidence: [{ index: 1, kind: 'receipt', readable: true },
                     { index: 2, kind: 'odometer', readable: true }],
    odometer: '171,200 mi', works: ['замена масла', 'задние колодки'],
    line_items: [{ description: 'Oil change', amount: '$100' },
                 { description: 'Rear brake pads', amount: '$50' }],
    tax: '$12', oil_details: { brand: 'Mobil', viscosity: '5W-30', quantity: '5 qt' },
    brake_details: { work: 'pads replaced', axle: 'rear' }, warnings: [],
  };
  const out = await describeServicePhotos([{ b64: 'AAAA', mime: 'image/jpeg' },
                                           { b64: 'BBBB', mime: 'image/jpeg' }]);
  assert.equal(out.odometer, '171200');
  assert.equal(out.image_evidence.length, 2);
  assert.equal(out.line_items[1].amount, '$50');
  assert.equal(out.brake_details.axle, 'rear');
  assert.ok(request.messages[0].content.includes('НЕ требуй чек-лист DMV'));
});

test('malformed and duplicate image evidence cannot claim full coverage', async () => {
  parsed = { image_evidence: [{ index: 1, kind: 'receipt', readable: true },
                              { index: 1, kind: 'odometer', readable: true },
                              { index: 99, kind: 'receipt', readable: true }] };
  const out = await describeServicePhotos([{ b64: 'AAAA', mime: 'image/jpeg' },
                                           { b64: 'BBBB', mime: 'image/jpeg' }]);
  assert.equal(out.image_evidence.length, 1);
});
