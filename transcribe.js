// Telegram sends recorded voice messages. All credentials stay on this server.
const crypto = require('node:crypto');
const TYPES = { ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', flac: 'audio/flac' };
const MAX_BYTES = 12 * 1024 * 1024;
const cache = new Map();
const rates = new Map();

function decode(body) {
  const extension = String(body.filename || '').split('.').pop().toLowerCase();
  if (!TYPES[extension] || typeof body.audio !== 'string' || !body.audio.length || body.audio.length > Math.ceil(MAX_BYTES / 3) * 4) throw new Error('invalid_audio');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) throw new Error('invalid_audio');
  const buffer = Buffer.from(body.audio, 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64') !== body.audio) throw new Error('invalid_audio');
  return { buffer, filename: `voice.${extension}`, mime: TYPES[extension] };
}

async function transcribe(body, request = fetch) {
  const { buffer, filename, mime } = decode(body);
  const uid = String(body.external_id || '');
  if (!/^\d{1,20}$/.test(uid)) throw new Error('invalid_identity');
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires < now) cache.delete(k);
  for (const [k, v] of rates) if (v.expires < now) rates.delete(k);
  const digest = uid + ':' + crypto.createHash('sha256').update(buffer).digest('hex');
  if (cache.has(digest)) return cache.get(digest).text;
  const rate = rates.get(uid) || { count: 0, expires: now + 3600000 };
  if (rate.count >= 20) throw new Error('voice_limit');
  if (!process.env.OPENAI_API_KEY) throw new Error('voice_unavailable');
  rate.count++;
  rates.set(uid, rate);
  const form = new FormData();
  const model = process.env.TRANSCRIBE_MODEL || 'gpt-transcribe';
  form.append('file', new Blob([buffer], { type: mime }), filename);
  form.append('model', model);
  // Autodetect the actual spoken language; do not force Telegram UI language.
  // No language hint excludes Georgian, Russian or English recordings.
  form.append('response_format', 'json');
  const response = await request('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form,
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error('voice_unavailable');
  const data = await response.json();
  if (typeof data.text !== 'string' || !data.text.trim()) throw new Error('voice_empty');
  const text = data.text.trim().slice(0, 12000);
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(digest, { text, expires: now + 600000 });
  return text;
}
module.exports = { decode, transcribe };
