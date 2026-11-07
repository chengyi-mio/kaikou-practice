import test from 'node:test';
import assert from 'node:assert/strict';
import { usageEntry, usageTotals } from '../src/liveUsage.mjs';
test('provider modality totals distinguish unknown usage from zero and do not add context twice', () => {
  const e = usageEntry({ id:'r1', status:'completed', usage:{total_tokens:377,input_tokens:336,output_tokens:41,input_tokens_details:{text_tokens:228,audio_tokens:108},output_tokens_details:{text_tokens:9,audio_tokens:32}} }, {connection:'one',model:'qwen'});
  assert.equal(usageTotals([e]).total,377); assert.equal(usageTotals([e]).inputAudio,108);
  const next = usageEntry({id:'r2',usage:{total_tokens:100}}, {connection:'one',model:'qwen'});
  assert.equal(usageTotals([e,next]).total,477); assert.equal(usageTotals([e,next]).inputAudio,null);
  assert.equal(usageTotals([]).total,null);
  assert.equal(usageEntry({id:'r3',usage:{total_tokens:-1}}, {connection:'one',model:'qwen'}),null);
  assert.notEqual(e.id, usageEntry({id:'r1',usage:{total_tokens:0}}, {connection:'two',model:'qwen'}).id);
});
