// Слой данных для веб-панели и бота: «виденные» контакты и исключения.
// Использует только Supabase (без Kimi/OpenAI) — поэтому web.js не тянет лишнего.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].forEach((n) => {
  if (!process.env[n]) {
    console.error(`❌ Не задана переменная окружения ${n}. Заполни .env (см. .env.example).`);
    process.exit(1);
  }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// нормализация номера → только цифры
function normalize(num) {
  return String(num || '').replace(/\D/g, '');
}

// запомнить контакт, который написал боту (для выбора в панели)
async function recordContact(number, name) {
  const n = normalize(number);
  if (!n) return;
  await supabase
    .from('seen_contacts')
    .upsert({ number: n, name: name || null, last_seen: new Date().toISOString() }, { onConflict: 'number' });
}

async function listSeen() {
  const { data, error } = await supabase
    .from('seen_contacts')
    .select('number, name, last_seen')
    .order('last_seen', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

async function listBlocked() {
  const { data, error } = await supabase
    .from('blocked_contacts')
    .select('id, number, name, created_at')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function addBlocked(number, name) {
  const n = normalize(number);
  if (!n) throw new Error('Пустой или некорректный номер');
  const { data, error } = await supabase
    .from('blocked_contacts')
    .upsert({ number: n, name: name || null }, { onConflict: 'number' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function removeBlocked(id) {
  const { error } = await supabase.from('blocked_contacts').delete().eq('id', id);
  if (error) throw error;
}

// множество заблокированных номеров (для быстрой проверки в боте)
async function blockedNumbers() {
  const { data, error } = await supabase.from('blocked_contacts').select('number');
  if (error) {
    console.error('⚠️  blockedNumbers:', error.message);
    return new Set();
  }
  return new Set((data || []).map((r) => r.number));
}

// ── Эскалации: вопросы, переданные человеку ──────────────────────────
async function addEscalation(number, name, question, reason) {
  const { data, error } = await supabase
    .from('escalations')
    .insert({
      number: normalize(number) || null,
      name: name || null,
      question: question || null,
      reason: reason || null,
    })
    .select()
    .single();
  if (error) {
    console.error('⚠️  addEscalation:', error.message);
    return null;
  }
  return data;
}

async function listEscalations() {
  const { data, error } = await supabase
    .from('escalations')
    .select('id, number, name, question, reason, resolved, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}

async function resolveEscalation(id) {
  const { error } = await supabase.from('escalations').update({ resolved: true }).eq('id', id);
  if (error) throw error;
}

module.exports = {
  supabase,
  normalize,
  recordContact,
  listSeen,
  listBlocked,
  addBlocked,
  removeBlocked,
  blockedNumbers,
  addEscalation,
  listEscalations,
  resolveEscalation,
};
