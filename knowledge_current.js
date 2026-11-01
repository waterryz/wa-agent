'use strict';
const crypto = require('node:crypto');
const pack = require('./knowledge_current.json');
const digest = text => crypto.createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n').trim()).digest('hex');
const index = new Map(Object.entries(pack.topics).map(([topic,t]) => [digest(t.text), {topics:[topic]}]));
// Only current canonical texts enter model context. The old database rows and
// embeddings are retained for rollback and are never searched by this release.
// A changed/new row is not silently treated as reviewed merely because its ID matches.
function projectFacts(rows = []) {
  const selected = new Set(['priority','rates','deposit','liability','term','channels','assistant','points','receipt','drivers','handbook_links','consent','termination','languages','dmv','shops','downtime','due','equipment','accident']);
  let unknown = 0;
  for (const row of rows) {
    const reviewed = index.get(digest(row.content));
    if (!reviewed) { unknown++; continue; }
    for (const topic of reviewed.topics) selected.add(topic);
  }
  return { facts: [...selected].map(key => ({content: pack.topics[key].text, topic: key, sources: pack.topics[key].sources, priority: true})), unknown };
}
function publicFactsBlock(rows) {
  const { facts, unknown } = projectFacts(rows);
  if (unknown) console.warn('Unreviewed knowledge rows excluded from BarkAI context:', unknown);
  const date = new Intl.DateTimeFormat('en-CA', {timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return `ПРОВЕРЕННЫЙ СПРАВОЧНИК PRIME FUSION (${pack.version}). Сегодня в Нью-Йорке: ${date}.\nНовые предложения с 2027-01-01 не применять раньше даты или задним числом. Подписанный индивидуальный договор и подтверждённые записи определяют условия конкретного арендатора.\n\n` + facts.map(f => `[${f.topic}] ${f.content}`).join('\n\n');
}
module.exports = { projectFacts, publicFactsBlock, digest, version: pack.version };
