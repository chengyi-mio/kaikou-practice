import { test, expect, type Page } from '@playwright/test';
import { nativePeer, prepare } from './helpers/live-peer';

// Real, local WebRTC and MediaRecorder are retained. Only provider events and
// health statistics are controlled; no real model or user microphone is used.
async function controlledPeer(page: Page) {
  // Install before the hook's intervals exist; pause only after WebRTC starts.
  await page.clock.install();
  await page.addInitScript(() => {
    const w = window as any;
    const Native = RTCPeerConnection;
    w.__recoveryPeers = [];
    window.RTCPeerConnection = class extends Native {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        w.__recoveryPeers.push(this);
      }
      createDataChannel(label: string, options?: RTCDataChannelInit) {
        const channel = super.createDataChannel(label, options);
        (w.__recoveryChannels ||= []).push(channel);
        return channel;
      }
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const tone = context.createOscillator();
      const gain = context.createGain();
      const destination = context.createMediaStreamDestination();
      tone.frequency.value = 440;
      gain.gain.value = 0;
      tone.connect(gain).connect(destination);
      tone.start();
      await context.resume();
      w.__recoveryMicrophone = { context, tone, gain };
      return destination.stream;
    };
  });
  await nativePeer(page);
  await prepare(page);
  await page.getByRole('button', { name: '开始 LIVE 面试', exact: true }).click();
  await expect(page.locator('.live-current-question')).toContainText('请介绍你负责的一次产品项目？');
  await expect(page.locator('.live-recording-disclosure > summary')).toContainText('正在录制双方声音');
}

async function stalledStats(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    const pc = w.__recoveryPeers[0] as RTCPeerConnection;
    w.__healthSamples = { remoteEnergy: 1, micEnergy: 0, micLevel: 0, seconds: 1 };
    pc.getStats = async () => {
      const s = w.__healthSamples;
      const stats = new Map();
      stats.set('incoming', { id: 'incoming', type: 'inbound-rtp', kind: 'audio', mediaType: 'audio', bytesReceived: 12000, packetsReceived: 100, totalAudioEnergy: s.remoteEnergy, totalSamplesDuration: s.seconds, timestamp: Date.now() });
      stats.set('microphone', { id: 'microphone', type: 'media-source', kind: 'audio', trackIdentifier: pc.getSenders().find(sender => sender.track?.kind === 'audio')?.track?.id, totalAudioEnergy: s.micEnergy, totalSamplesDuration: s.seconds, audioLevel: s.micLevel, timestamp: Date.now() });
      return stats as unknown as RTCStatsReport;
    };
  });
}

async function emit(page: Page, events: Record<string, unknown>[]) {
  await page.evaluate(events => (window as any).__emit(events), events);
}

async function clock(page: Page) {
  // The browser clock can lead the Node clock by a few milliseconds. Pause at
  // an observed future browser instant, not an already elapsed host timestamp.
  await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now() + 500)));
}

async function records(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('kaikou-live-recordings', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    return new Promise<any[]>((resolve, reject) => { const r = db.transaction('recordings').objectStore('recordings').getAll(); r.onsuccess = () => { db.close(); resolve(r.result); }; r.onerror = () => { db.close(); reject(r.error); }; });
  });
}

const requests = (page: Page) => page.evaluate(() => (window as any).__liveRequests?.length || 0);
const draft = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('kaikou.live-interview.draft.v1')!));

