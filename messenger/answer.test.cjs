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
  test(`first general rental price question in ${locale} includes all plans and annual bonus`, async () => {
    const answer = createAnswer({policy});
    const reply = await answer({locale, text:question});
    for (const amount of ['$600', '$625', '$650']) assert.ok(reply.includes(amount));
    assert.match(reply, /2[ ,]500/);
    assert.match(reply, /3[ ,]500/);
    assert.match(reply, /4[ ,]500/);
    assert.match(reply, /\$1[ ,]500/);
    assert.doesNotMatch(reply, /не налич|бонусного кредита|not cash|non.cash|rental (?:bonus )?credit|ბონუს კრედიტ/iu);
    assert.match(reply, /могу рассказать|I can explain|შემიძლია აქ აგიხსნათ/u);
    assert.doesNotMatch(reply, /\$5[ ,]000|\$1[ ,]000/);
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

for (const [locale,text] of [['en','Where is your office?'],['ru','Где ваш офис?'],['ka','სად არის თქვენი ოფისი?']]) {
 test('company office uses the company address in '+locale,async()=>{
  const answer=createAnswer({policy}); const reply=await answer({locale,text});
  assert.match(reply,/76 Battery Ave, Brooklyn, NY 11228/);
  assert.doesNotMatch(reply,/2965|AMS|891-6626/);
 });
}
test('service address does not trigger company office shortcut',()=>{
 const {officeAnswer}=require('../prospect_policy');
 assert.equal(officeAnswer('What is your service shop address?','en'),null);
 assert.equal(officeAnswer('Где офис автосервиса?','ru'),null);
});
test('explicit deposit questions retain accurate reference and request-based presentation',async()=>{
 const answer=createAnswer({policy,projectFacts,retrieveContext:async()=>({facts:[]}),generate:async(system)=>{
  assert.match(system,/Do not volunteer deposits/);
  assert.match(system,/customer asks about the deposit, liability, extra discount/);
  assert.match(system,/BOTH \$5,000 conditions/);
  return {text:'The standard deposit is $1,000. The optional $25 weekly discount on New Style 4,500 or Old School requires both a $5,000 deposit and a $5,000 damage liability limit.'};
 }});
 assert.match(await answer({locale:'en',text:'Explain the deposit and the extra discount'}),/both a \$5,000 deposit/);
});

test('office guidance uses owner clarification and advance staff confirmation',()=>{const {PROSPECT_POLICY,officeAnswer}=require('../prospect_policy');assert.match(officeAnswer('I will come to visit office','en').text,/no separate walk-in office/);assert.match(officeAnswer('Where is office?','en').text,/at least two hours/);assert.match(PROSPECT_POLICY,/broker does not work on weekends/);assert.match(PROSPECT_POLICY,/without a successful corresponding tool receipt/);});

test('a direct cash-redemption question still requests an accurate answer rather than a sales deflection',async()=>{
 let called=false;
 const answer=createAnswer({policy,projectFacts,retrieveContext:async()=>({facts:[]}),generate:async(system)=>{
   called=true;
   assert.match(system,/visitor directly asks whether cash is paid/);
   assert.match(system,/it is rental credit, not a cash payout/);
   return {text:'It is rental credit, not a cash payout. I can explain how redemption works.'};
 }});
 const result=await answer({locale:'en',text:'Can I get this bonus in cash?'});
 assert.equal(called,true);assert.match(result,/not a cash payout/);
});
