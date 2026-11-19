import { useEffect, useRef, useState } from "react";
import { CaretDown, HandPalm, Microphone, MicrophoneSlash, PhoneDisconnect, Sparkle, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react';
import { go, setNavigationGuard } from "./components";
import { RealtimeSettings } from "./RealtimeSettings";
import { useLiveInterview } from "./useLiveInterview";
import { transcriptEvent, reviewTurns } from "./liveTranscript.mjs";
import type { LiveMessage } from "./liveTranscript.mjs";
import { usageTotals } from "./liveUsage.mjs";
import { LiveCallStage } from "./LiveCallStage";
import { LiveRecordings } from './LiveRecordings';
import { punctuateAnswer } from "./interviewPunctuation.mjs";
import { reviewReadiness } from "../server/interview-readiness.mjs";
import type { UsageEntry } from "./liveUsage.mjs";
import "./live-interview.css";
import "./live-call-layout.css";
import type { InterviewSource } from './interviewTraining';
import { InterviewNextSteps } from './InterviewJourney';
import { saveInterviewReport } from './interviewReportStorage';
import type { PendingInterviewReportSave } from './interviewReportStorage';

type Source = InterviewSource;
type Report = {
  summary: string;
  dimensions: {
    name: string;
    score: number | null;
    evidence: string;
    advice: string;
  }[];
  nextStep: string;
};
type Draft = {
  id: string;
  source: Source | null;
  messages: LiveMessage[];
  elapsed: number;
  tokens: number;
  usage: UsageEntry[];
  minutes: number;
  report: Report | null;
  messageTimes?: Record<string, number>;
  pendingReport?: PendingInterviewReportSave;
};
type Saved = { time: string; draft: Draft };
const key = "kaikou.live-interview.draft.v1";
const historyKey = "kaikou.live-interview.history.v1";
const blank = (): Draft => ({
  id: crypto.randomUUID(),
  source: null,
  messages: [],
  elapsed: 0,
  tokens: 0,
  usage: [],
  minutes: 10,
  report: null,
});
function read(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(key) || "null");
    if (
      !d ||
      typeof d.id !== "string" ||
      !Array.isArray(d.messages) ||
      d.messages.length > 80
    )
      return blank();
    if (
      d.source &&
      [d.source.role, d.source.resume, d.source.job].some(
        (v) => typeof v !== "string",
      )
    )
      return blank();
    return {
      ...blank(),
      ...d,
      elapsed: Math.max(0, Number(d.elapsed) || 0),
      tokens: Math.max(0, Number(d.tokens) || 0),
      usage: Array.isArray(d.usage) ? d.usage.filter((e: UsageEntry) => e && typeof e.id === "string" && Number.isSafeInteger(e.total) && e.total >= 0) : [],
      messages: d.messages.filter(
        (m: LiveMessage) =>
          m &&
          typeof m.id === "string" &&
          ["user", "assistant"].includes(m.role) &&
          typeof m.text === "string",
      ),
    };
  } catch {
    return blank();
  }
}
function readSaved(): Saved[] {
  try {
    const h = JSON.parse(localStorage.getItem(historyKey) || "[]");
    return Array.isArray(h)
      ? h.filter((v) => v?.draft?.report && v?.draft?.messages).map((v) => ({ ...v, draft: { ...v.draft, usage: Array.isArray(v.draft.usage) ? v.draft.usage : [] } }))
      : [];
  } catch {
    return [];
  }
}
const clock = (n: number) =>
  `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(n % 60)
    .toString()
    .padStart(2, "0")}`;

