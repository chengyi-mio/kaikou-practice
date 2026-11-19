import { useEffect, useId, useState } from "react";
import { ArrowRight, ArrowUpRight, CheckCircle } from "@phosphor-icons/react";
import { AudioPlayer, Report, go } from "./components";
import { AttemptComparison } from "./ScenarioReport";
import { generateFollowup } from "./api";
import { findPauses, type Pause } from "./audioInsights";
import { deliveryMetrics, timeForEvidence } from "./deliveryMetrics";
import { speakQuestion } from "./voicePrompt";
import type { Session } from "./types";
import { InterviewReturn } from './InterviewJourney';
import "./expression-disclosure.css";

export function PracticeNext({
  session,
  disabled = false,
}: {
  session: Session;
  disabled?: boolean;
}) {
  const tasks = session.feedback?.improvements.slice(0, 2) || [];
  const [selected, setSelected] = useState(0);
  const [followup, setFollowup] = useState("");
  const [followupBusy, setFollowupBusy] = useState(false);
  const [followupError, setFollowupError] = useState("");
  const selectedFocus = Math.min(selected, Math.max(0, tasks.length - 1));
  if (!session.feedback) return null;
  return (
    <section className="practice-next" aria-label="下一次怎么练">
      <h3>这次先改一个地方</h3>
      <p>用同一道题再说一次，练完后对照两次表达。</p>
      {selectedFocus > 0 && <p>本次选择：{tasks[selectedFocus]}</p>}
      {tasks.length > 1 && (
        <details className="expression-disclosure next-options">
        <summary>更换练习重点</summary>
        <fieldset>
          <legend>下一次的练习重点</legend>
          {tasks.map((task, i) => (
            <label key={i}>
              <input
                type="radio"
                name={`focus-${session.id}`}
                checked={selectedFocus === i}
                onChange={() => setSelected(i)}
              />
              <span>{task}</span>
            </label>
          ))}
        </fieldset>
        </details>
      )}
      {session.feedback.rewrite && (
        <details className="next-example expression-disclosure">
          <summary>
            参考表达 ·{" "}
            {session.feedback.rewrite.length > 180 ? "节选" : "仅供参考"}
          </summary>
          <blockquote>
            {session.feedback.rewrite.length > 180
              ? `${session.feedback.rewrite.slice(0, 180)}…`
              : session.feedback.rewrite}
          </blockquote>
          <small>示例是提示，不必逐字照读；事实需自己确认</small>
        </details>
      )}
      <button
        className="button primary"
        disabled={disabled}
        onClick={() =>
          go(
            `/practice/${session.mode}?retry=${encodeURIComponent(session.id)}&focus=${selectedFocus}${session.thinkingModelId ? `&thinking=${encodeURIComponent(session.thinkingModelId)}` : ""}`,
          )
        }
      >
        针对这一点再练 <ArrowRight size={18} />
      </button>
      <small className="next-duration">
        同题再练 {session.targetDuration || 60} 秒 · 两次练习分别保存
      </small>
      {session.feedback.source === "ai" && Boolean(session.transcript) && (
        <details className="followup-card expression-disclosure">
          <summary>{session.followupOf ? "继续模拟对话" : "开始模拟对话"} · 下一轮</summary>
          <p>让 AI 扮演听众，结合之前的回答继续追问。可以朗读问题并录音作答，每一轮分别保存。</p>
          {!followup ? (
            <button className="button secondary" disabled={disabled || followupBusy} onClick={async () => {
              setFollowupBusy(true);
              setFollowupError("");
              try { setFollowup(await generateFollowup(session)); }
              catch (error) { setFollowupError((error as Error).message); }
              finally { setFollowupBusy(false); }
            }}>{followupBusy ? "正在生成追问…" : "生成听众追问"}</button>
          ) : (
            <><blockquote>{followup}</blockquote><button className="text-button" onClick={() => speakQuestion(followup)}>朗读问题</button><button className="button secondary" disabled={disabled} onClick={() => go(`/practice/${session.mode === "logic" ? "logic" : "improv"}?followup=${encodeURIComponent(session.id)}&question=${encodeURIComponent(followup)}`)}>录音回答这个问题 <ArrowRight size={16} /></button></>
          )}
          {followupError && <p role="alert">{followupError}</p>}
        </details>
      )}
      {disabled && (
        <p className="next-disabled">
          先保存本次点评或文字修改，再开始下一次。
        </p>
      )}
    </section>
  );
}

