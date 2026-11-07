import { appendRecordingChunk, deleteRecording, restoreRecording, saveRecordingMetadata } from './liveRecordingStore';
import type { LiveRecording } from './liveRecordingStore';
export type UnsavedRecording = { record: LiveRecording; chunks: Blob[] };
export type RecordingState = { phase: 'idle' | 'recording' | 'saving' | 'saved' | 'error'; id?: string; message?: string; unsaved?: UnsavedRecording };
export type CallRecorder = { start: () => void; remote: (stream: MediaStream) => void; remoteMuted: (muted: boolean) => void; finish: (interrupted: boolean) => Promise<void> };

export async function createCallRecorder(input: { roundId: string; role: string; microphone: MediaStream; state: (state: RecordingState) => void; fatal: () => void }): Promise<CallRecorder> {
  if (typeof MediaRecorder === 'undefined') throw Error('当前环境不支持通话录音，请使用新版桌面应用。');
  const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw Error('当前环境没有可用的录音格式，暂未开始通话。');
  const context = new AudioContext();
  let record: LiveRecording = { id: crypto.randomUUID(), roundId: input.roundId, role: input.role, createdAt: new Date().toISOString(), mimeType, duration: 0, bytes: 0, status: 'recording' };
  try {
    await context.resume();
    if (context.state !== 'running') throw Error('声音录制未能启动，请重新点击开始。');
    await saveRecordingMetadata(record);
  } catch (error) { await context.close(); throw error; }
  const output = context.createMediaStreamDestination();
  const mic = context.createMediaStreamSource(input.microphone), micGain = context.createGain(), remoteGain = context.createGain();
  // Headroom for overlapping speech. No connection to speakers: playback remains in the existing audio element.
  micGain.gain.value = remoteGain.gain.value = 0.65;
  mic.connect(micGain).connect(output); remoteGain.connect(output);
  let remote: MediaStreamAudioSourceNode | undefined;
  let recorder: MediaRecorder;
  try { recorder = new MediaRecorder(output.stream, { mimeType, audioBitsPerSecond: 96000 }); }
  catch { mic.disconnect(); await context.close(); await deleteRecording(record.id); throw Error('通话录音未能初始化，请重试。'); }
  const chunks: Blob[] = [];
  let started = 0, queue = Promise.resolve(), writeFailed = false, recorderFailed = false;
  let finished: Promise<void> | undefined;
  let stopped!: () => void;
  const stoppedEvent = new Promise<void>(resolve => { stopped = resolve; });
  const duration = () => started ? Math.max(0, (performance.now() - started) / 1000) : 0;
  recorder.ondataavailable = e => {
    if (!e.data.size) return;
    const index = chunks.length; chunks.push(e.data);
    record = { ...record, duration: duration(), bytes: record.bytes + e.data.size };
    const snapshot = record;
    queue = queue.then(async () => {
      // A missing middle chunk must never look like a complete recording.
      if (writeFailed) return;
      try { await appendRecordingChunk(snapshot, index, e.data); }
      catch { writeFailed = true; input.state({ phase: 'recording', id: record.id, message: '本机写入失败，录音暂存在当前页面。请结束通话后下载或重试保存。' }); }
    });
  };
  recorder.onstop = () => stopped();
  recorder.onerror = () => { recorderFailed = true; input.fatal(); };
  return {
    start() {
      if (started || finished) return;
      started = performance.now(); record = { ...record, createdAt: new Date().toISOString() };
      recorder.start(1000);
      input.state({ phase: 'recording', id: record.id });
    },
    remote(stream) {
      remote?.disconnect(); remote = context.createMediaStreamSource(stream); remote.connect(remoteGain);
    },
    remoteMuted(muted) { remoteGain.gain.value = muted ? 0 : 0.65; },
    finish(interrupted) {
      if (finished) return finished;
      finished = (async () => {
        if (started) {
          input.state({ phase: 'saving', id: record.id });
          if (recorder.state !== 'inactive') recorder.stop();
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([stoppedEvent, new Promise<void>(resolve => { timer = setTimeout(() => { recorderFailed = true; resolve(); }, 5000); })]);
          clearTimeout(timer);
        }
        await queue;
        mic.disconnect(); remote?.disconnect(); micGain.disconnect(); remoteGain.disconnect();
        output.stream.getTracks().forEach(track => track.stop()); await context.close().catch(() => {});
        if (!chunks.length) {
          await deleteRecording(record.id).catch(() => {});
          input.state(started ? { phase: 'error', message: '本次通话太短或未产生有效录音，没有保存空文件。' } : { phase: 'idle' });
          return;
        }
        record = { ...record, status: interrupted || recorderFailed ? 'interrupted' : 'saved' };
        try {
          if (writeFailed) await restoreRecording(record, chunks);
          else await saveRecordingMetadata(record);
          input.state({ phase: 'saved', id: record.id });
        } catch {
          input.state({ phase: 'error', id: record.id, message: '录音尚未完整保存，请保留此页面，下载临时副本或重试保存。', unsaved: { record, chunks } });
        }
        window.dispatchEvent(new Event('kaikou-live-recordings-changed'));
      })();
      return finished;
    },
  };
}
