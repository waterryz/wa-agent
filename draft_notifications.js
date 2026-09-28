// Notifications contain no keys. Review and approval stay in the authenticated admin UI.
const crypto = require('node:crypto');
function noticeKey(row) {
  return `kb_notice:${row.id}:${crypto.createHash('sha256').update(row.raw_text || '').digest('hex').slice(0, 16)}`;
}
function createDraftNotifier({ db, fetchImpl = globalThis.fetch, env = process.env }) {
  let flushing = false;
  async function flush() {
    if (flushing) return { skipped: 'busy' };
    const token = env.KB_NOTIFY_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    const chatId = env.KB_NOTIFY_CHAT_ID;
    let url;
    try { url = new URL(env.KB_ADMIN_URL); } catch { return { skipped: 'not_configured' }; }
    if (!token || !chatId || url.protocol !== 'https:' || url.username || url.password || url.search) return { skipped: 'not_configured' };
    flushing = true;
    let sent = 0;
    try {
      const { data, error } = await db.from('knowledge_staging').select('id,raw_text,proposed_content,status')
        .eq('status', 'pending').order('created_at', { ascending: true }).limit(100);
      if (error) throw Error('draft_notice_read_failed');
      for (const row of data || []) {
        const key = noticeKey(row);
        const prior = await db.from('tg_poll_state').select('last_update_id').eq('bot', key).maybeSingle();
        if (prior.error) throw Error('draft_notice_state_failed');
        if (prior.data) continue;
        // Send at most 5 per iteration; do not block the collector behind a backlog.
        if (sent >= 5) break;
        const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(8000),
          body: JSON.stringify({ chat_id: chatId,
            text: `Новый черновик для ИИ · #${row.id}\n\n${String(row.proposed_content || row.raw_text).slice(0, 700)}\n\nОткройте админку и подтвердите или отклоните. До подтверждения этот текст не используется в ответах.`,
            reply_markup: { inline_keyboard: [[{ text: 'Открыть в админке', url: url.href }]] },
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok || !Number.isSafeInteger(result.result?.message_id)) throw Error('draft_notice_send_failed');
        const saved = await db.from('tg_poll_state').upsert({ bot: key, last_update_id: result.result.message_id, updated_at: new Date().toISOString() }, { onConflict: 'bot' });
        if (saved.error) throw Error('draft_notice_save_failed');
        sent++;
      }
      return { sent };
    } finally { flushing = false; }
  }
  return { flush };
}
module.exports = { createDraftNotifier, noticeKey };
