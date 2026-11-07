import { useEffect, useRef, useState } from "react";
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

type Source = { role: string; resume: string; job: string };
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
}: {
  source: Source;
  onLock: (v: boolean) => void;
  onActive: (v: boolean) => void;
}) {
  const [draft, setDraft] = useState(read);
  const [saved, setSaved] = useState(readSaved);
  const [configured, setConfigured] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [trialReady, setTrialReady] = useState(false);
  const [trialMessage, setTrialMessage] = useState("免费额度尚未核对");
  const [status, setStatus] = useState("正在检查实时服务配置…");
  const [consent, setConsent] = useState(false);
  const [silence, setSilence] = useState(2000);
  const [error, setError] = useState("");
  const [punctuationUndo, setPunctuationUndo] = useState<Record<string,{before:string;after:string;final:boolean}>>({});
  const [reviewing, setReviewing] = useState(false);
  const reviewAbort = useRef<AbortController | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const log = useRef<HTMLDivElement>(null);
  const update = (part: Partial<Draft>) => setDraft((d) => ({ ...d, ...part }));
  const live = useLiveInterview({
    event: (e) => {
      if(e.type==='conversation.item.input_audio_transcription.completed' && typeof e.transcript==='string') {
        const before=e.transcript, itemId=e.item_id;
        const after=punctuateAnswer(before);
        if(after!==before && typeof itemId==='string')setPunctuationUndo(v=>({...v,[itemId]:{before,after,final:true}}));
        e={...e,transcript:after};
      }
      setDraft((d) => ({ ...d, messages: transcriptEvent(d.messages, e) }));
    },
    elapsed: (n) => setDraft((d) => ({ ...d, elapsed: d.elapsed + n })),
    usage: (entry) => setDraft((d) => d.usage.some((v) => v.id === entry.id) ? d : ({ ...d, tokens: d.tokens + entry.total, usage: [...d.usage, entry] })),
  });
  const active = ["connecting", "listening", "thinking", "speaking"].includes(
    live.state,
  );
  const elapsed = draft.elapsed + (active ? live.seconds : 0);
  const recordingBusy = live.recording.phase === 'saving';
  const recordingUnsaved = Boolean(live.recording.unsaved);
  const turns = reviewTurns(draft.messages);
  const totals = usageTotals(draft.usage);
  const formatTokens = (value: number | null) => value === null ? "未完整回报" : value.toLocaleString();
  const incomplete = draft.messages.filter(
    (m) => m.role === "user" && !m.final,
  ).length;
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
    onLock(active || Boolean(draft.source) || reviewing || recordingBusy || recordingUnsaved);
    onActive(active || reviewing || recordingBusy || recordingUnsaved);
    if(active){setPreflightOpen(false);requestAnimationFrame(()=>document.querySelector('.live-call-room')?.scrollIntoView({block:'start'}));}
  }, [active, reviewing, recordingBusy, recordingUnsaved, draft.source, onLock, onActive]);
  useEffect(
    () => () => {
      onLock(false);
      onActive(false);
    },
    [onLock, onActive],
  );
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
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [draft.messages]);
  useEffect(() => {
    if (!active && !reviewing && !recordingBusy && !recordingUnsaved) return;
    setNavigationGuard(() => {
      if (recordingBusy) { setError('录音正在保存，请稍候再离开。'); return false; }
      return window.confirm(recordingUnsaved ? '录音尚未完整保存，请先下载临时录音。确定离开并放弃临时副本吗？' : '离开会结束实时通话或取消复盘请求。已收到的文字保留，通话录音会在本机收尾保存。是否离开？');
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
  }, [active, reviewing, recordingBusy, recordingUnsaved]);
  async function start() {
    if (active || reviewing || recordingBusy || recordingUnsaved) return;
    setError("");
    const current = draft.source || source;
    if (current.resume.trim().length < 20 || current.job.trim().length < 20) {
      setError("请先在上方上传或填写至少 20 字的简历和 JD。");
      return;
    }
    if (!consent) {
      setError("请先确认实时服务的数据发送和计费说明。");
      return;
    }
    if (!configured) {
      setError("请先展开 LIVE 服务配置，保存后重新检查。");
      return;
    }
    if (!trialReady) { setError(trialMessage); return; }
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
  async function review() {
    if (reviewing) return;
    if (active) { setError('请先点击“结束 / 暂停通话”，再生成 AI 面试复盘。'); return; }
    if (!draft.source || !turns.length) {
      setError(
        draft.messages.some(m=>m.role==='user'&&m.final&&m.text.trim()) ? "回答内容太少，暂时无法生成面试复盘。请至少完成 1 题、回答 5 个有效字，并确认对应的问题。" : "请先完成至少一个有明确问题的回答。未完成转写可以在下方补充并确认。",
      );
      return;
    }
    if (incomplete) {
      setError("还有未完成的转写，请先核对并确认这些回答，避免漏评。");
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
      const complete = { ...snapshot, report };
      update({ report });
      const prior = readSaved().filter((v) => v.draft.id !== snapshot.id);
      if (prior.length >= 20)
        throw Error(
          "复盘已显示，但本机已有 20 轮复盘，请先导出或删除旧记录后重试保存。",
        );
      const next = [
        { time: new Date().toISOString(), draft: complete },
        ...prior,
      ];
      localStorage.setItem(historyKey, JSON.stringify(next));
      setSaved(next);
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
    if (
      draft.messages.length &&
      !window.confirm(
          "开始新一轮？当前未存入复盘的对话将清空，已保存的录音和复盘仍保留。可先导出本轮文字。",
      )
    )
      return;
    live.stop();
    setDraft(blank());
    setError("");
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
    <section className="interview-panel live-panel">
      <div className="interview-heading">
        <div>
          <h2>LIVE 面试室</h2>
        </div>
        <span className={`live-badge ${active ? "is-active" : ""}`}>
          {labels[live.state]}
        </span>
      </div>
      {!active && <p>
        面试官根据简历和 JD
        提问，你直接开口回答。可插话追问，也可以说“请再说一遍”。结束后由当前配置的
        AI 点评服务生成复盘。
      </p>}
      <LiveCallStage state={live.state} label={labels[live.state]} muted={live.muted} elapsed={clock(elapsed)} limit={clock(draft.minutes*60)} role={draft.source?.role || source.role} question={[...draft.messages].reverse().find(m=>m.role==='assistant'&&!m.interrupted)?.text || ''}/>
      <details className="live-preflight" hidden={active} open={preflightOpen} onToggle={e=>setPreflightOpen(e.currentTarget.open)}>
      <summary>通话设置与资料 · {draft.minutes} 分钟 · {configured ? '实时服务已配置' : '请先配置实时服务'}</summary>
      {!active && !reviewing && (
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
      <p className="live-cost" role="status">仅免费额度试用 · {trialMessage}</p>
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
      <label className="live-consent" hidden={active}>
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
      <div className="interview-controls live-call-controls">
        {!active ? (
          <button
            className="button primary"
            disabled={reviewing || recordingBusy || recordingUnsaved}
            onClick={() => void start()}
          >
            {draft.source ? "重新连接 / 继续本轮" : "开始 LIVE 面试"}
          </button>
        ) : (
          <>
            <button
              className="button secondary"
              disabled={live.state === "connecting"}
              onClick={live.interrupt}
            >
              打断面试官
            </button>
            <button
              className="button secondary"
              disabled={live.state === "connecting"}
              onClick={live.mute}
            >
              {live.muted ? "开启麦克风" : "麦克风静音"}
            </button>
            <button
              className="button secondary"
              data-action="end-call"
              onClick={() =>
                live.stop(
                  "已断开实时连接。已收到的文字保留，可继续本轮或生成复盘。",
                )
              }
            >
              结束 / 暂停通话
            </button>
          </>
        )}
        {live.audioBlocked && (
          <button
            className="button secondary"
            onClick={() => void live.playAudio()}
          >
            开启面试官声音
          </button>
        )}
      </div>
      <LiveRecordings roundId={draft.id} state={live.recording} active={active || reviewing} reviews={saved.map(s=>s.draft.id)} onRetry={()=>void live.retryRecordingSave()} onDiscard={live.discardTemporaryRecording} onReview={id=>{
        const match=saved.find(s=>s.draft.id===id);
        if(match && (id===draft.id || window.confirm('查看对应复盘会替换当前文字草稿，已保存的录音不受影响。是否继续？'))) {
          setDraft(match.draft);setError('');requestAnimationFrame(()=>document.querySelector('.live-report')?.scrollIntoView({block:'start'}));
        }
      }}/>
      <p className="live-cost">
        重连继续累计本轮时长；到时自动结束。
        {draft.tokens
          ? `服务已回报 ${draft.tokens.toLocaleString()} tokens（未包含所有可能费用）。`
          : "服务尚未回报用量。"}{" "}
        实际扣费以服务商账单为准。
      </p>
      <details className="live-usage"><summary>本轮实际回报用量 · {draft.usage.length} 条响应记录</summary>
        <table><thead><tr><th>类型</th><th>输入 tokens</th><th>输出 tokens</th></tr></thead><tbody>
          <tr><th>文字</th><td>{formatTokens(totals.inputText)}</td><td>{formatTokens(totals.outputText)}</td></tr>
          <tr><th>音频</th><td>{formatTokens(totals.inputAudio)}</td><td>{formatTokens(totals.outputAudio)}</td></tr>
          <tr><th>全部输入 / 输出</th><td>{formatTokens(totals.input)}</td><td>{formatTokens(totals.output)}</td></tr>
        </tbody></table>
        <p>这些数字来自模型响应，不是计费预测。包含上下文重复计入的用量；断线、取消或结束时尚未回报的响应可能不完整。未回报显示为未知，不当作零消耗。</p>
        <button className="text-button" onClick={downloadUsage}>导出本轮用量 JSON</button>
      </details>
      <div className="live-transcript-heading">
        <h3>实时对话文字</h3>
        <button className="text-button" onClick={download}>
          导出本轮文字
        </button>
      </div>
      <div
        className="live-transcript"
        ref={log}
        role="log"
        aria-label="面试对话文字"
        aria-live="polite"
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
              <small>{m.interrupted ? " · 已打断，不作为完整问题评分" : !m.final ? " · 转写未确认" : ""}</small>
            </strong>
            {!active && m.role === "user" ? (
              <>
                <textarea
                  aria-label={`第 ${i + 1} 条回答文字`}
                  disabled={reviewing}
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
                <button className="text-button" disabled={reviewing||!m.text.trim()} onClick={()=>{const after=punctuateAnswer(m.text);if(after===m.text)return;setPunctuationUndo(v=>({...v,[m.id]:{before:m.text,after,final:m.final}}));update({messages:draft.messages.map(v=>v.id===m.id?{...v,text:after,final:false}:v),report:null});}}>补充这段标点</button>
                {punctuationUndo[m.id]?.after===m.text && <button className="text-button" disabled={reviewing} onClick={()=>{const prior=punctuationUndo[m.id];update({messages:draft.messages.map(v=>v.id===m.id?{...v,text:prior.before,final:prior.final}:v),report:null});setPunctuationUndo(v=>{const next={...v};delete next[m.id];return next;});}}>撤销这段标点</button>}
                {!m.final && (
                  <button
                    className="text-button"
                    disabled={reviewing || !m.text.trim()}
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
        通话结束后可以回放上方录音、修正识别错误，不必重写回答。断线前已录下的声音会保留；断线期间未收到的声音无法补回。
      </p>
      <div className="interview-review-status" aria-live="polite"><strong>至少 1 题即可生成复盘</strong><p>{active ? '先结束通话，再生成复盘；无需达到 10 分钟。' : incomplete ? `还有 ${incomplete} 段转写未确认，请在回答下方核对并确认。` : reviewReadiness(turns).message}</p><small>每题至少 5 个有效字；无需回答得好。证据不足的维度会标注“证据不足”，不会编造评分。</small></div>
      <div className="interview-controls">
        <button
          className="button primary"
          disabled={reviewing}
          onClick={() => void review()}
        >
          {reviewing ? "正在生成 AI 复盘…" : "生成 AI 面试复盘"}
        </button>
        <button
          className="button secondary"
          disabled={active || reviewing || recordingBusy || recordingUnsaved}
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
        <div className="live-report">
          <h3>本轮 AI 面试复盘</h3>
          <p>{draft.report.summary}</p>
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
        </div>
      )}
      {saved.length > 0 && (
        <div className="live-history">
          <h3>已保存的 LIVE 复盘</h3>
          {saved.map((s) => (
            <div className="interview-history" key={s.draft.id}>
              <button
                className="text-button"
                disabled={active || reviewing || recordingBusy || recordingUnsaved}
                onClick={() => {
                  if (
                    window.confirm("查看复盘会替换当前 LIVE 草稿，是否继续？")
                  ) {
                    setDraft(s.draft);
                    setError("");
                  }
                }}
              >
                {s.draft.source?.role || "模拟面试"} ·{" "}
                {new Date(s.time).toLocaleString("zh-CN")}
              </button>
              <button
                className="text-button"
                disabled={active || reviewing}
                onClick={() => {
                  if (!window.confirm("删除这条 LIVE 复盘？")) return;
                  const next = saved.filter((v) => v.draft.id !== s.draft.id);
                  try {
                    localStorage.setItem(historyKey, JSON.stringify(next));
                    setSaved(next);
                  } catch {
                    setError("删除失败，请检查本机存储。");
                  }
                }}
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
