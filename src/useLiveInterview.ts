import { useEffect, useRef, useState } from "react";
import { usageEntry } from "./liveUsage.mjs";
import type { UsageEntry } from "./liveUsage.mjs";
import { createCallRecorder } from './liveRecording';
import type { CallRecorder, RecordingState } from './liveRecording';
import { restoreRecording } from './liveRecordingStore';
import { LiveHealthMonitor } from './liveHealth.mjs';
import type { LiveHealth } from './liveHealth.mjs';
export type LiveState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "ended"
  | "error";
export type StartInput = {
  roundId: string;
  resume: string;
  job: string;
  role: string;
  stage?: string;
  project?: string;
  history: { role: string; text: string }[];
  minutes: number;
  silence: number;
  remaining: number;
};
type Resources = {
  pc: RTCPeerConnection;
  stream?: MediaStream;
  audio: HTMLAudioElement;
  channels: RTCDataChannel[];
  control?: RTCDataChannel;
  abort: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  lost?: ReturnType<typeof setTimeout>;
  answerWait?: ReturnType<typeof setTimeout>;
  tick?: ReturnType<typeof setInterval>;
  started?: number;
  responding: boolean;
  responseRequested: boolean;
  cancelOnCreate: boolean;
  cancellingResponse?: string;
  userSpeaking: boolean;
  replyNeeded: boolean;
  replyAt: number;
  responseId?: string;
  cancelled: Set<string>;
  cancelledResponses: Set<string>;
  monitor: LiveHealthMonitor;
  statsAt: number;
  statsPending: boolean;
  capture?: CallRecorder;
};

