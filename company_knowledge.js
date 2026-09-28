// Approved public documents only. Never load private card exports or chat archives.
const crypto = require('node:crypto');
const handbook = require('./knowledge/mobile-handbook.json');
const snapshot = require('./knowledge/test-catalog.json');
const approved = require('./knowledge/owner-approved.json');
const { withoutCourtesy } = require('./fast_answers');
const TEST_URL = 'https://primefusioncars.com/api/translate?lang=ru';
const STOP = new Set('что как где когда для или это нужно можно меня мне вас если при после какие какой работать пожалуйста the and what how where when can have with from your about often please'.split(' '));

function normalize(text) { return withoutCourtesy(text).replace(/[?!.,:;]+$/g, '').trim(); }
function tokens(text) {
  return [...new Set((String(text).toLowerCase().replace(/ё/g, 'е').replace(/пандус[а-я]*/g, 'рампа').match(/[\p{L}\p{N}]+/gu) || [])
    .filter(t => t.length >= 3 && !STOP.has(t)).map(t => /[а-я]/u.test(t) && t.length > 4 ? t.slice(0, 4) : t.length > 5 ? t.slice(0, 5) : t))];
}
function validateCatalog(data) {
  if (!Array.isArray(data?.questions) || !data.questions.length || data.questions.length > 500) throw Error('invalid_test');
  const ids = new Set();
  for (const q of data.questions) {
    if (!q || typeof q.id !== 'string' || ids.has(q.id) || typeof q.question !== 'string' ||
        !Array.isArray(q.options) || !q.options.every(x => typeof x === 'string') ||
        !Number.isInteger(q.correct) || q.correct < 0 || q.correct >= q.options.length) throw Error('invalid_test');
    ids.add(q.id);
  }
  return data.questions;
}
function answerText(question) {
  const answer = question.options[question.correct];
  const needsOptions = /все перечислен|все вариант|ни один|all of|none of/i.test(answer);
  return 'В действующем тесте правильный ответ: ' + answer +
    (needsOptions ? '\n\nВарианты в этом вопросе:\n' + question.options.map((x, i) => `${i + 1}. ${x}`).join('\n') : '');
}
function rank(query, items, limit = 4) {
  const words = tokens(query);
  if (!words.length) return [];
  const indexed = items.map(item => ({ item, terms: new Set(tokens(item.content)) }));
  const weight = new Map(words.map(w => [w, 1 + Math.log((1 + items.length) / (1 + indexed.filter(x => x.terms.has(w)).length))]));
  const total = words.reduce((sum, w) => sum + weight.get(w), 0);
  return indexed.map(({ item, terms }) => {
    return { item, score: words.filter(w => terms.has(w)).reduce((sum, w) => sum + weight.get(w), 0) / total };
  }).filter(x => x.score >= .4).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.item);
}
function createKnowledge({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let live = null, loadedAt = 0, retryAt = 0, pending = null;
  async function catalog() {
    if (live && now() - loadedAt < 60000) return live;
    if (now() < retryAt) return null;
    if (pending) return pending;
    pending = (async () => {
      try {
        const response = await fetchImpl(TEST_URL, { signal: AbortSignal.timeout(3000), redirect: 'error' });
        if (!response.ok) throw Error('test_unavailable');
        const text = await response.text();
        if (text.length > 1000000) throw Error('test_too_large');
        const questions = validateCatalog(JSON.parse(text));
        live = { questions, version: crypto.createHash('sha256').update(JSON.stringify(questions)).digest('hex') };
        loadedAt = now();
        return live;
      } catch {
        // Stale snapshot remains a matching hint, never a claim about current answers.
        retryAt = now() + 30000;
        return null;
      } finally { pending = null; }
    })();
    return pending;
  }
  async function testAnswer(text, language) {
    if (language && language !== 'ru') return null;
    const needle = normalize(text);
    const candidates = live?.questions || snapshot.questions;
    if (!candidates.some(q => normalize(q.question) === needle)) return null;
    const current = await catalog();
    const question = current?.questions.find(q => normalize(q.question) === needle);
    if (!question) return null;
    return { id: `test:${question.id}`, text: answerText(question),
      source: TEST_URL, version: current.version, action: null };
  }
  async function context(query) {
    const current = await catalog();
    const testFacts = (current?.questions || []).map(q => ({
      source: TEST_URL, priority: true,
      content: `Действующий тест Prime Fusion, версия ${current.version.slice(0, 12)}. Вопрос: ${q.question}\n${answerText(q)}`,
    }));
    const documents = handbook.pages.filter(p => !/Оглавление|Table of contents/i.test(p.content))
      .map(p => ({ source: p.source, priority: false, content: `${p.source}\n${p.content}` }));
    const ownerFacts = approved.facts.map(content => ({ source: approved.source, priority: true, content }));
    return [...rank(query, ownerFacts, 2), ...rank(query, testFacts, 2), ...rank(query, documents, 3)];
  }
  return { catalog, context, testAnswer };
}
module.exports = { ...createKnowledge(), createKnowledge, validateCatalog, rank };