export function FeedbackReview({
  session,
  disabled = false,
  onEdit,
  onViewTranscript,
}: {
  session: Session;
  disabled?: boolean;
  onEdit?: () => void;
  onViewTranscript?: () => void;
}) {
  const id = useId();
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [seekTo, setSeekTo] = useState<{ time: number; nonce: number }>();
  const feedback = session.feedback;
  if (!feedback) return null;
  const target =
    feedback.checks?.find((c) => c.id === feedback.practiceTarget) ||
    feedback.checks?.find((c) => c.outcome === "needs_work");
  const dimension =
    feedback.dimensions.find(
      (d) => d.status === "partial" || d.status === "missing",
    ) || feedback.dimensions.find((d) => d.advice);
  const priority =
    feedback.improvements[0] || target?.task || dimension?.advice;
  const evidence = [
    ...new Set([
      ...(target?.evidence ? [target.evidence] : []),
      ...(dimension?.evidence || []),
      ...feedback.dimensions.flatMap((d) => d.evidence || []),
      ...(feedback.checks?.map((c) => c.evidence).filter(Boolean) || []),
    ]),
  ].slice(0, 1);
  const strengths = feedback.dimensions
    .filter((d) => d.status === "good")
    .map((d) => d.text);
  const clearChecks =
    feedback.checks?.filter((c) => c.outcome === "clear").map((c) => c.text) ||
    [];
  const keep = [...strengths, ...clearChecks].filter(Boolean).slice(0, 2);
  function showSection(name: string) {
    if (name === "transcript" && onViewTranscript) {
      onViewTranscript();
      return;
    }
    const element = document.getElementById(`${id}-${name}`);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  }
  return (
    <div className="feedback-redesign feedback-simplified">
      <div className="feedback-coaching-grid" id={`${id}-feedback`}>
        <div className="feedback-coaching-content">
          <section className="feedback-priority">
            <span className="feedback-chip">
              {priority ? "本轮只改这一点" : "回顾这一次表达"}
            </span>
            <h2>{priority || feedback.summary}</h2>
            {priority && feedback.summary !== priority && <p>{feedback.summary}</p>}
            {!feedback.summary && (target?.text || dimension?.text) && (
              <p className="feedback-grounding">
                {target?.text || dimension?.text}
              </p>
            )}
          </section>
          <section className="feedback-evidence">
            <h3>从你的表达里看到的</h3>
            {evidence.length ? (
              evidence.map((quote, i) => {
                const time = session.audio ? timeForEvidence(quote, session.transcript, session.transcriptSegments, session.transcriptWords) : undefined;
                return <blockquote key={i}>{quote}{time !== undefined && <button className="text-button evidence-seek" onClick={() => setSeekTo({ time, nonce: Date.now() })}>从 {time.toFixed(1)} 秒处听原话</button>}</blockquote>;
              })
            ) : (
              <p className="feedback-empty-evidence">
                这份反馈没有定位到相关原话。可以回看完整文字，结合实际沟通目的判断。
              </p>
            )}
            {Boolean(session.audio && session.transcriptSegments?.length) && <AudioPlayer blob={session.audio} seekTo={seekTo} />}
            <button
              className="text-button"
              onClick={() => showSection("transcript")}
            >
              查看我的完整表达 <ArrowUpRight size={15} />
            </button>
          </section>
        </div>
        {session.interviewTaskId ? <InterviewReturn session={session} disabled={disabled} /> : <PracticeNext session={session} disabled={disabled} />}
      </div>
      <footer className="feedback-model-footer">
        <span className="feedback-chip">
          {feedback.source !== "ai"
            ? "基础反馈 · 非 AI 点评"
            : feedback.provider === "agnes"
            ? "AI 点评 · Agnes"
            : feedback.provider === "jev"
              ? "AI 点评 · Jev"
              : feedback.source === "ai"
                ? "AI 表达反馈"
                : "基础反馈 · 非 AI 点评"}
        </span>
        <span>
          {feedback.profileName
            ? `依据：${feedback.profileName}`
            : "根据本次表达文字生成"}
        </span>
      </footer>
      <details id={`${id}-analysis`} className="feedback-full-analysis expression-disclosure" onToggle={event => setAnalysisOpen(event.currentTarget.open)}>
        <summary>查看详细分析 <span>{feedback.dimensions.length} 个维度 · 完整建议</span></summary>
        {keep.length > 0 && <section className="feedback-strengths"><h3><CheckCircle size={19} />值得保留</h3>{keep.map((text, i) => <p key={i}>{text}</p>)}</section>}
        {analysisOpen && <><AudioObservations session={session} /><Report feedback={feedback} /></>}
        <button className="text-button" onClick={() => go("/settings")}>查看 AI 服务设置 <ArrowRight size={15} /></button>
      </details>
      {!onViewTranscript && (
        <details
          id={`${id}-transcript`}
          className="feedback-transcript reference-details expression-disclosure"
        >
          <summary>原文与录音</summary>
          <p>{session.transcript || "这条练习暂无转写文字。"}</p>
          <AudioPlayer blob={session.audio} />
          {session.preparationDraft && (
            <details>
              <summary>准备时的提纲</summary>
              <p>{session.preparationDraft}</p>
            </details>
          )}
          {onEdit && (
            <button
              className="button secondary"
              disabled={disabled}
              onClick={onEdit}
            >
              修改文字，再获取反馈
            </button>
          )}
        </details>
      )}
      {session.previousAttempt && <details id={`${id}-comparison`} className="feedback-comparison-section expression-disclosure">
        <summary>同题对比 <span>查看两次表达的变化</span></summary>
          <AttemptComparison session={session} />
      </details>}
    </div>
  );
}