async function pendingResponseInterruptedBySpeech(page: Page) {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [{ type: 'response.done', response: { id: 'opening', status: 'completed' } }]);
  await expect(page.locator('.live-focus-status')).toContainText('正在聆听');
  await page.evaluate(() => {
    const w = window as any;
    const strict = w.__strictProvider = { creates: 0, prematureCancels: 0, overlappingCreates: 0, cancels: 0, pending: false, active: '' };
    w.__releasePendingResponse = () => {
      strict.pending = false;
      strict.active = 'delayed-created';
      w.__emit([{ type: 'response.created', response: { id: strict.active } }]);
    };
    w.__channel.onmessage = (message: MessageEvent) => {
      const event = JSON.parse(message.data);
      w.__providerEvents.push(event);
      if (event.type === 'response.create') {
        if (strict.pending || strict.active) {
          strict.overlappingCreates++;
          w.__emit([{ type: 'error', error: { message: 'A response is already in progress' } }]);
          return;
        }
        strict.creates++;
        if (strict.creates === 1) {
          strict.pending = true;
          // Reproduce the exact real-service ordering: speech resumes 15 ms
          // after response.create, before the server has emitted created.
          setTimeout(() => w.__emit([{ type: 'input_audio_buffer.speech_started', item_id: 'barge-in-answer' }]), 15);
        } else {
          w.__emit([
            { type: 'response.created', response: { id: 'current-answer-followup' } },
            { type: 'response.audio_transcript.done', response_id: 'current-answer-followup', item_id: 'current-followup-text', transcript: '你刚补充的验证结果，具体如何获得？' },
            { type: 'response.done', response: { id: 'current-answer-followup', status: 'completed' } },
          ]);
        }
      }
      if (event.type === 'response.cancel') {
        if (strict.pending && !strict.active) {
          strict.prematureCancels++;
          // The real service omitted error.code and error.event_id.
          w.__emit([{ type: 'error', error: { message: 'Cannot cancel response before response.created' } }]);
          return;
        }
        strict.cancels++;
        const id = strict.active;
        strict.active = '';
        w.__emit([{ type: 'response.done', response: { id, status: 'cancelled' } }]);
      }
    };
  });
  await clock(page);
  await emit(page, [
    { type: 'input_audio_buffer.speech_started', item_id: 'earlier-answer' },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'earlier-answer' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'earlier-answer', transcript: '我先梳理了项目目标和需求。' },
  ]);
  await expect(page.locator('.live-focus-status')).toContainText('准备追问');
  await page.clock.runFor(2200);
  await expect.poll(() => page.evaluate(() => (window as any).__strictProvider.creates)).toBe(1);
  await page.clock.runFor(50);
  await expect(page.locator('.live-focus-status')).toContainText('正在聆听');
  await emit(page, [
    { type: 'input_audio_buffer.speech_stopped', item_id: 'barge-in-answer' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'barge-in-answer', transcript: '我还想补充后续验证结果，测试用户已经完成关键操作。' },
  ]);
  await expect(page.locator('.live-focus-status')).toContainText('准备追问');
  await page.clock.runFor(3100);
}

test('半句话停滞提示，手动恢复只连接一次并保留原话、累计时长和分段录音', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 1000 });
  await controlledPeer(page);
  await emit(page, [
    { type: 'response.done', response: { id: 'opening', status: 'completed', usage: { total_tokens: 31, input_tokens: 20, output_tokens: 11 } } },
    { type: 'input_audio_buffer.speech_started', item_id: 'answer-1' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer-1', transcript: '我负责需求分析，整理项目风险并协调研发完成交付。' },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'answer-1' },
  ]);
  // Wait for the application's requested follow-up. An unsolicited provider
  // response would correctly be cancelled by the late-response protection.
  await expect.poll(() => page.evaluate(() => (window as any).__providerEvents.filter((e: any) => e.type === 'response.create').length)).toBe(2);
  await emit(page, [
    { type: 'response.created', response: { id: 'stuck-response' } },
    { type: 'response.audio_transcript.delta', item_id: 'half-question', delta: '你提到协调研发，是否' },
  ]);
  await expect(page.locator('.live-current-question')).toContainText('你提到协调研发，是否');
  await page.waitForTimeout(1200);
  await stalledStats(page);
  await clock(page);
  await page.clock.runFor(22000);
  const notice = page.locator('.live-recovery-notice');
  await expect(notice).toHaveAttribute('data-reason', 'response');
  await expect(notice).toHaveAttribute('data-health', 'warning');
  await expect(page.locator('.live-call-room')).not.toHaveClass(/is-voice-active/);
  await page.locator('.live-call-room').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.reference-analysis/live-recovery-20261114/stalled-warning.png' });
  expect(await requests(page)).toBe(1);
  const before = await draft(page);
  const button = page.getByRole('button', { name: '恢复本轮通话', exact: true });
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect.poll(() => requests(page)).toBe(2);
  await expect(page.locator('.live-recording-disclosure > summary')).toContainText('正在录制双方声音');
  await expect(page.locator('.live-recovery-notice')).toHaveCount(0);
  await page.screenshot({ path: '.reference-analysis/live-recovery-20261114/recovered.png' });
  const sent = await page.evaluate(() => (window as any).__liveRequests[1].history);
  expect(sent).toContainEqual({ role: 'user', text: '我负责需求分析，整理项目风险并协调研发完成交付。' });
  expect(JSON.stringify(sent)).not.toContain('你提到协调研发，是否');
  const resumed = await draft(page);
  expect(resumed.id).toBe(before.id);
  expect(resumed.elapsed).toBeGreaterThanOrEqual(22);
  expect(resumed.tokens).toBe(before.tokens);
  expect(resumed.messages.find((m: any) => m.text === '你提到协调研发，是否')?.final).toBe(false);
  expect((await records(page)).filter(r => r.bytes > 0)).toHaveLength(1);
  await page.clock.runFor(1000);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
  await expect.poll(async () => (await records(page)).filter(r => r.bytes > 0).length).toBe(2);
  const stored = await records(page);
  expect(new Set(stored.map(r => r.roundId)).size).toBe(1);
  expect(new Set(stored.map(r => r.id)).size).toBe(2);
  expect(await requests(page)).toBe(2);
  await page.reload();
  await expect(page.locator('.live-recording-row')).toHaveCount(2);
  expect((await draft(page)).messages.some((m: any) => m.text === '你提到协调研发，是否' && !m.final)).toBe(true);
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
});