export function LiveInterview({
  source,
  onLock,
  onActive,
  onPendingReport,
  onMaterialsRequired,
}: {
  source: Source;
  onLock: (v: boolean) => void;
  onActive: (v: boolean) => void;
  onPendingReport?: (v: boolean) => void;
  onMaterialsRequired?: () => void;
}) {
  const [draft, setDraft] = useState(read);
  const [saved, setSaved] = useState(readSaved);
  const [configured, setConfigured] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [transcriptOpen, setTranscriptOpen] = useState(true);
  const [recordingsOpen, setRecordingsOpen] = useState(() => read().elapsed > 0);
  const [reportExpanded, setReportExpanded] = useState(() => Boolean(read().report));
  const [trialReady, setTrialReady] = useState(false);
  const [trialMessage, setTrialMessage] = useState("免费额度尚未核对");
  const [status, setStatus] = useState("正在检查实时服务配置…");
  const [consent, setConsent] = useState(false);
  const [silence, setSilence] = useState(2000);
  const [error, setError] = useState("");
  const [reportSaveError, setReportSaveError] = useState("");
  const [punctuationUndo, setPunctuationUndo] = useState<Record<string,{before:string;after:string;final:boolean}>>({});
  const [reviewing, setReviewing] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const recoveryBusy = useRef(false);
  const reviewAbort = useRef<AbortController | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const log = useRef<HTMLDivElement>(null);
  const transcriptAtBottom = useRef(true);
  const elapsedRef = useRef(0);
  const update = (part: Partial<Draft>) => setDraft((d) => ({ ...d, ...part }));
  const live = useLiveInterview({
    event: (e) => {
      if(e.type==='conversation.item.input_audio_transcription.completed' && typeof e.transcript==='string') {
        const before=e.transcript, itemId=e.item_id;
        const after=punctuateAnswer(before);
        if(after!==before && typeof itemId==='string')setPunctuationUndo(v=>({...v,[itemId]:{before,after,final:true}}));
        e={...e,transcript:after};
      }
      setDraft((d) => {
        const messages = transcriptEvent(d.messages, e);
        const added = messages.filter(message => !d.messages.some(previous => previous.id === message.id));
        if (!added.length) return { ...d, messages };
        // Only newly received messages get an observed call-relative time.
        // Older drafts have no timestamp metadata and are not backfilled.
        const messageTimes = { ...d.messageTimes };
        for (const message of added) messageTimes[message.id] = elapsedRef.current;
        return { ...d, messages, messageTimes };
      });
    },
    elapsed: (n) => setDraft((d) => ({ ...d, elapsed: d.elapsed + n })),
    usage: (entry) => setDraft((d) => d.usage.some((v) => v.id === entry.id) ? d : ({ ...d, tokens: d.tokens + entry.total, usage: [...d.usage, entry] })),
  });
  const active = ["connecting", "listening", "thinking", "speaking"].includes(
    live.state,
  );
  const elapsed = draft.elapsed + (active ? live.seconds : 0);
  elapsedRef.current = elapsed;
  const recordingBusy = live.recording.phase === 'saving';
  const recordingUnsaved = Boolean(live.recording.unsaved);
  const reportPending = Boolean(draft.report && draft.pendingReport);
  const turns = reviewTurns(draft.messages);
  const totals = usageTotals(draft.usage);
  const formatTokens = (value: number | null) => value === null ? "未完整回报" : value.toLocaleString();
  const incomplete = draft.messages.filter(
    (m) => m.role === "user" && !m.final,
  ).length;
  function revealLiveSettings() {
    setPreflightOpen(true);
    requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLDetailsElement>('.live-preflight');
      if (!panel) return;
      panel.open = true;
      panel.scrollIntoView({ block: 'start' });
      panel.querySelector<HTMLElement>('summary')?.focus();
    });
  }
  function revealTranscript() {
    setTranscriptOpen(true);
    requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLDetailsElement>('.live-transcript-disclosure');
      if (!panel) return;
      panel.open = true;
      panel.scrollIntoView({ block: 'nearest' });
      panel.querySelector<HTMLElement>('textarea, summary')?.focus();
    });
  }
  useEffect(() => {
    if (active) { setTranscriptOpen(true); setRecordingsOpen(false); }
  }, [active]);
  useEffect(() => {
    if (!active && incomplete) setTranscriptOpen(true);
  }, [active, incomplete]);
  useEffect(() => {
    if (['saving', 'saved', 'error'].includes(live.recording.phase)) setRecordingsOpen(true);
  }, [live.recording.phase]);
  async function refresh() {
    try {
      const response = await fetch("/api/realtime/status", {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw Error();
      const data = await response.json();
      setConfigured(data.configured === true);
      if(!data.configured)setPreflightOpen(true);
      setTrialReady(data.trial?.ready === true);
      setTrialMessage(data.trial?.message || "免费额度尚未核对，请展开 LIVE 配置。");
      setStatus(
        data.configured
          ? "配置已就绪，开始后检查连接与模型权限"
          : data.message || "请先配置实时语音服务",
      );
    } catch {
      setConfigured(false);
      setPreflightOpen(true);
      setTrialReady(false);
      setStatus("配置状态暂不可读，请重新检查或展开配置。");
    }
  }
  useEffect(() => {
    void refresh();
    return () => reviewAbort.current?.abort();
  }, []);
  useEffect(() => {
    onLock(active || Boolean(draft.source) || reviewing || recovering || recordingBusy || recordingUnsaved);
    onActive(active || reviewing || recovering || recordingBusy || recordingUnsaved);
    if(active){setPreflightOpen(false);requestAnimationFrame(()=>document.querySelector('.live-call-room')?.scrollIntoView({block:'start'}));}
  }, [active, reviewing, recovering, recordingBusy, recordingUnsaved, draft.source, onLock, onActive]);
  useEffect(
    () => () => {
      onLock(false);
      onActive(false);
    },
    [onLock, onActive],
  );
  useEffect(() => {
    onPendingReport?.(reportPending);
    return () => onPendingReport?.(false);
  }, [reportPending, onPendingReport]);
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ ...draft, elapsed }));
    } catch {
      setError("本机保存失败，请立即导出本轮文字，避免关闭后丢失。");
    }
  }, [draft, elapsed]);
  useEffect(() => {
    if (
      draft.messages.length > 78 ||
      draft.messages.reduce((n, m) => n + m.text.length, 0) > 58000
    ) {
      if (active)
        live.stop("本轮文字达到容量上限，已停止通话，请先生成复盘或导出。");
    }
    if (log.current && transcriptAtBottom.current) log.current.scrollTop = log.current.scrollHeight;
  }, [draft.messages]);
  useEffect(() => {
    if (!active && !reviewing && !recovering && !recordingBusy && !recordingUnsaved && !reportPending) return;
    setNavigationGuard(() => {
      if (recoveryBusy.current) { setError('正在保存录音并恢复通话，请稍候再离开。'); return false; }
      if (recordingBusy) { setError('录音正在保存，请稍候再离开。'); return false; }
      return window.confirm(recordingUnsaved ? '录音尚未完整保存，请先下载临时录音。确定离开并放弃临时副本吗？' : reportPending ? '本轮 AI 复盘尚未保存到历史，请先重试保存或导出本轮文字。离开后可返回 LIVE 草稿继续保存；若本机草稿也保存失败，关闭页面会丢失当前副本。确定离开吗？' : '离开会结束实时通话或取消复盘请求。已收到的文字保留，通话录音会在本机收尾保存。是否离开？');
    });
    const before = (e: BeforeUnloadEvent) => {
      if (active) live.stop('已结束通话，正在保存录音。');
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => {
      setNavigationGuard(undefined);
      window.removeEventListener("beforeunload", before);
    };
  }, [active, reviewing, recovering, recordingBusy, recordingUnsaved, reportPending]);
  function saveReport(complete: Draft) {
    try {
      saveInterviewReport('live', complete);
      update({ pendingReport: undefined });
      setSaved(readSaved()); setReportSaveError('');
    } catch (e) {
      setReportSaveError(e instanceof Error ? e.message : '复盘保存失败，请先导出本轮文字，再重试保存。');
    }
  }
  async function start() {
    if (active || reviewing || recoveryBusy.current || recordingBusy || recordingUnsaved) return;
    if (reportPending) { setReportSaveError('本轮 AI 复盘尚未保存到历史，请先重试保存或导出后开始新一轮，避免重连覆盖待保存结果。'); return; }
    setError("");
    const current = draft.source || source;
    if (current.resume.trim().length < 20 || current.job.trim().length < 20) {
      setError("请先在上方上传或填写至少 20 字的简历和 JD。");
      onMaterialsRequired?.();
      return;
    }
    if (!consent) {
      setError("请先确认实时服务的数据发送和计费说明。");
      document.querySelector<HTMLInputElement>('.live-consent input')?.focus();
      return;
    }
    if (!configured) {
      setError("请先展开 LIVE 服务配置，保存后重新检查。");
      revealLiveSettings();
      return;
    }
    if (!trialReady) { setError(trialMessage); revealLiveSettings(); return; }
    if (draft.minutes > 10) { setError("本次免费试用最多 10 分钟，请开始新一轮并选择 10 分钟。"); return; }
    if (draft.elapsed >= draft.minutes * 60) {
      setError("本轮时长已用完，请生成复盘或开始新一轮。");
      return;
    }
    if (draft.messages.length >= 78) {
      setError("本轮对话已满，请开始新一轮。");
      return;
    }
    update({ source: { ...current }, report: null });
    await live.start({
      roundId: draft.id,
      ...current,
      history: draft.messages
        .filter((m) => m.text.trim() && (m.role === "assistant" ? !m.interrupted && m.final && (m.text.trim().length >= 6 || /[?？]$/.test(m.text.trim())) : m.final))
        .map(({ role, text }) => ({ role, text })),
      minutes: draft.minutes,
      silence,
      remaining: draft.minutes * 60 - draft.elapsed,
    });
  }
  async function recoverCall() {
    if (recoveryBusy.current || reviewing || live.state === 'connecting' || recordingBusy || recordingUnsaved) return;
    if (reportPending) { setReportSaveError('请先保存已生成的复盘，再继续本轮通话。'); return; }
    recoveryBusy.current = true;
    setRecovering(true);
    setError('');
    try {
      // Recheck free-only eligibility before a new billable connection. The
      // desktop service independently validates it again when creating it.
      const response = await fetch('/api/realtime/status', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw Error('暂时无法核对免费额度，已暂停通话。请重新检查 LIVE 配置后继续。');
      const data = await response.json();
      setConfigured(data.configured === true);
      setTrialReady(data.trial?.ready === true);
      setTrialMessage(data.trial?.message || '免费额度尚未核对');
      if (!data.configured || data.trial?.ready !== true) {
        throw Error(data.trial?.message || '实时服务或免费额度尚未就绪，请重新核对后继续。');
      }
      const currentDraft = draftRef.current;
      const currentSource = currentDraft.source;
      if (!currentSource || !consent) throw Error('请先确认本轮资料与实时语音发送说明。');
      if (currentDraft.minutes > 10 || elapsedRef.current >= currentDraft.minutes * 60) {
        live.stop('本轮时长已用完，已保留文字和录音。可以生成 AI 复盘。');
        return;
      }
      if (currentDraft.messages.length >= 78) { live.stop('本轮对话已满，请先导出或生成复盘。'); return; }
      await live.recover({
        roundId: currentDraft.id,
        ...currentSource,
        history: currentDraft.messages.filter(m => m.text.trim() && (m.role === 'assistant' ? !m.interrupted && m.final && (m.text.trim().length >= 6 || /[?？]$/.test(m.text.trim())) : m.final)).map(({role,text})=>({role,text})),
        minutes: currentDraft.minutes,
        silence,
        // recover accounts for the still-active connection exactly once.
        remaining: currentDraft.minutes * 60 - currentDraft.elapsed,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : '恢复未完成。文字和录音已保留，请重新检查服务。';
      live.stop(message, true);
      setError(message);
      revealLiveSettings();
    } finally {
      recoveryBusy.current = false;
      setRecovering(false);
    }
  }
  async function review() {
    if (reviewing || recoveryBusy.current) return;
    if (reportPending) { setReportSaveError('AI 复盘已经生成，请点击“重试保存复盘”；保存完成后才能重新生成，避免丢失本次结果。'); return; }
    if (active) { setError('请先点击“结束面试”，再生成 AI 面试复盘。'); return; }
    if (!draft.source || !turns.length) {
      if (draft.messages.length) revealTranscript();
      setError(
        draft.messages.some(m=>m.role==='user'&&m.final&&m.text.trim()) ? "回答内容太少，暂时无法生成面试复盘。请至少完成 1 题、回答 5 个有效字，并确认对应的问题。" : "请先完成至少一个有明确问题的回答。未完成转写可以在下方补充并确认。",
      );
      return;
    }
    if (incomplete) {
      setError("还有未完成的转写，请先核对并确认这些回答，避免漏评。");
      revealTranscript();
      return;
    }
    const eligibility=reviewReadiness(turns);
    if (!eligibility.ready) { setError(eligibility.message); return; }
    setReviewing(true);
    setError("");
    const controller = new AbortController();
    reviewAbort.current = controller;
    const snapshot = draft;
    try {
      const response = await fetch("/api/realtime/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "feedback",
          ...snapshot.source,
          history: turns,
        }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(100000),
        ]),
      });
      const report = await response.json().catch(() => ({}));
      if (controller.signal.aborted || snapshot.id !== draftRef.current.id)
        return;
      if (!response.ok) throw Error(report.error || "AI 复盘失败，请重试。");
      if (!Array.isArray(report.dimensions) || !report.summary)
        throw Error("点评结果格式无效，请重试。");
      const complete: Draft = { ...snapshot, report, pendingReport: { id: snapshot.id, time: new Date().toISOString() } };
      update(complete);
      setReportExpanded(true);
      saveReport(complete);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error
            ? e.message
            : "复盘失败，已有文字保留，可重新生成。",
        );
    } finally {
      if (!controller.signal.aborted) setReviewing(false);
    }
  }
  function reset() {
    if (recoveryBusy.current || recordingBusy || recordingUnsaved) return;
    if (
      (reportPending || draft.messages.length) &&
      !window.confirm(
          reportPending ? "本轮 AI 复盘尚未保存到历史。开始新一轮会移除当前待保存副本，请先重试保存或导出本轮文字。确定放弃待保存复盘并开始新一轮吗？" : "开始新一轮？当前未存入复盘的对话将清空，已保存的录音和复盘仍保留。可先导出本轮文字。",
      )
    )
      return;
    live.stop();
    setDraft(blank());
    setError("");
    setReportSaveError('');
    setConsent(false);
  }
  function download() {
    const text = [
      "开口练习 · LIVE 模拟面试",
      `岗位：${draft.source?.role || "未填写"}`,
      `通话累计：${clock(elapsed)}`,
      `服务已回报 ${draft.tokens} tokens；未完成响应可能未回报，非账单金额。`,
      ...draft.messages.map(
        (m) =>
          `${m.role === "user" ? "我" : "面试官"}${m.final ? "" : "（转写未确认）"}：${m.text}`,
      ),
      draft.report
        ? `复盘：${JSON.stringify(draft.report, null, 2)}`
        : "尚未生成 AI 复盘",
    ].join("\n\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `LIVE面试-${draft.id.slice(0, 8)}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function downloadUsage() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({
      schema: "kaikou.live.usage.v1", id: draft.id, exportedAt: new Date().toISOString(),
      elapsedSeconds: elapsed, reportedTotalTokens: draft.tokens, totals, responses: draft.usage,
      billing: { status: "not_verified", note: "仅记录服务回报。免费额度扣减与实际账单需在控制台核对，未完成响应可能尚未计入。" },
    }, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `LIVE用量-${draft.id.slice(0,8)}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const labels = {
    idle: "准备开始",
    connecting: "正在连接",
    listening: "正在听你说",
    thinking: "正在准备追问",
    speaking: "面试官正在说话",
    ended: "通话已结束",
    error: "连接需要恢复",
  };
  return (
    <section className={`interview-panel live-panel ${active ? 'is-in-call' : ''}`}>
      <div className="live-session-bar">
        <div className="live-session-title"><span className="live-session-tag">LIVE</span><h2>面试 · {draft.source?.role || source.role || '岗位模拟面试'}</h2></div>
        <div className="live-session-status">
          <span className={`live-recording-status ${live.recording.phase === 'recording' ? 'is-recording' : ''}`}><i aria-hidden="true" />{live.recording.phase === 'recording' ? '录音中' : recordingBusy ? '正在保存录音' : recordingUnsaved ? '录音待保存' : live.recording.phase === 'error' ? '录音异常' : live.recording.phase === 'saved' ? '录音已保存' : labels[live.state]}</span>
          <span className="live-clock" aria-label={`本轮已通话 ${clock(elapsed)}，时长上限 ${clock(draft.minutes * 60)}`}>{clock(elapsed)} <span>/ {clock(draft.minutes * 60)}</span></span>
        </div>
      </div>
      <details className="live-preflight" hidden={active || recovering} open={preflightOpen} onToggle={e=>setPreflightOpen(e.currentTarget.open)}>
      <summary>通话设置与资料 · {draft.minutes} 分钟 · {configured ? '实时服务已配置' : '请先配置实时服务'}</summary>
      {!active && !reviewing && !recovering && (
        <RealtimeSettings onSaved={() => void refresh()} />
      )}
      <div className="live-config-status">
        <span>{status}</span>
        <button
          className="text-button"
          disabled={active}
          onClick={() => void refresh()}
        >
          重新检查
        </button>
      </div>
      {draft.source && (
        <details className="live-source">
          <summary>本轮使用的资料 · {draft.source.role || "模拟面试"}</summary>
          <p>重连沿用本轮资料。要换岗位或简历，请先开始新一轮。</p>
          <strong>简历</strong>
          <p>{draft.source.resume}</p>
          <strong>岗位描述</strong>
          <p>{draft.source.job}</p>
        </details>
      )}
      <div className="interview-columns live-options">
        <label>
          本轮时长上限
          <select
            disabled={active || Boolean(draft.source)}
            value={draft.minutes}
            onChange={(e) => update({ minutes: Number(e.target.value) })}
          >
            <option value={5}>5 分钟 · 快速体验</option>
            <option value={10}>10 分钟 · 常规面试</option>
            {draft.minutes > 10 && <option value={draft.minutes}>旧草稿 {draft.minutes} 分钟 · 请开始新一轮试用</option>}
          </select>
        </label>
        <label>
          思考停顿
          <select
            disabled={active}
            value={silence}
            onChange={(e) => setSilence(Number(e.target.value))}
          >
            <option value={1200}>较快 · 1.2 秒</option>
            <option value={2000}>自然 · 2 秒</option>
            <option value={3000}>宽松 · 3 秒</option>
          </select>
        </label>
      </div>
      </details>
      <p className="live-trial-status" role="status">仅免费额度试用 · {trialMessage}</p>
      {(live.health || recovering) && <div className="live-recovery-notice" role="status" aria-live="polite" data-health={live.health?.level || 'warning'} data-reason={live.health?.kind || 'network'}>
        <div><strong>{recovering ? '正在保存录音并恢复通话' : live.health?.level === 'stalled' ? '通话需要恢复' : '通话连接或响应异常'}</strong>
        <p>{recovering ? '沿用本轮资料和已确认的对话，时长继续累计。请稍候。' : live.health?.message}</p>
        <small>已有文字和录音保留；未完成的转写不会自动确认。恢复后，请接着回答或重说没有转写的部分。</small></div>
        <button className="button secondary" disabled={recovering || recordingBusy || recordingUnsaved || reviewing || live.state === 'connecting'} onClick={()=>void recoverCall()}>{recovering ? '正在保存并重连…' : recordingBusy ? '正在保存录音…' : '恢复本轮通话'}</button>
      </div>}
      <div className="live-call-workspace">
        <LiveCallStage state={live.state} label={labels[live.state]} muted={live.muted} playbackVolume={live.playbackVolume} healthMessage={recovering ? '正在恢复通话，请稍候' : live.health?.message} question={[...draft.messages].reverse().find(m=>m.role==='assistant'&&!m.interrupted)?.text || ''}/>
      <details className="interview-disclosure live-transcript-disclosure" open={transcriptOpen} onToggle={e=>setTranscriptOpen(e.currentTarget.open)}><summary><strong>对话记录</strong><span className="live-transcript-mode">{active ? '实时转写' : draft.messages.length ? '本轮文字' : '等待通话'}</span></summary>
      <div className="live-transcript-heading">
        <p>{active ? '结束后可校正文字' : incomplete ? `${incomplete} 段回答待确认` : '可修正识别错误，不必重写回答'}</p>
        <button className="text-button" disabled={!draft.messages.length} onClick={download}>
          导出本轮文字
        </button>
      </div>
      <div
        className="live-transcript"
        ref={log}
        role="log"
        aria-label="面试对话文字"
        aria-live="polite"
        onScroll={e => { const panel = e.currentTarget; transcriptAtBottom.current = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 64; }}
      >
        {!draft.messages.length && (
          <div className="live-empty">
            面试官的问题和你的回答会显示在这里。
            <br />
            无需逐题点击录音和提交。
          </div>
        )}
        {draft.messages.map((m, i) => (
          <article key={m.id} className={`live-message live-${m.role}`}>
            <strong>
              {m.role === "user" ? "我" : "面试官"}
              {typeof draft.messageTimes?.[m.id] === 'number' && Number.isFinite(draft.messageTimes[m.id]) && draft.messageTimes[m.id] >= 0 && <time title="本轮收到这条转写文字时的通话时间">{clock(draft.messageTimes[m.id])}</time>}
              <small>{m.interrupted ? " · 已打断，不作为完整问题评分" : !m.final ? " · 转写未确认" : ""}</small>
            </strong>
            {!active && m.role === "user" ? (
              <>
                <textarea
                  aria-label={`第 ${i + 1} 条回答文字`}
                  disabled={reviewing || recovering || reportPending}
                  value={m.text}
                  maxLength={4000}
                  onChange={(e) =>
                    update({
                      messages: draft.messages.map((v) =>
                        v.id === m.id
                          ? { ...v, text: e.target.value, final: false }
                          : v,
                      ),
                      report: null,
                    })
                  }
                />
                <button className="text-button" disabled={reviewing||recovering||reportPending||!m.text.trim()} onClick={()=>{const after=punctuateAnswer(m.text);if(after===m.text)return;setPunctuationUndo(v=>({...v,[m.id]:{before:m.text,after,final:m.final}}));update({messages:draft.messages.map(v=>v.id===m.id?{...v,text:after,final:false}:v),report:null});}}>补充这段标点</button>
                {punctuationUndo[m.id]?.after===m.text && <button className="text-button" disabled={reviewing || recovering || reportPending} onClick={()=>{const prior=punctuationUndo[m.id];update({messages:draft.messages.map(v=>v.id===m.id?{...v,text:prior.before,final:prior.final}:v),report:null});setPunctuationUndo(v=>{const next={...v};delete next[m.id];return next;});}}>撤销这段标点</button>}
                {!m.final && (
                  <button
                    className="text-button"
                    disabled={reviewing || recovering || reportPending || !m.text.trim()}
                    onClick={() =>
                      update({
                        messages: draft.messages.map((v) =>
                          v.id === m.id ? { ...v, final: true } : v,
                        ),
                      })
                    }
                  >
                    确认这段回答
                  </button>
                )}
              </>
            ) : (
              <p>{m.text || "正在识别…"}</p>
            )}
          </article>
        ))}
      </div>
      <p>
        通话结束后可以回放下方录音、修正识别错误，不必重写回答。断线前已录下的声音会保留；断线期间未收到的声音无法补回。
      </p>
      </details>
      </div>
      <label className="live-consent" hidden={active || recovering}>
        <input
          type="checkbox"
          checked={consent}
          disabled={active}
          onChange={(e) => setConsent(e.target.checked)}
        />
        <span>
          开始后向千问实时服务发送本轮简历、JD、对话及麦克风音频，并消耗该模型额度。双方通话声音会自动录制并保存到本机，可随时删除。已核对云端用完即停后再试用。复盘另由已配置的点评服务处理文字，不会自动调用。
        </span>
      </label>
      {active && <p className="live-consent-confirmed">已按你的确认发送本轮资料与语音 · 结束通话后可生成复盘</p>}
      {(error || live.error) && (
        <div className="interview-error" role="alert">
          {error || live.error}
        </div>
      )}
      {reportPending && <div className="interview-error" role="alert"><p>{reportSaveError || '本轮 AI 复盘尚未保存到历史，待保存结果已恢复。请重试保存，无需再次调用 AI。'}</p><p>保存完成后可以继续修改回答或重新连接。</p><div className="interview-controls"><button className="button primary" onClick={() => saveReport(draft)}>重试保存复盘</button><button className="text-button" onClick={download}>导出本轮文字与复盘</button><button className="text-button" onClick={() => go('/history?type=interview')}>管理已保存的面试记录</button></div></div>}
      <div className="interview-controls live-call-controls">
        <button
          className="button secondary live-mic-control"
          disabled={!active || recovering || live.state === 'connecting'}
          aria-label={live.muted ? '开启麦克风' : '麦克风静音'}
          aria-pressed={live.muted}
          onClick={live.mute}
        >
          {live.muted ? <MicrophoneSlash size={23} aria-hidden="true" /> : <Microphone size={23} aria-hidden="true" />}
          {live.muted ? '取消静音' : '静音'}
        </button>
        <details className="live-output-control">
          <summary>{live.playbackVolume === 0 ? <SpeakerSlash size={23} aria-hidden="true" /> : <SpeakerHigh size={23} aria-hidden="true" />}声音<CaretDown size={15} aria-hidden="true" /></summary>
          <div className="live-volume-popover">
            <label>面试官播放音量 <output>{Math.round(live.playbackVolume * 100)}%</output><input aria-label="面试官播放音量" type="range" min="0" max="100" step="1" value={Math.round(live.playbackVolume * 100)} onChange={e => live.setVolume(Number(e.target.value) / 100)} /></label>
            <p>只调整播放声音，不影响双方通话录音。</p>
          </div>
        </details>
        {!active ? (
          <button
            className={`button ${draft.messages.length ? 'secondary' : 'primary'}`}
            disabled={reviewing || recovering || recordingBusy || recordingUnsaved}
            onClick={() => void start()}
          >
            {draft.source ? "重新连接 / 继续本轮" : "开始 LIVE 面试"}
          </button>
        ) : (
          <>
            <button
              className="button secondary"
              data-action="end-call"
              disabled={recovering}
              aria-label="结束 / 暂停通话"
              onClick={() =>
                live.stop(
                  "已断开实时连接。已收到的文字保留，可继续本轮或生成复盘。",
                )
              }
            >
              <PhoneDisconnect size={23} weight="fill" aria-hidden="true" />结束面试
            </button>
          </>
        )}
        <button
          className={`button live-review-control ${!active && draft.messages.length && !draft.report ? 'primary' : 'secondary'}`}
          aria-label={reviewing ? '正在生成 AI 复盘…' : '生成 AI 面试复盘'}
          disabled={reviewing || recovering}
          onClick={() => void review()}
        >
          <Sparkle size={23} aria-hidden="true" />{reviewing ? '正在生成 AI 复盘…' : 'AI 面试复盘'}
        </button>
        {active && <button className="button secondary live-interrupt-control" disabled={recovering || live.state === 'connecting'} onClick={live.interrupt}><HandPalm size={20} aria-hidden="true" />打断面试官</button>}
        {live.audioBlocked && (
          <button
            className="button secondary"
            onClick={() => void live.playAudio()}
          >
            开启面试官声音
          </button>
        )}
      </div>
      {active && !live.health && <button className="text-button live-manual-recovery" disabled={recovering || live.state === 'connecting'} onClick={()=>void recoverCall()}>通话卡住了？</button>}
      <div className="interview-review-status" aria-live="polite"><p>{active ? '先结束通话，再生成复盘；无需达到 10 分钟。' : incomplete ? `还有 ${incomplete} 段转写未确认，请在对话记录中核对。` : reviewReadiness(turns).message}</p></div>
      {active && live.recording.message && <p className="interview-error" role="alert">{live.recording.message}</p>}
      <details className="interview-disclosure live-recording-disclosure" open={recordingsOpen} onToggle={e=>setRecordingsOpen(e.currentTarget.open)}><summary>通话录音与回放 <span>{live.recording.phase === 'recording' ? '正在录制双方声音' : recordingBusy ? '正在保存，请稍候…' : recordingUnsaved ? '尚未完整保存 · 请处理' : '自动保存到本机'}</span></summary>
      <LiveRecordings roundId={draft.id} state={live.recording} active={active || reviewing || recovering} reviews={saved.map(s=>s.draft.id)} onRetry={()=>void live.retryRecordingSave()} onDiscard={live.discardTemporaryRecording} onReview={id=>go(`/history?type=interview&kind=live&id=${encodeURIComponent(id)}`)}/>
      </details>
      {(draft.elapsed > 0 || draft.usage.length > 0) && <details className="live-usage interview-disclosure"><summary>本轮实际回报用量 <span>{draft.usage.length} 条响应记录</span></summary>
      <p className="live-cost">
        重连继续累计本轮时长；到时自动结束。
        {draft.tokens
          ? `服务已回报 ${draft.tokens.toLocaleString()} tokens（未包含所有可能费用）。`
          : "服务尚未回报用量。"}{" "}
        实际扣费以服务商账单为准。
      </p>
        <table><thead><tr><th>类型</th><th>输入 tokens</th><th>输出 tokens</th></tr></thead><tbody>
          <tr><th>文字</th><td>{formatTokens(totals.inputText)}</td><td>{formatTokens(totals.outputText)}</td></tr>
          <tr><th>音频</th><td>{formatTokens(totals.inputAudio)}</td><td>{formatTokens(totals.outputAudio)}</td></tr>
          <tr><th>全部输入 / 输出</th><td>{formatTokens(totals.input)}</td><td>{formatTokens(totals.output)}</td></tr>
        </tbody></table>
        <p>这些数字来自模型响应，不是计费预测。包含上下文重复计入的用量；断线、取消或结束时尚未回报的响应可能不完整。未回报显示为未知，不当作零消耗。</p>
        <button className="text-button" onClick={downloadUsage}>导出本轮用量 JSON</button>
      </details>}

      <div className="interview-controls live-round-controls">
        <button
          className="button secondary"
          disabled={active || reviewing || recovering || recordingBusy || recordingUnsaved}
          onClick={reset}
        >
          开始新一轮 LIVE
        </button>
        <button
          className="text-button"
          disabled={active || reviewing}
          onClick={() => go("/settings")}
        >
          点评服务设置
        </button>
      </div>
      {draft.report && (
        <details className="live-report interview-disclosure" open={reportExpanded} onToggle={e=>setReportExpanded(e.currentTarget.open)}>
          <summary>本轮 AI 面试复盘</summary>
          <p>{draft.report.summary}</p>
          {draft.source && <InterviewNextSteps key={draft.id + JSON.stringify(draft.report)} source={draft.source} report={draft.report} turns={reviewTurns(draft.messages)} origin="live" disabled={active || reviewing || recordingBusy || recordingUnsaved} />}
          <details className="interview-analysis"><summary>查看各维度分析 · {draft.report.dimensions.length} 项</summary>
          <div className="interview-scores">
            {draft.report.dimensions.map((d, i) => (
              <article key={i}>
                <strong>{d.name}</strong>
                <b>{d.score === null ? "证据不足" : `${d.score} / 5`}</b>
                {d.evidence && <blockquote>“{d.evidence}”</blockquote>}
                <p>{d.advice}</p>
              </article>
            ))}
          </div>
          <p>
            <strong>下一次练习：</strong>
            {draft.report.nextStep}
          </p>
          <small>
            依据已确认文字评价内容和结构，不推断声音情绪，不代表录用结论。
          </small>
          </details>
        </details>
      )}
      {saved.length > 0 && (
        <div className="live-history">
          <button className="text-button" disabled={active || reviewing || recordingBusy || recordingUnsaved} onClick={() => go('/history?type=interview')}>查看已保存的 LIVE 复盘 · {saved.length} 轮</button>
        </div>
      )}
    </section>
  );
}
