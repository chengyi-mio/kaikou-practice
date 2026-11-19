// Observe actual conversation progress, not merely a connected transport or RTP
// packets (which may contain silence). All times are local monotonic milliseconds.
export const LIVE_HEALTH_LIMITS = Object.freeze({
  responseWarning: 20000, responsePause: 45000,
  transcriptionWarning: 15000, transcriptionPause: 40000,
  unacknowledgedWarning: 12000, unacknowledgedPause: 30000,
});

export class LiveHealthMonitor {
  constructor() {
    this.responseAt = null;
    this.cloudSpeaking = false;
    this.speechId = '';
    this.pendingTranscripts = new Map();
    this.failedTranscripts = new Set();
    this.completedTranscripts = new Set();
    this.samples = new Map();
    this.localUnacknowledgedAt = null;
    this.localUnacknowledgedDuration = 0;
    this.lastLocalVoice = null;
    this.cloudTurnHadLocalVoice = false;
  }
  responseRequested(now) { this.responseAt = now; }
  responseProgress(now) { if (this.responseAt !== null) this.responseAt = now; }
  responseEnded() { this.responseAt = null; }
  speechStarted(id, now) {
    this.cloudSpeaking = true;
    this.speechId = id || 'current-turn';
    this.cloudTurnHadLocalVoice = false;
    this.localUnacknowledgedAt = null;
    this.localUnacknowledgedDuration = 0;
    this.responseEnded();
  }
  speechStopped(id, now) {
    this.cloudSpeaking = false;
    const key = id || this.speechId || 'current-turn';
    if (!this.completedTranscripts.has(key)) this.pendingTranscripts.set(key, now);
    this.localUnacknowledgedAt = null;
    this.localUnacknowledgedDuration = 0;
  }
  transcriptionCompleted(id) {
    const key = id || this.speechId || 'current-turn';
    this.pendingTranscripts.delete(key);
    this.failedTranscripts.delete(key);
    this.completedTranscripts.add(key);
  }
  transcriptionProgress(id, now) {
    const key = id || this.speechId || 'current-turn';
    if (this.pendingTranscripts.has(key)) this.pendingTranscripts.set(key, now);
  }
  transcriptionFailed(id, now) {
    const key = id || this.speechId || 'current-turn';
    this.pendingTranscripts.set(key, now);
    this.failedTranscripts.add(key);
  }
  microphoneMuted() {
    this.localUnacknowledgedAt = null;
    this.localUnacknowledgedDuration = 0;
  }
  // getStats media-source/inbound-rtp cumulative energy is preferred to a
  // one-instant audioLevel. The first cumulative sample is just a baseline.
  observeStats(report, now, microphoneEnabled) {
    if (!microphoneEnabled) this.microphoneMuted();
    report.forEach(stat => {
      if (!['media-source', 'inbound-rtp'].includes(stat.type) || (stat.kind || stat.mediaType) !== 'audio') return;
      const local = stat.type === 'media-source';
      const previous = this.samples.get(stat.id);
      this.samples.set(stat.id, { energy: stat.totalAudioEnergy, duration: stat.totalSamplesDuration, at: now });
      if (local && !microphoneEnabled) return;
      let power = 0, duration = previous ? Math.min(2, Math.max(0, (now - previous.at) / 1000)) : 0;
      if (Number.isFinite(stat.totalAudioEnergy) && Number.isFinite(stat.totalSamplesDuration)) {
        if (!previous || !Number.isFinite(previous.energy) || !Number.isFinite(previous.duration)) return;
        const sampled = stat.totalSamplesDuration - previous.duration;
        if (sampled <= 0) return;
        power = Math.max(0, stat.totalAudioEnergy - previous.energy) / sampled;
      } else if (Number.isFinite(stat.audioLevel)) power = stat.audioLevel ** 2;
      // Require several seconds of local audible input, never plain silence.
      if (local && power >= 0.000225) {
        if (this.lastLocalVoice !== null && now - this.lastLocalVoice > 3000 && this.localUnacknowledgedDuration < 2.5) this.microphoneMuted();
        this.lastLocalVoice = now;
        if (this.cloudSpeaking) this.cloudTurnHadLocalVoice = true;
        else {
          if (this.localUnacknowledgedAt === null) this.localUnacknowledgedAt = now;
          this.localUnacknowledgedDuration += duration;
        }
      } else if (!local && power >= 0.000004) this.responseProgress(now);
    });
  }
  check(now, silence = 2000) {
    const issues = [];
    const add = (kind, since, warning, pause, message) => {
      if (since !== null && now - since >= warning) issues.push({ kind, level: now - since >= pause ? 'stalled' : 'warning', message, recoverable: true, pause: now - since >= pause, since });
    };
    add('response', this.responseAt, LIVE_HEALTH_LIMITS.responseWarning, LIVE_HEALTH_LIMITS.responsePause,
      '面试官较长时间没有继续说话，可能已卡住。可以保留本轮记录并重新连接。');
    const pending = [...this.pendingTranscripts.values()];
    // A missing speech_stopped event must not leave a finished answer looking
    // like a forever-long answer. Only infer quiet after measured local speech.
    if (this.cloudSpeaking && this.cloudTurnHadLocalVoice && this.lastLocalVoice !== null && !this.completedTranscripts.has(this.speechId)) pending.push(this.lastLocalVoice + silence);
    if (pending.length) add('transcription', Math.min(...pending), LIVE_HEALTH_LIMITS.transcriptionWarning, LIVE_HEALTH_LIMITS.transcriptionPause,
      '刚才的回答还没有完整转成文字。已录制的声音保留在本机，可重新连接后继续，结束后再核对文字。');
    if (this.failedTranscripts.size) issues.push({kind:'transcription',level:'stalled',recoverable:true,pause:true,since:Math.min(...pending),message:'这段语音转写失败。录音和已收到的文字仍保留，可以重新连接后继续，结束后核对缺失文字。'});
    if (this.localUnacknowledgedDuration >= 2.5) add('transcription', this.localUnacknowledgedAt, LIVE_HEALTH_LIMITS.unacknowledgedWarning, LIVE_HEALTH_LIMITS.unacknowledgedPause,
      '检测到麦克风声音，但服务端还没有确认收到这段回答。请先暂停说话，可保留录音并重新连接。');
    issues.sort((a, b) => Number(b.pause) - Number(a.pause) || a.since - b.since);
    if (!issues.length) return null;
    const { since, ...issue } = issues[0];
    return issue;
  }
}