test('后续语音一直未转写会提示并自动暂停保留录音，不自动重连或补造回答', async ({ page }) => {
  await controlledPeer(page);
  await emit(page, [
    { type: 'response.done', response: { id: 'opening', status: 'completed' } },
    { type: 'input_audio_buffer.speech_started', item_id: 'unconfirmed-answer' },
    { type: 'conversation.item.input_audio_transcription.delta', item_id: 'unconfirmed-answer', text: '我先核对了项目风险' },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'unconfirmed-answer' },
  ]);
  await page.waitForTimeout(1200);
  await stalledStats(page);
  await clock(page);
  await page.clock.runFor(17000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'transcription');
  expect(await requests(page)).toBe(1);
  await page.clock.runFor(25000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-health', 'stalled');
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await records(page)).filter(r => r.bytes > 0).length).toBe(1);
  expect(await requests(page)).toBe(1);
  const unconfirmed = (await draft(page)).messages.find((m: any) => m.text === '我先核对了项目风险');
  expect(unconfirmed.final).toBe(false);
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeEnabled();
});

test('安静思考与持续回答不会被误判为卡住', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [{ type: 'response.done', response: { id: 'opening', status: 'completed' } }]);
  await expect(page.locator('.live-focus-status')).toContainText('正在聆听你的回答');
  await clock(page);
  await page.clock.runFor(60000);
  await expect(page.locator('.live-recovery-notice')).toHaveCount(0);
  expect(await requests(page)).toBe(1);
  await emit(page, [{ type: 'input_audio_buffer.speech_started', item_id: 'long-answer' }]);
  await page.clock.runFor(90000);
  await expect(page.locator('.live-recovery-notice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toBeVisible();
  expect(await requests(page)).toBe(1);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('短暂断线立即提示，恢复连接不能把未完成回答当作已恢复', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [
    { type: 'response.created', response: { id: 'half-response' } },
    { type: 'response.audio_transcript.delta', item_id: 'half-question', delta: '具体来说，你是怎样' },
  ]);
  await clock(page);
  await page.evaluate(() => { const pc = (window as any).__recoveryPeers[0]; Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'disconnected' }); pc.onconnectionstatechange(new Event('connectionstatechange')); });
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'network');
  await page.clock.runFor(1000);
  await page.evaluate(() => { const pc = (window as any).__recoveryPeers[0]; Object.defineProperty(pc, 'connectionState', { configurable: true, value: 'connected' }); pc.onconnectionstatechange(new Event('connectionstatechange')); });
  await page.clock.runFor(22000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'response');
  expect(await requests(page)).toBe(1);
  await emit(page, [{ type: 'response.audio_transcript.delta', item_id: 'half-question', delta: '判断优先级的？' }]);
  await expect(page.locator('.live-current-question')).toContainText('判断优先级的？');
  await page.clock.runFor(600);
  await expect(page.locator('.live-recovery-notice')).toHaveCount(0);
  expect((await draft(page)).messages.find((m: any) => m.text.startsWith('具体来说，你是怎样'))?.final).toBe(false);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('免费额度核验失效时恢复不会再请求云端，文字和 AI 入口保持', async ({ page }) => {
  await controlledPeer(page);
  await emit(page, [
    { type: 'response.done', response: { id: 'opening', status: 'completed' } },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer', transcript: '我负责梳理需求和验收标准，并协调研发安排优先级。' },
  ]);
  await page.route('**/api/realtime/status', route => route.fulfill({ json: { configured: true, trial: { ready: false, message: '免费额度核验已过期，请重新核对。' } } }));
  await page.getByRole('button', { name: '通话卡住了？', exact: true }).click();
  await expect(page.locator('.live-panel > .interview-error')).toContainText('免费额度核验已过期');
  expect(await requests(page)).toBe(1);
  expect((await draft(page)).messages.some((m: any) => m.text === '我负责梳理需求和验收标准，并协调研发安排优先级。')).toBe(true);
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
  if (await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).count()) await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('某段转写缺失不会被其他段落的完成事件掩盖', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [
    { type: 'response.done', response: { id: 'opening', status: 'completed' } },
    { type: 'input_audio_buffer.speech_started', item_id: 'missing-item' },
    { type: 'conversation.item.input_audio_transcription.delta', item_id: 'missing-item', text: '这段尚未确认的回答要保留' },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'missing-item' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'earlier-item', transcript: '前一段已经完成转写。' },
  ]);
  await clock(page);
  await page.clock.runFor(17000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'transcription');
  const missing = (await draft(page)).messages.find((m: any) => m.text === '这段尚未确认的回答要保留');
  expect(missing.final).toBe(false);
  expect(await requests(page)).toBe(1);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('本机持续有声音但云端未接收语音事件时提示，静音后不继续误报', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [{ type: 'response.done', response: { id: 'opening', status: 'completed' } }]);
  await page.evaluate(() => {
    const w = window as any;
    w.__recoveryPeers[0].getStats = async () => new Map([
      ['microphone', { id: 'microphone', type: 'media-source', kind: 'audio', audioLevel: 0.1, timestamp: Date.now() }],
      ['incoming', { id: 'incoming', type: 'inbound-rtp', kind: 'audio', totalAudioEnergy: 1, totalSamplesDuration: 1, timestamp: Date.now() }],
    ]);
  });
  await clock(page);
  await page.clock.runFor(16000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'transcription');
  expect(await requests(page)).toBe(1);
  await page.getByRole('button', { name: '麦克风静音', exact: true }).click();
  await page.clock.runFor(35000);
  await expect(page.locator('.live-recovery-notice')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toBeVisible();
  expect(await requests(page)).toBe(1);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('迟到的取消完成事件不结束新问题，重复停止语音事件不多发追问', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [
    { type: 'response.created', response: { id: 'old-question' } },
    { type: 'input_audio_buffer.speech_started', item_id: 'current-answer' },
    // Match the cancelled response ID, as a real provider does. The shared
    // older fixture's generic r0 acknowledgement is intentionally ignored.
    { type: 'response.done', response: { id: 'old-question', status: 'cancelled' } },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'current-answer' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'current-answer', transcript: '我先梳理优先级，再明确分工和交付时间。' },
  ]);
  await expect(page.locator('.live-focus-status')).toContainText('准备追问');
  await clock(page);
  await page.clock.runFor(2200);
  const creates = () => page.evaluate(() => (window as any).__providerEvents.filter((e: any) => e.type === 'response.create').length);
  await expect.poll(creates).toBe(2);
  await emit(page, [
    { type: 'response.created', response: { id: 'new-question' } },
    { type: 'response.audio_transcript.delta', response_id: 'new-question', item_id: 'new-question-text', delta: '你当时怎样判断优先级？' },
    { type: 'response.done', response: { id: 'old-question', status: 'cancelled' } },
  ]);
  await expect(page.locator('.live-focus-status')).toContainText('正在提问');
  await emit(page, [{ type: 'input_audio_buffer.speech_stopped', item_id: 'current-answer' }]);
  await page.clock.runFor(3100);
  expect(await creates()).toBe(2);
  expect(await requests(page)).toBe(1);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('上一轮迟到的 created 被取消后，刚完成的回答仍能得到一次追问', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [{ type: 'response.done', response: { id: 'opening', status: 'completed' } }]);
  // Hold response.created, reproducing a slow provider while the candidate
  // resumes speaking. The local peer still acknowledges the connection.
  await page.evaluate(() => {
    const w = window as any;
    w.__channel.onmessage = (message: MessageEvent) => w.__providerEvents.push(JSON.parse(message.data));
  });
  await clock(page);
  await emit(page, [
    { type: 'input_audio_buffer.speech_started', item_id: 'answer-a' },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'answer-a' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer-a', transcript: '我先说明项目的目标。' },
  ]);
  await expect(page.locator('.live-focus-status')).toContainText('准备追问');
  await page.clock.runFor(2200);
  const creates = () => page.evaluate(() => (window as any).__providerEvents.filter((e: any) => e.type === 'response.create').length);
  await expect.poll(creates).toBe(2);
  await emit(page, [
    { type: 'input_audio_buffer.speech_started', item_id: 'answer-b' },
    { type: 'input_audio_buffer.speech_stopped', item_id: 'answer-b' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'answer-b', transcript: '再补充我的具体行动，以及最终验收的结果。' },
    { type: 'response.created', response: { id: 'late-answer-a-response' } },
    { type: 'response.done', response: { id: 'late-answer-a-response', status: 'cancelled' } },
  ]);
  await expect(page.locator('.live-focus-status')).toContainText('准备追问');
  await page.clock.runFor(2200);
  await expect.poll(creates).toBe(3);
  await page.clock.runFor(3100);
  expect(await creates()).toBe(3);
  expect(await requests(page)).toBe(1);
  expect((await draft(page)).messages.filter((m: any) => m.role === 'user' && m.final)).toHaveLength(2);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('明确转写失败立即暂停保留未完成文本和音频，提示不会被下一次健康检查清掉', async ({ page }) => {
  await controlledPeer(page);
  await stalledStats(page);
  await emit(page, [
    { type: 'response.done', response: { id: 'opening', status: 'completed' } },
    { type: 'input_audio_buffer.speech_started', item_id: 'failed-answer' },
    { type: 'conversation.item.input_audio_transcription.delta', item_id: 'failed-answer', text: '这段只收到了一部分' },
  ]);
  await page.waitForTimeout(1200);
  await clock(page);
  await emit(page, [{ type: 'conversation.item.input_audio_transcription.failed', item_id: 'failed-answer', error: { code: 'transcription_failed' } }]);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-health', 'stalled');
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toHaveCount(0);
  await page.clock.runFor(3000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'transcription');
  await expect.poll(async () => (await records(page)).filter(r => r.bytes > 0).length).toBe(1);
  expect((await draft(page)).messages.find((m: any) => m.text === '这段只收到了一部分')?.final).toBe(false);
  expect(await requests(page)).toBe(1);
});

