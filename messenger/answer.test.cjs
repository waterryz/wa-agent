'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {createAnswer} = require('./answer.cjs');
const {projectFacts} = require('../knowledge_current');
const policy = require('../dialogue_policy');

for (const [locale, question, discount] of [
  ['ru', 'Какая цена?', /дополнительная скидка \$25 в неделю/],
  ['en', 'How much per week?', /additional \$25 per week/],
  ['ka', 'რა ღირს?', /დამატებითი ფასდაკლება კვირაში \$25/]
]) {
  test(`first general rental price question in ${locale} includes all plans and the additional discount`, async () => {
    const answer = createAnswer({policy});
    const reply = await answer({locale, text:question});
    for (const amount of ['$600', '$625', '$650']) assert.ok(reply.includes(amount));
    assert.match(reply, /2[ ,]500/);
    assert.match(reply, /3[ ,]500/);
    assert.match(reply, /4[ ,]500/);
    assert.equal(reply.match(/\$5[ ,]000/g).length, 2);
    assert.match(reply, discount);
    assert.ok(reply.endsWith('https://primefusioncars.com/?lang=' + locale + '#rates'));
    assert.doesNotMatch(reply, /\*\*|добровольная скидка/i);
  });
}

test('compound Messenger question reaches the model; availability and pricing are distinct', async () => {
  let received = '';
  const question = 'What year is the white Sienna and is it $600 per week?';
  const answer = createAnswer({
    policy, projectFacts, retrieveContext: async () => ({facts:[]}),
    generate: async (system, message) => {
      assert.match(system, /rate alone does not confirm a vehicle year, color or availability/i);
      received = JSON.parse(message).question;
      return {text:'**New Style:** $600, $625 or $650. **Old School Style:** $650. Staff can confirm the color and model year here.'};
    }
  });
  const reply = await answer({locale:'en', text:question});
  assert.equal(received, question);
  assert.match(reply, /color and model year here/);
  assert.doesNotMatch(reply, /\*\*/);
  assert.ok(reply.endsWith('?lang=en#rates'));
});