function AudioObservations({ session }: { session: Session }) {
  const [pauses, setPauses] = useState<Pause[] | null>(null);
  useEffect(() => {
    let live = true;
    setPauses(null);
    if (session.audio) void findPauses(session.audio).then((value) => { if (live) setPauses(value); }).catch(() => { if (live) setPauses([]); });
    return () => { live = false; };
  }, [session.audio]);
  if (!session.audio || !session.feedback) return null;
  const { fillers } = session.feedback.metrics;
  const timed = deliveryMetrics(session.transcript, session.transcriptSegments, session.transcriptWords);
  return <section className="audio-observations" aria-label="录音与文字观察">
    <h3>录音与文字观察</h3>
    <div><span><strong>{session.duration}</strong> 秒录音</span><span><strong>{timed?.charactersPerMinute ?? "—"}</strong> 识别片段字/分钟</span><span><strong>{fillers}</strong> 处常见填充词</span></div>
    {timed ? <p>转写时间戳显示约 {timed.voicedSeconds} 秒的识别片段，{timed.pauses.length} 段 0.8 秒以上的片段间停顿{timed.pauses.length ? `（${timed.pauses.slice(0, 4).map((gap) => `${gap.start.toFixed(1)} 秒处`).join("、")}）` : ""}。</p> : pauses && <p>{pauses.length ? `音量检测到 ${pauses.length} 段较长低音量间隔。` : "暂无可确认的段间停顿数据。"}重新使用支持时间戳的语音转写，可获得更可靠的定位。</p>}
    <small>{timed ? "语速基于转写文本和分段时间戳；原话定位优先使用词级时间戳。识别边界仍可能有误差。" : "没有可信的转写时间戳时不计算语速；低音量可能是环境变化，并不等于真实停顿。"}填充词可能有正常含义，请回听核对；这里不评价情绪或声音质量。</small>
  </section>;
}

export function AnalysisProgress({ message }: { message: string }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="analysis-progress" role="status">
      <strong>{message}</strong>
      <p>
        {seconds < 20
          ? "正在等待处理结果，请勿重复提交。"
          : "还在等待服务返回；耗时较长不代表内容丢失。"}{" "}
        已等待 {seconds} 秒。
      </p>
      <small>完成后会自动显示；如失败，可保留内容重试。</small>
    </div>
  );
}
