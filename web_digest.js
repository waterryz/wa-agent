'use strict';

// Read-only, bounded export of the existing web conversation journal.
// Never reads Telegram (the bot journals it), WhatsApp or knowledge-editor chats.
const PAGE_SIZE = 200;
const MAX_MESSAGES = 5000;

function period(start, end, now = Date.now()) {
  const stamp = value => typeof value === 'string' &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  const a = stamp(start), b = stamp(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a ||
      b - a > 26 * 3600000 || b > now) {
    const error = new Error('invalid_report_period'); error.status = 400; throw error;
  }
  return { start: new Date(a).toISOString(), end: new Date(b).toISOString() };
}

function message(row) {
  if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1 ||
      !['user', 'assistant', 'operator'].includes(row.role) ||
      !Number.isFinite(Date.parse(row.created_at))) throw new Error('invalid_journal_row');
  return { id: String(row.id), role: row.role, text: String(row.content || ''),
           at: new Date(row.created_at).toISOString(),
           escalated: row.role === 'assistant' && row.meta?.escalate === true };
}

function createWebDigestSource(db, { coverageStart = '', now = Date.now } = {}) {
  async function readWindow(rawStart, rawEnd) {
    const window = period(rawStart, rawEnd, now());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    timer.unref?.();
    // A fixed ID fence prevents a moving pagination result on concurrent writes.
    const query = fields => db.from('assistant_messages').select(fields)
      .eq('assistant_conversations.channel', 'web')
      .in('role', ['user', 'assistant', 'operator'])
      .gte('created_at', window.start).lt('created_at', window.end)
      .abortSignal(controller.signal);
    const checked = async q => {
      const result = await q;
      if (result.error || !Array.isArray(result.data)) throw new Error('web_journal_unavailable');
      return result.data;
    };
    try {
      const fenceRows = await checked(query('id,assistant_conversations!inner(channel)')
        .order('id', { ascending: false }).limit(1));
      const fence = Number(fenceRows[0]?.id || 0);
      if (!Number.isSafeInteger(fence) || fence < 0) throw new Error('invalid_journal_cursor');
      const rows = [];
      let after = 0;
      while (after < fence) {
        const page = await checked(query('id,conversation_id,role,content,meta,created_at,assistant_conversations!inner(id,channel,contact_name)')
          .gt('id', after).lte('id', fence).order('id', { ascending: true }).limit(PAGE_SIZE));
        if (!page.length) throw new Error('web_journal_changed_during_export');
        for (const row of page) {
          if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= after || Number(row.id) > fence ||
              row.assistant_conversations?.channel !== 'web' ||
              Date.parse(row.created_at) < Date.parse(window.start) || Date.parse(row.created_at) >= Date.parse(window.end)) {
            throw new Error('invalid_journal_page');
          }
          after = Number(row.id); rows.push(row);
        }
        if (rows.length > MAX_MESSAGES) throw new Error('web_report_too_large');
      }
      const groups = new Map();
      for (const row of rows) {
        const id = String(row.conversation_id);
        if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new Error('invalid_conversation_id');
        if (!groups.has(id)) groups.set(id, { conversation_id: id,
          name: row.assistant_conversations.contact_name || null, messages: [] });
        groups.get(id).messages.push(message(row));
      }
      // One prior user message is context, never counted as a new daily question.
      for (const group of groups.values()) {
        group.messages.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || Number(a.id) - Number(b.id));
        const prior = await checked(db.from('assistant_messages')
          .select('id,role,content,created_at').eq('conversation_id', group.conversation_id)
          .eq('role', 'user').lt('created_at', window.start)
          .order('created_at', { ascending: false }).order('id', { ascending: false })
          .limit(1).abortSignal(controller.signal));
        group.context_before_period = prior.length ? message(prior[0]) : null;
      }
      const since = typeof coverageStart === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(coverageStart)
        ? Date.parse(coverageStart) : NaN;
      const complete = Number.isFinite(since) && since <= Date.parse(window.start);
      return { ...window, source: 'assistant_web', version: 1,
        coverage_started_at: Number.isFinite(since) ? new Date(since).toISOString() : null,
        complete, warnings: complete ? [] : ['web_coverage_not_verified_for_period'],
        message_count: rows.length, conversations: [...groups.values()] };
    } finally { clearTimeout(timer); }
  }
  return { readWindow };
}

module.exports = { createWebDigestSource, period };
