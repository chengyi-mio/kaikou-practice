import { useEffect, useRef, useState } from "react";
import { AIRecovery } from "./AIRecovery";
import { go } from "./components";
import { InterviewNextSteps } from "./InterviewJourney";
import type { InterviewReport } from "./interviewTraining";
import { reviewReadiness } from "../server/interview-readiness.mjs";
import { deleteInterviewRecord, updateInterviewRecord, validInterviewReport } from "./interviewRecords";
import type { InterviewRecord } from "./interviewRecords";
import { deleteRecording, listRecordings, recordingBlob, recordingFilename } from "./liveRecordingStore";
import type { LiveRecording } from "./liveRecordingStore";
import { usageTotals } from "./liveUsage.mjs";

function downloadFile(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function SavedUsage({ record }: { record: InterviewRecord }) {
  const totals = usageTotals(record.usage || []);
  const format = (value: number | null) => value === null ? "未完整回报" : value.toLocaleString();
  return <details className="record-disclosure live-usage"><summary>本轮实际回报用量</summary>
    <p>已回报 {record.tokens || 0} tokens；明细缺失不代表零消耗。实际扣费以服务商账单为准。</p>
    <table><thead><tr><th>类型</th><th>输入 tokens</th><th>输出 tokens</th></tr></thead><tbody>
      <tr><th>文字</th><td>{format(totals.inputText)}</td><td>{format(totals.outputText)}</td></tr>
      <tr><th>音频</th><td>{format(totals.inputAudio)}</td><td>{format(totals.outputAudio)}</td></tr>
      <tr><th>全部输入 / 输出</th><td>{format(totals.input)}</td><td>{format(totals.output)}</td></tr>
    </tbody></table>
    <p>数字来自模型响应。断线、取消或结束时尚未回报的响应可能不完整，未完整回报显示为未知。</p>
    <button className="text-button" onClick={() => downloadFile(JSON.stringify({ schema: "kaikou.live.usage.v1", id: record.id, exportedAt: new Date().toISOString(), elapsedSeconds: record.elapsed || 0, reportedTotalTokens: record.tokens || 0, totals, responses: record.usage || [], billing: { status: "not_verified", note: "仅记录服务回报。免费额度扣减与实际账单需在控制台核对，未完成响应可能尚未计入。" } }, null, 2), `LIVE用量-${record.id.slice(0, 8)}.json`, "application/json")}>导出本轮用量 JSON</button>
  </details>;
}

function SavedAudio({ record }: { record: LiveRecording }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  async function load(download: boolean) {
    setBusy(true); setError("");
    try {
      const blob = await recordingBlob(record);
      if (!alive.current) return;
      const next = URL.createObjectURL(blob);
      if (download) {
        const link = document.createElement("a"); link.href = next; link.download = recordingFilename(record); link.click();
        setTimeout(() => URL.revokeObjectURL(next), 1000);
      } else setUrl(next);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "无法读取录音，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  }
  return <article className="saved-interview-audio">
    <div><strong>{record.role || "模拟面试"} · 双方通话</strong><p>{new Date(record.createdAt).toLocaleString("zh-CN")} · {Math.floor(record.duration / 60)}:{String(Math.floor(record.duration % 60)).padStart(2, "0")}{record.status !== "saved" ? " · 中断保留" : ""}</p></div>
    <div className="record-inline-actions"><button className="button secondary" disabled={busy} onClick={() => void load(false)}>回放录音</button><button className="text-button" disabled={busy} onClick={() => void load(true)}>下载录音</button><button className="text-button" disabled={busy} onClick={async () => {
      if (!window.confirm("删除这段本机录音？对话文字、AI 复盘和已下载的副本仍保留。")) return;
      setBusy(true); setError("");
      try { await deleteRecording(record.id); }
      catch { if (alive.current) setError("录音删除失败，请重试。"); }
      finally { if (alive.current) setBusy(false); }
    }}>删除录音</button></div>
    {url && <audio controls src={url} preload="metadata" aria-label="保存的双方通话录音" />}
    {error && <p role="alert">{error}</p>}
  </article>;
}

export function InterviewRecordings({ roundId }: { roundId?: string }) {
  const [records, setRecords] = useState<LiveRecording[]>([]);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => { void listRecordings().then(value => { if (alive) { setRecords(value); setError(""); } }).catch(() => { if (alive) setError("无法读取本机录音，请重新读取。"); }); };
    load(); window.addEventListener("kaikou-live-recordings-changed", load);
    return () => { alive = false; window.removeEventListener("kaikou-live-recordings-changed", load); };
  }, [refresh]);
  const visible = records.filter(record => !roundId || record.roundId === roundId);
  return <section className="saved-interview-recordings" aria-label={roundId ? "本轮双方录音" : "全部 LIVE 录音"}>
    {error ? <p role="alert">{error} <button className="text-button" onClick={() => setRefresh(n => n + 1)}>重新读取录音</button></p> : visible.length ? visible.map(record => <SavedAudio key={record.id} record={record} />) : <p>没有找到{roundId ? "本轮的" : "已保存的"}双方录音。未录制的旧通话无法补回。</p>}
  </section>;
}

export function InterviewRecordDetail({ record, onChanged }: { record: InterviewRecord; onChanged: () => void }) {
  const [report, setReport] = useState<InterviewReport | null>(record.report);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [unsaved, setUnsaved] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  function save(reportToSave: InterviewReport) {
    try { updateInterviewRecord(record, reportToSave); setUnsaved(false); setError(""); setNotice("AI 复盘已更新到这条历史记录，当前练习草稿未改动。"); onChanged(); }
    catch (e) { setUnsaved(true); setError(`复盘已生成，但未保存：${e instanceof Error ? e.message : "请检查本机存储。"}`); }
  }
  async function review() {
    if (request.current) return;
    setError(""); setNotice("");
    const readiness = reviewReadiness(record.turns);
    if (!readiness.ready) { setError(readiness.message); return; }
    if (!record.source || record.source.resume.trim().length < 20 || record.source.job.trim().length < 20) { setError("这条历史记录的简历或岗位资料不完整，无法重新点评。请在新一轮面试中补充资料；原记录仍保留。"); return; }
    if (record.messages?.some(m => m.role === "user" && m.text.trim() && !m.final)) { setError("历史对话包含尚未确认的转写，暂不重新点评，避免遗漏。原复盘仍保留。"); return; }
    const controller = new AbortController(); request.current = controller; setBusy(true);
    try {
      const response = await fetch(record.kind === "live" ? "/api/realtime/review" : "/api/interview", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "feedback", ...record.source, history: record.turns }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(100000)]),
      });
      const result: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) throw Error(result && typeof result === "object" && "error" in result ? String(result.error) : "AI 复盘失败，请重试。原复盘仍保留。");
      if (!validInterviewReport(result)) throw Error("AI 返回的复盘格式不完整，请重试。原复盘仍保留。");
      setReport(result); save(result);
    } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error && e.name !== "TimeoutError" ? e.message : "AI 复盘请求超时，请重试。文字和原复盘仍保留。"); }
    finally { if (request.current === controller) request.current = null; if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="interview-record-detail" aria-label="历史面试详情">
    <button className="text-button" onClick={() => go("/history?type=interview")}>返回面试记录</button>
    <div className="record-detail-title"><h1>{record.source?.role || "模拟面试"} · {record.kind === "live" ? "LIVE" : "逐题面试"}</h1><p>{record.time ? new Date(record.time).toLocaleString("zh-CN") : "日期未记录"} · {record.turns.length} 题</p></div>
    <p className="record-context-note">正在查看历史记录，当前面试草稿保持不变。重新点评只使用这条记录保存的资料与回答。</p>
    <div className="record-review-actions"><AIRecovery disabled={busy} onReady={() => void review()} checkLabel={busy ? "正在生成 AI 面试复盘…" : error && !unsaved ? "重试 AI 面试复盘" : "重新生成 AI 面试复盘"} />{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{unsaved && report && <button className="button secondary" onClick={() => save(report)}>重试保存复盘</button>}</div>
    {report ? <section className="saved-interview-review" aria-label="已保存的 AI 复盘"><h2>这次的重点</h2><p>{report.summary}</p><p>{report.nextStep}</p>
      {report.dimensions.length > 0 && <details className="record-disclosure"><summary>展开各维度分析 · {report.dimensions.length} 项</summary><div className="saved-review-dimensions">{report.dimensions.map((d, index) => <section key={`${d.name}-${index}`}><h3>{d.name} <span>{d.score === null ? "无可显示的分值" : `${d.score} / 5`}</span></h3>{d.evidence && <blockquote>{d.evidence}</blockquote>}<p>{d.advice}</p></section>)}</div></details>}
      {record.source && <InterviewNextSteps source={record.source} turns={record.turns} report={report} origin={record.kind} disabled={busy || unsaved} />}
    </section> : <p>这条记录尚无可显示的 AI 复盘，可重新生成。</p>}
    <details className="record-disclosure"><summary>查看本轮问答 · {record.turns.length} 题</summary><button className="text-button" onClick={() => {
      const transcript = record.messages ? record.messages.map(m => `${m.role === "user" ? "我" : "面试官"}${m.interrupted ? "（已打断）" : !m.final ? "（转写未确认）" : ""}：${m.text}`).join("\n\n") : record.turns.map((t, i) => `第 ${i + 1} 题：${t.question}\n我的回答：${t.answer}`).join("\n\n");
      downloadFile(`开口练习 · ${record.source?.role || "模拟面试"}\n\n${transcript}\n\n复盘：${report ? JSON.stringify(report, null, 2) : "尚无复盘"}`, `面试记录-${record.id.slice(0, 8)}.txt`, "text/plain;charset=utf-8");
    }}>导出本轮文字</button>{record.messages ? record.messages.map(m => <section className="saved-question" key={m.id}><h3>{m.role === "user" ? "我" : "面试官"}{m.interrupted ? " · 已打断" : !m.final ? " · 转写未确认" : ""}</h3><p>{m.text}</p></section>) : record.turns.map((turn, index) => <section className="saved-question" key={index}><h3>第 {index + 1} 题 · {turn.question}</h3><p>{turn.answer}</p></section>)}</details>
    {record.kind === "live" && <details className="record-disclosure"><summary>本轮通话录音 · 回放与下载</summary><InterviewRecordings roundId={record.id} /></details>}
    {record.kind === "live" && <SavedUsage record={record} />}
    <details className="record-disclosure"><summary>本轮使用的面试资料</summary>{record.source ? <><h3>简历</h3><p className="record-source-text">{record.source.resume}</p><h3>岗位要求</h3><p className="record-source-text">{record.source.job}</p>{record.source.project && <><h3>项目素材</h3><p className="record-source-text">{record.source.project}</p></>}</> : <p>这条历史记录没有完整保存资料。</p>}</details>
    <details className="record-disclosure record-management"><summary>记录管理</summary><button className="text-button" disabled={busy || unsaved} onClick={() => {
      if (!window.confirm("删除这条历史面试记录？当前面试草稿、专项训练和通话录音仍保留。")) return;
      try { deleteInterviewRecord(record); onChanged(); go("/history?type=interview"); }
      catch { setError("删除记录失败，请检查存储后重试。"); }
    }}>删除这条面试记录</button></details>
  </section>;
}
