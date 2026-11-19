import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveHealthMonitor } from '../src/liveHealth.mjs';

const stats = (...values) => new Map(values.map(value => [value.id, value]));
const source = (energy, duration) => ({id:'mic',type:'media-source',kind:'audio',totalAudioEnergy:energy,totalSamplesDuration:duration});
const remote = (energy, duration, bytes = 0) => ({id:'remote',type:'inbound-rtp',kind:'audio',totalAudioEnergy:energy,totalSamplesDuration:duration,bytesReceived:bytes});

test('quiet listening and cloud-acknowledged long answers do not expire', () => {
  const health = new LiveHealthMonitor();
  assert.equal(health.check(600000), null);
  health.speechStarted('answer', 600000);
  for (let i = 0; i < 180; i++) {
    health.observeStats(stats(source(i / 100, i)), 600000 + i * 1000, true);
    assert.equal(health.check(600000 + i * 1000), null);
  }
  health.speechStopped('answer', 780000);
  health.transcriptionCompleted('answer');
  assert.equal(health.check(900000), null);
});

test('half-finished response warns then pauses; silence RTP packets do not mask a stall', () => {
  const health = new LiveHealthMonitor();
  health.responseRequested(0);
  health.responseProgress(5000);
  for (let i = 0; i <= 50; i++) health.observeStats(stats(remote(0, i, i * 1000)), i * 1000, true);
  assert.equal(health.check(24000), null);
  assert.equal(health.check(25000).level, 'warning');
  assert.equal(health.check(50000).pause, true);
});

test('actual remote audio and transcript progression keep a response alive', () => {
  const health = new LiveHealthMonitor();
  health.responseRequested(0);
  for (let i = 0; i < 60; i++) {
    health.observeStats(stats(remote(i * 0.001, i)), i * 1000, true);
    assert.equal(health.check(i * 1000), null);
  }
  health.responseProgress(70000);
  assert.equal(health.check(89000), null);
  health.responseEnded();
  assert.equal(health.check(600000), null);
});

test('missing final transcription is tracked by item and unrelated completions cannot clear it', () => {
  const health = new LiveHealthMonitor();
  health.speechStarted('lost', 0);
  health.speechStopped('lost', 5000);
  health.speechStarted('second', 10000);
  health.speechStopped('second', 12000);
  health.transcriptionCompleted('second');
  assert.equal(health.check(20000).kind, 'transcription');
  assert.equal(health.check(45000).pause, true);
  health.transcriptionCompleted('lost');
  assert.equal(health.check(46000), null);
});

test('steady partial ASR progress is not mistaken for a stuck final response', () => {
  const health = new LiveHealthMonitor();
  health.speechStarted('answer', 0);
  health.speechStopped('answer', 5000);
  for (let t = 10000; t < 90000; t += 10000) {
    health.transcriptionProgress('answer', t);
    assert.equal(health.check(t + 9000), null);
  }
  health.transcriptionCompleted('answer');
  assert.equal(health.check(600000), null);
});

test('completed ASR arriving before speech-stopped is not subsequently flagged missing', () => {
  const health = new LiveHealthMonitor();
  health.speechStarted('answer', 0);
  health.transcriptionCompleted('answer');
  health.speechStopped('answer', 2000);
  assert.equal(health.check(600000), null);
});

test('sustained local speech without cloud VAD warns; muting cancels only local unacknowledged inference', () => {
  const health = new LiveHealthMonitor();
  for (let i = 0; i <= 4; i++) health.observeStats(stats(source(i * 0.01, i)), i * 1000, true);
  assert.equal(health.check(13000).kind, 'transcription');
  assert.equal(health.check(31000).pause, true);
  health.microphoneMuted();
  assert.equal(health.check(32000), null);
  health.speechStopped('pending', 33000);
  health.observeStats(stats(source(1, 40)), 40000, false);
  assert.equal(health.check(48000).kind, 'transcription');
});

test('scattered small sounds separated by silence cannot accumulate into a phantom answer', () => {
  const health = new LiveHealthMonitor();
  for (let i = 0; i <= 120; i++) {
    const audible = i % 10 === 0;
    health.observeStats(stats({id:'mic',type:'media-source',kind:'audio',audioLevel:audible ? 0.1 : 0}), i * 1000, true);
    assert.equal(health.check(i * 1000), null);
  }
});

test('missing speech-stopped is noticed after measured local speech ends, not during a long answer', () => {
  const health = new LiveHealthMonitor();
  health.speechStarted('answer', 0);
  for (let i = 0; i <= 60; i++) {
    health.observeStats(stats(source(i * 0.01, i)), i * 1000, true);
    assert.equal(health.check(i * 1000), null);
  }
  assert.equal(health.check(76999), null);
  assert.equal(health.check(77000).level, 'warning');
  assert.equal(health.check(102000).pause, true);
  health.transcriptionCompleted('answer');
  assert.equal(health.check(600000), null);
});

test('explicit transcription failure is recoverable immediately and never downgrades to healthy', () => {
  const health = new LiveHealthMonitor();
  health.transcriptionFailed('failed', 0);
  assert.equal(health.check(1).level, 'stalled');
  assert.equal(health.check(15000).pause, true);
  health.transcriptionCompleted('failed');
  assert.equal(health.check(20000), null);
});
