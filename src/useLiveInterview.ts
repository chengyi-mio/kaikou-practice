import { useEffect, useRef, useState } from "react";
import { usageEntry } from "./liveUsage.mjs";
import type { UsageEntry } from "./liveUsage.mjs";
import { createCallRecorder } from './liveRecording';
import type { CallRecorder, RecordingState } from './liveRecording';
import { restoreRecording } from './liveRecordingStore';
export type LiveState =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking"
  | "ended"
  | "error";
type StartInput = {
  roundId: string;
  resume: string;
  job: string;
  role: string;
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
  responseId?: string;
  cancelled: Set<string>;
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
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [recording, setRecording] = useState<RecordingState>({ phase: 'idle' });
  const saving = useRef<Promise<void> | null>(null);
  const recordingOwner = useRef(0);
  const mounted = useRef(true);
  function dispose(interrupted = true) {
    generation.current++;
    const r = resource.current;
    resource.current = null;
    if (!r) return;
    if (r.capture) {
      const task = r.capture.finish(interrupted);
      saving.current = task;
      void task.catch(() => {
        if (mounted.current) setRecording({phase:'error',message:'录音收尾异常，已写入的片段保留在本机，请查看通话录音。'});
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
    if (r?.started)
      cb.current.elapsed(Math.ceil((Date.now() - r.started) / 1000));
    dispose(failed);
    setState(failed ? "error" : "ended");
    setError(message);
    setMuted(false);
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
    // Mute buffered remote sound immediately; a fresh response will unmute it.
    r.audio.muted = true;
    r.capture?.remoteMuted(true);
    if (r.responding) {
      const id = send({ type: "response.cancel" });
      if (id) r.cancelled.add(id);
      r.responding = false;
    }
    setState("listening");
  }
  function mute() {
    const r = resource.current;
    if (!r?.stream) return;
    const next = !muted;
    r.stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
  }
  async function playAudio() {
    try {
      await resource.current?.audio.play();
      setAudioBlocked(false);
    } catch {
      setAudioBlocked(true);
    }
  }
  async function start(input: StartInput) {
    if (resource.current) return;
    if (saving.current || recording.unsaved) { setError('请等待录音保存完成，或先处理未保存的录音。'); return; }
    setRecording({phase:'idle'});
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
        cancelled: new Set(),
      };
      resource.current = r;
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
        state: value => { if (mounted.current && recordingOwner.current === attempt) setRecording(value); },
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
        if (pc.connectionState === "failed" || pc.connectionState === "closed")
          stop(
            "实时连接已断开。已收到的文字保留，未完成的转写需重新回答或补充。",
            true,
          );
        else if (pc.connectionState === "disconnected") {
          clearTimeout(r.lost);
          r.lost = setTimeout(() => {
            if (current()) stop("网络中断，请检查后点击重新连接。", true);
          }, 5000);
        } else if (pc.connectionState === "connected") clearTimeout(r.lost);
      };
      let session: Record<string, unknown> | undefined;
      let model = "";
      let timeLimit = Math.min(input.remaining, 600);
      let configured = false,
        ready = false;
      const seen = new Set<string>();
      const completedResponses = new Set<string>();
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
            send({ type: "response.create", response: { instructions: `${String(session?.instructions || "")}\n现在开始或继续本轮面试，只问一个简短问题，等待候选人回答。` } });
            if (!current()) return;
            r.tick = setInterval(() => {
              if (!current()) return;
              const used = Math.ceil((Date.now() - r.started!) / 1000);
              setSeconds(used);
              if (used >= timeLimit) stop("本轮已达到设定时长，通话已结束。可以核对文字并生成 AI 复盘。");
            }, 500);
          }).catch(() => { if (current()) stop("麦克风音轨未能接入，请重新连接。", true); });
        }
        if (e.type === "input_audio_buffer.speech_started") {
          interrupt();
        }
        if (e.type === "input_audio_buffer.speech_stopped") {
          setState("thinking");
          clearTimeout(r.answerWait);
          r.answerWait = setTimeout(() => {
            if (current()) send({ type: "response.create" });
          }, input.silence);
        }
        if (e.type === "response.created") {
          clearTimeout(r.answerWait);
          r.responding = true;
          r.responseId = e.response?.id;
          r.audio.muted = false;
          r.capture?.remoteMuted(false);
          setState("speaking");
        }
        if (e.type === "response.done") {
          if (!r.responseId || r.responseId === e.response?.id) {
            r.responding = false;
            r.responseId = undefined;
            setState("listening");
          }
          const id = e.response?.id;
          if (id && !completedResponses.has(id)) {
            const entry = usageEntry(e.response, { connection: prefix, model });
            if (entry) { completedResponses.add(id); cb.current.usage(entry); }
          }
          if (e.response?.status === "failed") {
            stop("模型未能完成回答，请检查额度或服务状态后重连。", true);
            return;
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
          setError(
            "这一段语音未能转成文字。结束后请补充文字并确认，避免漏评。",
          );
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
          if (current()) stop("实时消息通道异常，请重新连接。", true);
        };
        channel.onclose = () => {
          if (current()) stop("实时消息通道已关闭，请重新连接。", true);
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
    muted,
    seconds,
    audioBlocked,
    start,
    stop,
    interrupt,
    mute,
    playAudio,
    recording,
    async retryRecordingSave() {
      const temporary = recording.unsaved;
      if (!temporary || saving.current) return;
      setRecording({ ...recording, phase: 'saving' });
      const task = restoreRecording(temporary.record, temporary.chunks);
      saving.current = task;
      try { await task; if (mounted.current) setRecording({phase:'saved',id:temporary.record.id}); }
      catch { if (mounted.current) setRecording({ ...recording, phase: 'error' }); }
      finally { if (saving.current === task) saving.current = null; }
    },
    discardTemporaryRecording() { if (!saving.current) setRecording({phase:'idle'}); },
  };
}
