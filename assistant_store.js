// assistant_store.js — слой данных для общего ядра ИИ-ассистента.
// Работает с таблицами assistant_conversations / assistant_messages (см.
// assistant_migration.sql). Не тянет Kimi/OpenAI — только Supabase.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].forEach((n) => {
  if (!process.env[n]) {
    console.error(`❌ Не задана переменная окружения ${n}.`);
    process.exit(1);
  }
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const HISTORY_LIMIT = parseInt(process.env.ASSISTANT_HISTORY_LIMIT || '16', 10);

// ── Найти или создать диалог по (channel, external_id) ───────────────
// Если переданы свежие контактные данные — дописываем их (не затирая пустыми).
async function getOrCreateConversation({
  channel,
  external_id,
  name = null,
  email = null,
  phone = null,
  is_driver = null,
  driver_id = null,
}) {
  const extId = String(external_id);

  const { data: existing, error: selErr } = await supabase
    .from('assistant_conversations')
    .select('*')
    .eq('channel', channel)
    .eq('external_id', extId)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    // Точечно обновляем только то, что пришло непустым и реально изменилось.
    const patch = {};
    if (name && name !== existing.contact_name) patch.contact_name = name;
    if (email && email !== existing.contact_email) patch.contact_email = email;
    if (phone && phone !== existing.contact_phone) patch.contact_phone = phone;
    if (is_driver !== null && is_driver !== existing.is_driver) patch.is_driver = is_driver;
    if (driver_id && driver_id !== existing.driver_id) patch.driver_id = driver_id;
    if (Object.keys(patch).length) {
      const { data: upd, error: updErr } = await supabase
        .from('assistant_conversations')
        .update(patch)
        .eq('id', existing.id)
        .select()
        .single();
      if (updErr) throw updErr;
      return upd;
    }
    return existing;
  }

  const { data: created, error: insErr } = await supabase
    .from('assistant_conversations')
    .insert({
      channel,
      external_id: extId,
      contact_name: name,
      contact_email: email,
      contact_phone: phone,
      is_driver: is_driver === null ? false : is_driver,
      driver_id,
    })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

// ── Сохранить сообщение + подвинуть last_message_at диалога ──────────
async function saveMessage(conversationId, role, content, meta = null) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .insert({ conversation_id: conversationId, role, content, meta })
    .select()
    .single();
  if (error) throw error;
  await supabase
    .from('assistant_conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);
  return data;
}

// ── История диалога в формате для модели (user/assistant) ────────────
// operator → assistant (для модели это «наша сторона»), system пропускаем,
// подряд идущие одинаковые роли склеиваем, ведущие assistant отбрасываем.
async function getHistory(conversationId, limit = HISTORY_LIMIT) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  const rows = (data || []).reverse(); // снова в хронологическом порядке
  const turns = [];
  for (const m of rows) {
    if (m.role === 'system') continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = (m.content || '').trim();
    if (!text) continue;
    if (turns.length && turns[turns.length - 1].role === role) {
      turns[turns.length - 1].content += '\n' + text;
    } else {
      turns.push({ role, content: text });
    }
  }
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

// ── Список диалогов для админки (из представления) ───────────────────
async function listConversations({ channel = null, status = null, limit = 100 } = {}) {
  let q = supabase
    .from('assistant_conversation_list')
    .select('*')
    .order('last_message_at', { ascending: false })
    .limit(limit);
  if (channel) q = q.eq('channel', channel);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

async function getConversation(id) {
  const { data, error } = await supabase
    .from('assistant_conversations')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

// Полная история сообщений (для окна чата в админке), хронологически.
async function getMessages(conversationId, { afterId = null, limit = 500 } = {}) {
  let q = supabase
    .from('assistant_messages')
    .select('id, role, content, meta, created_at')
    .eq('conversation_id', conversationId)
    .order('id', { ascending: true })
    .limit(limit);
  if (afterId) q = q.gt('id', afterId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Новые ответы для веб-клиента (поллинг): только assistant/operator после afterId.
async function getRepliesSince(conversationId, afterId = 0) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('id, role, content, created_at')
    .eq('conversation_id', conversationId)
    .in('role', ['assistant', 'operator'])
    .gt('id', afterId)
    .order('id', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function setOperatorMode(conversationId, on) {
  const { error } = await supabase
    .from('assistant_conversations')
    .update({ operator_mode: !!on })
    .eq('id', conversationId);
  if (error) throw error;
}

async function setStatus(conversationId, status) {
  const { error } = await supabase
    .from('assistant_conversations')
    .update({ status })
    .eq('id', conversationId);
  if (error) throw error;
}

async function markAdminRead(conversationId) {
  const { error } = await supabase
    .from('assistant_conversations')
    .update({ admin_last_read_at: new Date().toISOString() })
    .eq('id', conversationId);
  if (error) throw error;
}

module.exports = {
  supabase,
  getOrCreateConversation,
  saveMessage,
  getHistory,
  listConversations,
  getConversation,
  getMessages,
  getRepliesSince,
  setOperatorMode,
  setStatus,
  markAdminRead,
};