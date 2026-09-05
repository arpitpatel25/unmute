import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDemo, advanceDemo, prices } from '../product-model.js';
test('agent preview moves from ready to working to attention and accepts a reply',()=>{
 let s=initialDemo('remote'); s=advanceDemo(s,'start'); assert.equal(s.phase,'working');
 s=advanceDemo(s,'finish'); assert.equal(s.phase,'attention');
 assert.equal(advanceDemo(s,'reply','').phase,'attention');
 s=advanceDemo(s,'reply','Use Thursday'); assert.equal(s.phase,'complete'); assert.equal(s.reply,'Use Thursday');
});
test('reset and mode changes cannot leave a previous task result in a new preview',()=>{
 let s=advanceDemo(initialDemo('remote'),'start'); s=advanceDemo(s,'reset'); assert.equal(s.phase,'idle');
 assert.equal(initialDemo('dictation').reply,''); assert.equal(initialDemo('invalid').mode,'dictation');
});
test('annual prices are annual totals, sourced from cloud Billing.tsx',()=>{
 assert.equal(prices.dictation.year,49); assert.equal(prices.unmute.month,7.99); assert.equal(prices.unmute.year,79);
});