export function useLiveInterview(callbacks: {
  event: (event: Record<string, unknown>) => void;
  elapsed: (seconds: number) => void;
  usage: (usage: UsageEntry) => void;
}) {
  const cb = useRef(callbacks);
  cb.current = callbacks;
  const resource = useRef<Resources | null>(null);
  const generation = useRef(0);
  const [state, setState] = useState<LiveState>("idle");
  const [error, setError] = useState("");
  const [health, setHealth] = useState<LiveHealth | null>(null);
  const healthRef = useRef<LiveHealth | null>(null);
  const [muted, setMuted] = useState(false);
  const [playbackVolume, setPlaybackVolume] = useState(1);
  const playbackVolumeRef = useRef(1);
  const [seconds, setSeconds] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [recording, setRecording] = useState<RecordingState>({ phase: 'idle' });
  const recordingRef = useRef<RecordingState>({ phase: 'idle' });
  const saving = useRef<Promise<void> | null>(null);
  const recordingFinalizeFailed = useRef(false);
  const recovering = useRef(false);
  const recordingOwner = useRef(0);
  const mounted = useRef(true);
  function updateRecording(value: RecordingState) {
    recordingRef.current = value;
    if (mounted.current) setRecording(value);
  }
  function updateHealth(value: LiveHealth | null) {
    if (healthRef.current?.kind === value?.kind && healthRef.current?.level === value?.level && healthRef.current?.message === value?.message) return;
    healthRef.current = value;
    if (mounted.current) setHealth(value);
  }
  function dispose(interrupted = true) {
    generation.current++;
    const r = resource.current;
    resource.current = null;
    if (!r) return;
    if (r.capture) {
      const task = r.capture.finish(interrupted);
      saving.current = task;
      void task.catch(() => {
        recordingFinalizeFailed.current = true;
        updateRecording({phase:'error',message:'录音收尾异常，已写入的片段保留在本机，请查看通话录音。'});
      }).finally(() => { if (saving.current === task) saving.current = null; });
    }
    r.abort.abort();
    clearTimeout(r.timeout);
    clearTimeout(r.lost);
    clearTimeout(r.answerWait);
    clearInterval(r.tick);
    r.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    r.pc.onconnectionstatechange = null;
    r.pc.ondatachannel = null;
    r.pc.ontrack = null;
    r.channels.forEach((c) => {
      c.onmessage = null;
      c.onclose = null;
      c.onerror = null;
      c.close();
    });
    r.pc.close();
    r.audio.pause();
    r.audio.srcObject = null;
  }
  function stop(message = "", failed = false) {
    const r = resource.current;
    const used = r?.started ? Math.ceil((Date.now() - r.started) / 1000) : 0;
    if (r?.started) cb.current.elapsed(used);
    dispose(failed);
    setState(failed ? "error" : "ended");
    setError(message);
    setMuted(false);
    return used;
  }
  useEffect(() => { mounted.current = true; return () => { dispose(); mounted.current = false; }; }, []);
  function send(value: Record<string, unknown>) {
    const r = resource.current;
    const channel =
      r?.control?.readyState === "open"
        ? r.control
        : r?.channels.find((c) => c.readyState === "open");
    if (!channel) return "";
    const id = crypto.randomUUID();
    try {
      const data = JSON.stringify({ ...value, event_id: id });
      const limit = r?.pc.sctp?.maxMessageSize;
      if (limit && new TextEncoder().encode(data).length > limit)
        throw Error("message too large");
      channel.send(data);
    } catch {
      stop("资料或历史对话超出实时通道容量，请精简资料或开始新一轮。", true);
      return "";
    }
    return id;
  }
  function interrupt() {
    const r = resource.current;
    if (!r) return;
    clearTimeout(r.answerWait);
    r.replyNeeded = false;
    // Mute buffered remote sound immediately; a fresh response will unmute it.
    r.audio.muted = true;
    r.capture?.remoteMuted(true);
    if (r.responding) {
      const id = send({ type: "response.cancel" });
      if (resource.current !== r) return;
      if (id) r.cancelled.add(id);
      if (r.responseId) r.cancelledResponses.add(r.responseId);
      if (id) r.cancellingResponse = r.responseId || '__unidentified_response__';
      r.responding = false;
      r.responseId = undefined;
    } else if (r.responseRequested) {
      // Qwen rejects response.cancel before response.created. Keep this request
      // in flight and cancel only once the server supplies its response ID.
      r.cancelOnCreate = true;
    }
    if (!r.userSpeaking && (r.responseRequested || r.cancellingResponse)) r.monitor.responseRequested(performance.now());
    else r.monitor.responseEnded();
    setState("listening");
  }
  function mute() {
    const r = resource.current;
    if (!r?.stream) return;
    const next = !muted;
    r.stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    if (next) r.monitor.microphoneMuted();
    setMuted(next);
  }
  function setVolume(value: number) {
    if (!Number.isFinite(value)) return;
    const next = Math.max(0, Math.min(1, value));
    playbackVolumeRef.current = next;
    setPlaybackVolume(next);
    // This is speaker playback only; the independently mixed call recording
    // continues to capture both sides, even when playback volume is zero.
    if (resource.current) resource.current.audio.volume = next;
  }
  async function playAudio() {
    try {
      await resource.current?.audio.play();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  }
  async function start(input: StartInput, fromRecovery = false) {
    if (recovering.current && !fromRecovery) return;
    if (resource.current) return;
    if (saving.current || recordingRef.current.unsaved || recordingRef.current.phase === 'saving') { setError('请等待录音保存完成，或先处理未保存的录音。'); return; }
    if (!Number.isFinite(input.remaining) || input.remaining <= 0) { setError('本轮时长已用完，请生成复盘或开始新一轮。'); return; }
    updateRecording({phase:'idle'});
    recordingFinalizeFailed.current = false;
    updateHealth(null);
    setError("");
    setSeconds(0);
    setMuted(false);
    setAudioBlocked(false);
    setState("connecting");
    const attempt = ++generation.current;
    recordingOwner.current = attempt;
    const prefix = crypto.randomUUID();
    let r: Resources;
    try {
      const pc = new RTCPeerConnection({ iceServers: [] });
      r = {
        pc,
        audio: new Audio(),
        channels: [],
        abort: new AbortController(),
        responding: false,
        responseRequested: false,
        cancelOnCreate: false,
        userSpeaking: false,
        replyNeeded: false,
        replyAt: 0,
        cancelled: new Set(),
        cancelledResponses: new Set(),
        monitor: new LiveHealthMonitor(),
        statsAt: 0,
        statsPending: false,
      };
      resource.current = r;
      r.audio.volume = playbackVolumeRef.current;
      const current = () =>
        generation.current === attempt && resource.current === r;
      r.timeout = setTimeout(() => {
        if (current())
          stop("连接超时，请检查实时配置和网络。文字草稿已保留。", true);
      }, 40000);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (!current()) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      r.stream = stream;
      const capture = await createCallRecorder({
        roundId: input.roundId, role: input.role, microphone: stream,
        state: value => { if (recordingOwner.current === attempt) updateRecording(value); },
        fatal: () => { if (current()) stop('录音设备发生错误，通话已结束。请查看已保留的录音。', true); },
      });
      if (!current()) { await capture.finish(true); return; }
      r.capture = capture;
      stream.getAudioTracks().forEach((t) => {
        t.enabled = false;
        t.onended = () => {
          if (current()) stop("麦克风已断开，请检查设备后重新连接。", true);
        };
        pc.addTrack(t, stream);
      });
      const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
      const audioTrack = stream.getAudioTracks()[0];
      // Disabling a track still sends silence. Keep media detached until the
      // provider acknowledges the session so VAD can be configured safely.
      await audioSender?.replaceTrack(null);
      if (!current()) return;
      pc.ontrack = (event) => {
        if (!current()) return;
        const remote = event.streams[0] || new MediaStream([event.track]);
        r.audio.srcObject = remote;
        if (event.track.kind === 'audio') r.capture?.remote(remote);
        void playAudio();
      };
      pc.onconnectionstatechange = () => {
        if (!current()) return;
        if (pc.connectionState === "failed" || pc.connectionState === "closed") {
          updateHealth({kind:'network',level:'stalled',recoverable:true,message:'实时连接已断开。文字与已录制的声音会保留，可重新连接继续本轮。'});
          stop(
            "实时连接已断开。已收到的文字保留，未完成的转写需重新回答或补充。",
            true,
          );
        }
        else if (pc.connectionState === "disconnected") {
          updateHealth({kind:'network',level:'warning',recoverable:true,message:'连接暂时中断，请先暂停说话，正在等待恢复。若未恢复，可保留录音并重新连接。'});
          clearTimeout(r.lost);
          r.lost = setTimeout(() => {
            if (current()) {
              updateHealth({kind:'network',level:'stalled',recoverable:true,message:'连接持续中断，已结束本段并保存录音。重新连接后可继续本轮。'});
              stop("网络中断，请检查后点击重新连接。", true);
            }
          }, 5000);
        } else if (pc.connectionState === "connected") {
          clearTimeout(r.lost);
          // A recovered ICE transport does not prove the conversation recovered.
          if (healthRef.current?.kind === 'network') updateHealth(null);
          checkHealth();
        }
      };
      let session: Record<string, unknown> | undefined;
      let model = "";
      let timeLimit = Math.min(input.remaining, 600);
      let configured = false,
        ready = false;
      const seen = new Set<string>();
      const completedResponses = new Set<string>();
      const stoppedSpeechItems = new Set<string>();
      function requestResponse(instructions?: string) {
        if (!current() || r.userSpeaking || r.responding || r.responseRequested || r.cancellingResponse) return;
        const id = send({type:'response.create', ...(instructions ? {response:{instructions}} : {})});
        if (!id || !current()) return;
        r.responseRequested = true;
        r.replyNeeded = false;
        r.monitor.responseRequested(performance.now());
      }
      function scheduleReply() {
        if (!current() || r.userSpeaking || !r.replyNeeded) return;
        clearTimeout(r.answerWait);
        r.answerWait = setTimeout(() => requestResponse(), Math.max(0, r.replyAt - performance.now()));
      }
      function checkHealth() {
        if (!current() || !r.started) return;
        const now = performance.now();
        const issue = r.monitor.check(now, input.silence);
        if (healthRef.current?.kind !== 'network') updateHealth(issue);
        if (issue?.pause) {
          updateHealth(issue);
          stop(`${issue.message} 为避免继续空等，本段通话已暂停，录音正在保存；不会自动发起新请求。`, true);
          return;
        }
        if (!r.statsPending && now - r.statsAt >= 1000 && typeof pc.getStats === 'function') {
          r.statsPending = true;
          r.statsAt = now;
          void pc.getStats().then(report => {
            if (current()) r.monitor.observeStats(report, performance.now(), !!r.stream?.getAudioTracks().some(track => track.enabled));
          }).catch(() => { /* Progress events still work if stats are unavailable. */ }).finally(() => { r.statsPending = false; });
        }
      }
      function receive(raw: string, channel: RTCDataChannel) {
        if (!current()) return;
        let e;
        try {
          e = JSON.parse(raw);
        } catch {
          return;
        }
        if (!e || typeof e !== "object") return;
        if (e.event_id) {
          if (seen.has(e.event_id)) return;
          seen.add(e.event_id);
          if (seen.size > 2000) seen.delete(seen.values().next().value!);
        }
        if (e.type === "session.created" && session && !configured) {
          r.control = channel;
          configured = true;
          send({ type: "session.update", session });
        }
        if (!current()) return;
        if (e.type === "session.updated" && configured && !ready) {
          ready = true;
          void audioSender?.replaceTrack(audioTrack).then(() => {
            if (!current()) return;
            clearTimeout(r.timeout);
            r.capture?.start();
            r.started = Date.now();
            stream.getAudioTracks().forEach((t) => { t.enabled = true; });
            setState("listening");
            requestResponse(`${String(session?.instructions || "")}\n现在开始或继续本轮面试，只问一个简短问题，等待候选人回答。${fromRecovery ? '刚才的连接可能中断：不要假定未收到的回答已经完成，也不要编造缺失内容；结合已确认的历史重述待完成的问题，让候选人继续回答。' : ''}`);
            if (!current()) return;
            r.tick = setInterval(() => {
              if (!current()) return;
              const used = Math.ceil((Date.now() - r.started!) / 1000);
              setSeconds(used);
              if (used >= timeLimit) {
                stop("本轮已达到设定时长，通话已结束。可以核对文字并生成 AI 复盘。");
                return;
              }
              checkHealth();
            }, 500);
          }).catch(() => { if (current()) stop("麦克风音轨未能接入，请重新连接。", true); });
        }
        if (e.type === "input_audio_buffer.speech_started") {
          r.userSpeaking = true;
          r.replyNeeded = false;
          r.monitor.speechStarted(e.item_id, performance.now());
          interrupt();
        }
        if (e.type === "input_audio_buffer.speech_stopped") {
          // Provider retries may use a new event_id for the same stopped turn.
          // They must not postpone transcription deadlines or queue two replies.
          if (e.item_id && stoppedSpeechItems.has(e.item_id)) return;
          if (e.item_id) stoppedSpeechItems.add(e.item_id);
          r.userSpeaking = false;
          r.replyNeeded = true;
          r.replyAt = performance.now() + input.silence;
          r.monitor.speechStopped(e.item_id, performance.now());
          r.monitor.responseRequested(performance.now());
          if (!r.responding) setState("thinking");
          scheduleReply();
        }
        if (e.type === 'conversation.item.input_audio_transcription.completed') r.monitor.transcriptionCompleted(e.item_id);
        if (e.type === 'conversation.item.input_audio_transcription.delta') r.monitor.transcriptionProgress(e.item_id, performance.now());
        if (e.type === "response.created") {
          const responseId = e.response?.id;
          if (responseId && (r.cancelledResponses.has(responseId) || completedResponses.has(responseId) || (r.responding && r.responseId === responseId))) return;
          clearTimeout(r.answerWait);
          const unexpected = !r.responseRequested && !r.responding;
          const cancelOnCreate = r.cancelOnCreate;
          r.responseRequested = false;
          r.cancelOnCreate = false;
          r.responding = true;
          r.responseId = e.response?.id;
          if (r.userSpeaking || unexpected || cancelOnCreate) {
            // A late create from the preceding turn must not speak over the
            // answer that already interrupted it.
            const resumeAnswer = !r.userSpeaking && r.replyNeeded;
            interrupt();
            if (!current()) return;
            // Cancelling a delayed response from the previous turn must not
            // cancel the follow-up now owed to a newly completed answer.
            if (resumeAnswer) {
              r.replyNeeded = true;
              r.monitor.responseRequested(performance.now());
              scheduleReply();
              setState('thinking');
            }
          } else {
            r.monitor.responseRequested(performance.now());
            r.audio.muted = false;
            r.capture?.remoteMuted(false);
            setState("speaking");
          }
        }
        if (/^response\.(audio_transcript|text)\.(delta|done)$/.test(e.type || '') &&
          (!e.response_id || !r.cancelledResponses.has(e.response_id)) &&
          (!r.responseId || !e.response_id || r.responseId === e.response_id)) r.monitor.responseProgress(performance.now());
        if (e.type === "response.done") {
          const cancelledResponseCompleted = r.cancellingResponse && (r.cancellingResponse === e.response?.id || r.cancellingResponse === '__unidentified_response__');
          if (cancelledResponseCompleted) r.cancellingResponse = undefined;
          const currentResponse = r.responding && (!r.responseId || r.responseId === e.response?.id) && !r.cancelledResponses.has(e.response?.id);
          if (currentResponse) {
            r.responding = false;
            r.responseId = undefined;
            r.responseRequested = false;
            r.monitor.responseEnded();
            setState("listening");
          }
          const id = e.response?.id;
          if (id && !completedResponses.has(id)) {
            completedResponses.add(id);
            const entry = usageEntry(e.response, { connection: prefix, model });
            if (entry) cb.current.usage(entry);
          }
          if (e.response?.status === "failed" && currentResponse) {
            stop("模型未能完成回答，请检查额度或服务状态后重连。", true);
            return;
          }
          if (cancelledResponseCompleted) {
            if (r.replyNeeded && !r.userSpeaking) scheduleReply();
            else if (!r.responseRequested && !r.responding) r.monitor.responseEnded();
          }
        }
        if (e.type === "error") {
          // Cancelling after the server has completed is a harmless race.
          if (
            r.cancelled.has(e.error?.event_id) &&
            /cancel|active_response/i.test(e.error?.code || "")
          )
            return;
          stop(
            e.error?.code === "AllocationQuota.FreeTierOnly"
              ? "免费额度已用尽，实时通话已停止，不会切换到付费模式。已收到的文字仍保留。"
              : "实时模型返回错误，请检查模型权限、额度或会话参数后重连。已收到的文字仍保留。",
            true,
          );
          return;
        }
        if (e.type === "conversation.item.input_audio_transcription.failed") {
          r.monitor.transcriptionFailed(e.item_id, performance.now());
          updateHealth({kind:'transcription',level:'stalled',recoverable:true,message:'这段语音转写失败。录音和已收到的文字仍保留，可以重新连接后继续，结束后核对缺失文字。'});
          stop('这一段语音转写失败，本段通话已暂停并保存录音。请重新连接后继续；结束后核对或补充缺失文字，避免漏评。', true);
        }
        if (e.item_id) e.item_id = prefix + ":" + e.item_id;
        if (e.previous_item_id)
          e.previous_item_id = prefix + ":" + e.previous_item_id;
        if (e.item?.id) e.item = { ...e.item, id: prefix + ":" + e.item.id };
        if (Array.isArray(e.response?.output)) e.response = { ...e.response, output: e.response.output.map((item: { id?: string }) => ({ ...item, id: item.id ? prefix + ":" + item.id : undefined })) };
        cb.current.event(e);
      }
      const bind = (channel: RTCDataChannel) => {
        r.channels.push(channel);
        channel.onmessage = (e) => receive(e.data, channel);
        channel.onerror = () => {
          if (current()) {
            updateHealth({kind:'channel',level:'stalled',recoverable:true,message:'实时消息通道异常，文字和录音会保留。请重新连接继续本轮。'});
            stop("实时消息通道异常，请重新连接。", true);
          }
        };
        channel.onclose = () => {
          if (current()) {
            updateHealth({kind:'channel',level:'stalled',recoverable:true,message:'实时消息通道已关闭，文字和录音会保留。请重新连接继续本轮。'});
            stop("实时消息通道已关闭，请重新连接。", true);
          }
        };
      };
      bind(pc.createDataChannel("oai-events"));
      pc.ondatachannel = (e) => bind(e.channel);
      await pc.setLocalDescription(await pc.createOffer());
      if (!current()) return;
      const response = await fetch("/api/realtime/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          roundId: undefined,
          remaining: undefined,
          sdp: pc.localDescription?.sdp,
        }),
        signal: r.abort.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!current()) return;
      if (!response.ok) throw Error(data.error || "实时服务连接失败。");
      if (typeof data.sdp !== "string" || !data.session)
        throw Error("实时服务返回的连接信息无效。");
      session = data.session;
      model = typeof data.model === "string" ? data.model : "未回报模型名称";
      if (Number.isFinite(data.maxSeconds) && data.maxSeconds > 0)
        timeLimit = Math.min(timeLimit, data.maxSeconds);
      await pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
    } catch (e) {
      if (generation.current !== attempt) return;
      const denied = e instanceof DOMException && e.name === "NotAllowedError";
      stop(
        denied
          ? "麦克风权限未开启，请允许应用使用麦克风后重试。"
          : e instanceof Error
            ? e.message
            : "连接失败，请检查配置后重试。",
        true,
      );
    }
  }
  return {
    state,
    error,
    health,
    muted,
    playbackVolume,
    setVolume,
    seconds,
    audioBlocked,
    start,
    async recover(input: StartInput) {
      if (recovering.current) return;
      recovering.current = true;
      try {
        const used = resource.current ? stop('正在保存本段录音，保存完成后重新连接。', true) : 0;
        const resumeGeneration = generation.current;
        if (saving.current) {
          const pendingSave = saving.current;
          try { await pendingSave; }
          catch { setError('录音尚未安全保存，请先处理本段录音，再重新连接。'); return; }
          finally { if (saving.current === pendingSave) saving.current = null; }
        }
        if (!mounted.current || generation.current !== resumeGeneration) return;
        if (recordingRef.current.unsaved || recordingRef.current.phase === 'saving' || recordingFinalizeFailed.current) {
          setError('录音尚未安全保存，请先下载或重试保存本段录音，再重新连接。');
          return;
        }
        // input.remaining excludes the currently running connection. The
        // elapsed callback persists used; do not reset the 10-minute budget.
        await start({...input, remaining: Math.max(0, input.remaining - used)}, true);
      } finally { recovering.current = false; }
    },
    stop,
    interrupt,
    mute,
    playAudio,
    recording,
    async retryRecordingSave() {
      const temporary = recordingRef.current.unsaved;
      if (!temporary || saving.current) return;
      updateRecording({ ...recordingRef.current, phase: 'saving' });
      const task = restoreRecording(temporary.record, temporary.chunks);
      saving.current = task;
      try { await task; updateRecording({phase:'saved',id:temporary.record.id}); }
      catch { updateRecording({ ...recordingRef.current, phase: 'error' }); }
      finally { if (saving.current === task) saving.current = null; }
    },
    discardTemporaryRecording() { if (!saving.current) updateRecording({phase:'idle'}); },
  };
}
