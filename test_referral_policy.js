const test=require('node:test'),assert=require('node:assert/strict');
const pack=require('./knowledge_current.json'),{publicFactsBlock}=require('./knowledge_current'),{PROSPECT_POLICY}=require('./prospect_policy');
test('referral answer uses 500 = 250 + 250 with continued rental at redemption, separate from ordinary accruals',()=>{
 const t=pack.topics.points.text;
 assert.match(t,/500 баллов\. 250 баллов/);assert.match(t,/аренды\. Ещё 250 баллов/);
 assert.match(t,/на этот день продолжает работать с Prime Fusion/);
 assert.match(t,/52 × 5 \+ 12 × 20 \+ 2 × 250/);
 assert.match(PROSPECT_POLICY,/second installment is not automatic/);
 assert.doesNotMatch(publicFactsBlock([]),/300 баллов\. 100 баллов/);
});
test('reviewed vectors remain retrieval-only, current factual projection supersedes their old wording',()=>{
 assert.match(pack.topics.points.indexedText,/300 баллов\. 100 баллов/);
 assert.match(publicFactsBlock([{content:pack.topics.points.indexedText}]),/500 баллов\. 250 баллов/);
});