test('取消响应时消息发送失败不会把已断开的通话误显示为仍在聆听', async ({ page }) => {
  await controlledPeer(page);
  await page.waitForTimeout(1200);
  await page.evaluate(() => {
    const channel = (window as any).__recoveryChannels[0] as RTCDataChannel;
    const send = channel.send.bind(channel);
    channel.send = (data: string) => {
      if (JSON.parse(data).type === 'response.cancel') throw new DOMException('isolated control failure', 'OperationError');
      send(data);
    };
  });
  await page.getByRole('button', { name: '打断面试官', exact: true }).click();
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '重新连接 / 继续本轮', exact: true })).toBeVisible();
  await expect(page.locator('.live-focus-status')).not.toContainText('正在聆听');
  await expect.poll(async () => (await records(page)).filter(r => r.bytes > 0).length).toBe(1);
  expect(await requests(page)).toBe(1);
});

test('create 后立即插话不会提前 cancel；等 created 后取消一次并继续追问', async ({ page }) => {
  await pendingResponseInterruptedBySpeech(page);
  const pending = await page.evaluate(() => (window as any).__strictProvider);
  expect(pending.prematureCancels).toBe(0);
  expect(pending.overlappingCreates).toBe(0);
  expect(pending.cancels).toBe(0);
  expect(pending.creates).toBe(1);
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__releasePendingResponse());
  await expect.poll(() => page.evaluate(() => (window as any).__strictProvider.cancels)).toBe(1);
  await page.clock.runFor(2500);
  await expect(page.locator('.live-current-question')).toContainText('你刚补充的验证结果，具体如何获得？');
  const complete = await page.evaluate(() => (window as any).__strictProvider);
  expect(complete).toMatchObject({ creates: 2, prematureCancels: 0, overlappingCreates: 0, cancels: 1 });
  expect(await requests(page)).toBe(1);
  expect((await draft(page)).messages.filter((m: any) => m.role === 'user' && m.final)).toHaveLength(2);
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
});

test('插话后 created 永远不到也会提示并暂停，不提前 cancel 或无限等待', async ({ page }) => {
  await pendingResponseInterruptedBySpeech(page);
  await page.clock.runFor(21000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-reason', 'response');
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-health', 'warning');
  await page.clock.runFor(25000);
  await expect(page.locator('.live-recovery-notice')).toHaveAttribute('data-health', 'stalled');
  await expect(page.getByRole('button', { name: '结束 / 暂停通话', exact: true })).toHaveCount(0);
  const state = await page.evaluate(() => (window as any).__strictProvider);
  expect(state).toMatchObject({ creates: 1, prematureCancels: 0, overlappingCreates: 0, cancels: 0 });
  expect(await requests(page)).toBe(1);
  expect((await draft(page)).messages.filter((m: any) => m.role === 'user' && m.final)).toHaveLength(2);
  await expect.poll(async () => (await records(page)).filter(r => r.bytes > 0).length).toBe(1);
});
