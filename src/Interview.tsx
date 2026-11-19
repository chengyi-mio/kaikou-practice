import { useEffect, useRef, useState } from "react";
import { BottomNav, go, setNavigationGuard } from "./components";
import { ArrowLeft, SpeakerHigh } from '@phosphor-icons/react';
import { useRecorder } from "./useRecorder";
import { transcribeDetailed } from "./api";
import { speakQuestion } from "./voicePrompt";
import { LiveInterview } from "./LiveInterview";
import { punctuateAnswer } from "./interviewPunctuation.mjs";
import { answerCharacters, reviewReadiness } from "../server/interview-readiness.mjs";
import "./interview.css";
import { InterviewNextSteps } from './InterviewJourney';
import { interviewStages } from './interviewTraining';
import type { InterviewSource } from './interviewTraining';
import { ProjectStories } from './ProjectStories';
import './interview-disclosure.css';
import { saveInterviewReport } from './interviewReportStorage';
import type { PendingInterviewReportSave } from './interviewReportStorage';

type Turn = { question: string; answer: string };
type Dimension = { name: string; score: number | null; evidence: string; advice: string };
type Report = { summary: string; dimensions: Dimension[]; nextStep: string };
type Draft = InterviewSource & { question: string; answer: string; turns: Turn[]; report: Report | null; pendingReport?: PendingInterviewReportSave };
type Saved = { id: string; time: string; draft: Draft };
const draftKey = "kaikou.interview.draft.v1";
const historyKey = "kaikou.interview.history.v1";
const blank: Draft = { role: "", resume: "", job: "", question: "", answer: "", turns: [], report: null };

function readDraft(): Draft {
  try { const value = JSON.parse(localStorage.getItem(draftKey) || "null"); return value && typeof value.resume === "string" && Array.isArray(value.turns) ? { ...blank, ...value } : blank; } catch { return blank; }
}
function readHistory(): Saved[] {
  try { const value = JSON.parse(localStorage.getItem(historyKey) || "[]"); return Array.isArray(value) ? value.filter((item) => item?.id && item?.draft?.report) : []; } catch { return []; }
}
async function extractDocument(file: File): Promise<string> {
  if (file.size > 5 * 1024 * 1024) throw Error("文件超过 5 MB，请选择更小的文件。");
  const extension = file.name.toLowerCase().split(".").pop();
  let text = "";
  if (extension === "txt" || extension === "md") text = await file.text();
  else if (extension === "docx") {
    const mammoth = await import("mammoth/mammoth.browser");
    text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
  } else if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist");
    const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
    const pdf = await task.promise;
    if (pdf.numPages > 30) { await task.destroy(); throw Error("PDF 超过 30 页，请精简后上传。"); }
    try {
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const content = await (await pdf.getPage(n)).getTextContent();
        pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
      }
      text = pages.join("\n");
    } finally { await task.destroy(); }
  } else throw Error("请使用 PDF、DOCX 或 TXT 文件。旧版 DOC 和图片暂不支持。");
  text = text.trim();
  if (text.length < 20) throw Error("没有读取到足够的文字。扫描版 PDF 暂不支持，请复制文字粘贴或使用可选中文字的文件。");
  return text;
}

export function Interview() {
  const [mode, setMode] = useState<"turn" | "live">(() => { try { return localStorage.getItem('kaikou.interview.mode') === 'live' ? 'live' : 'turn'; } catch { return 'turn'; } });
  const [modeNotice, setModeNotice] = useState('');
  const [materialsExpanded, setMaterialsExpanded] = useState(()=>{try{const source=mode==='turn'?readDraft():(JSON.parse(localStorage.getItem('kaikou.live-interview.draft.v1')||'null')?.source||JSON.parse(localStorage.getItem('kaikou.live-interview.preparation.v1')||'null')||readDraft());return !source.resume?.trim()||!source.job?.trim();}catch{return true;}});
  const [reviewNotice, setReviewNotice] = useState('');
  const [punctuationUndo, setPunctuationUndo] = useState<{before:string;after:string} | null>(null);
  const [punctuationNotice, setPunctuationNotice] = useState('');
  const [liveLocked, setLiveLocked] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  const [livePendingReport, setLivePendingReport] = useState(false);
  useEffect(()=>{if(liveActive)setMaterialsExpanded(false);},[liveActive]);
  const [draft, setDraft] = useState<Draft>(readDraft);
  const [reportExpanded, setReportExpanded] = useState(() => Boolean(readDraft().report));
  const [liveSource, setLiveSource] = useState<InterviewSource>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kaikou.live-interview.draft.v1") || "null")?.source || JSON.parse(localStorage.getItem("kaikou.live-interview.preparation.v1") || "null");
      if (saved && [saved.role, saved.resume, saved.job].every((v) => typeof v === "string")) return saved as InterviewSource;
    } catch { /* use current materials only, never previous answers */ }
    return { role: draft.role, resume: draft.resume, job: draft.job, stage: draft.stage, project: draft.project };
  });
  const [saved, setSaved] = useState<Saved[]>(readHistory);
  const [error, setError] = useState("");
  const [reportSaveError, setReportSaveError] = useState("");
  const [busy, setBusy] = useState("");
  const [transcribing, setTranscribing] = useState(false);
  const [playback, setPlayback] = useState("");
  const lastBlob = useRef<Blob | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  useEffect(()=>()=>requestRef.current?.abort(),[]);
  const answerRef = useRef(draft.answer);
  answerRef.current = draft.answer;
  const recorder = useRecorder(180);
  const locked = Boolean(busy || (mode === "live" ? liveLocked : draft.question || draft.turns.length));
  const update = (part: Partial<Draft>) => setDraft((previous) => ({ ...previous, ...part }));
  const preparation = mode === "live" ? liveSource : draft;
  const candidateTurns = draft.question && draft.answer.trim() ? [...draft.turns, {question:draft.question, answer:draft.answer.trim()}] : draft.turns;
  const readiness = reviewReadiness(candidateTurns);
  const reportPending = Boolean(draft.report && draft.pendingReport);
  function revealMaterials() {
    setMaterialsExpanded(true);
    requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLDetailsElement>('.interview-materials');
      if (!panel) return;
      panel.open = true;
      panel.scrollIntoView({ block: 'nearest' });
      panel.querySelector<HTMLTextAreaElement>(preparation.resume.trim().length < 20 ? 'textarea' : 'label:last-child textarea')?.focus();
    });
  }
  function changeMode(next: 'turn' | 'live') {
    if (next === mode) return;
    if (liveActive) { setModeNotice('请先结束 LIVE 通话或等待复盘完成，再切换模式。'); return; }
    if (busy || transcribing || ['recording','requesting','processing'].includes(recorder.phase)) { setModeNotice('请先结束录音并等待转写或当前请求完成，再进入另一种面试模式。'); return; }
    if ((mode === 'turn' ? reportPending : livePendingReport) && !window.confirm('本轮 AI 复盘尚未保存到历史，请先重试保存或导出本轮文字。切换后可返回当前模式继续保存；确定切换吗？')) return;
    document.querySelectorAll('audio').forEach(audio => audio.pause());
    window.speechSynthesis?.cancel();
    if(next==='live') {
      const nextSource=!liveSource.resume.trim()&&!liveSource.job.trim()?{role:draft.role,resume:draft.resume,job:draft.job,stage:draft.stage,project:draft.project}:liveSource;
      setLiveSource(nextSource);setMaterialsExpanded(!nextSource.resume.trim()||!nextSource.job.trim());
    }
    else setMaterialsExpanded(!draft.resume.trim() || !draft.job.trim());
    setMode(next);setModeNotice('');setError('');
    if(next==='live') requestAnimationFrame(()=>document.querySelector('.live-panel')?.scrollIntoView({block:'start'}));
    try { localStorage.setItem('kaikou.interview.mode',next); } catch { setModeNotice('模式偏好未能保存，本次仍可继续练习。'); }
  }
  function formatAnswer() {
    const after=punctuateAnswer(draft.answer);
    if (after===draft.answer) { setPunctuationNotice('没有发现可确定的断句位置，原文已保留，可以手动调整。'); return; }
    setPunctuationUndo({before:draft.answer,after});update({answer:after,report:null});setPunctuationNotice('已在本机补充标点，未改动用词。请核对断句，可撤销。');
  }
  const updatePreparation = (part: Partial<InterviewSource>) => mode === "live" ? setLiveSource((v) => ({ ...v, ...part })) : update(part);
  useEffect(() => {
    try { localStorage.setItem("kaikou.live-interview.preparation.v1", JSON.stringify(liveSource)); }
    catch { setError("LIVE 资料暂时无法保存，请检查本机存储。"); }
  }, [liveSource]);
  useEffect(() => {
    try { localStorage.setItem(draftKey, JSON.stringify(draft)); }
    catch { setError("面试草稿无法保存到本机，请检查存储空间。当前页面内容仍在。"); }
  }, [draft]);
  useEffect(() => {
    if (!recorder.blob) { setPlayback(""); return; }
    const url = URL.createObjectURL(recorder.blob); setPlayback(url);
    return () => URL.revokeObjectURL(url);
  }, [recorder.blob]);
  async function transcribe(blob: Blob) {
    setTranscribing(true); setError("");
    try {
      const result = await transcribeDetailed(blob);
      if (!answerRef.current.trim()) {
        const text=punctuateAnswer(result.text,result.words?.length ? result.words : result.segments);
        update({ answer: text });setPunctuationUndo(text===result.text ? null : {before:result.text,after:text});
        setPunctuationNotice('已按识别结果、停顿和语句结构整理标点；专业词与断句仍可手动核对。');
      }
      else setError("转写完成，但你已填写文字，为避免覆盖，请保留当前文字或手动修改。");
    } catch (e) { setError(`${e instanceof Error ? e.message : "转写失败"}。录音仍在，可重试转写或手动填写。`); }
    finally { setTranscribing(false); }
  }
  useEffect(() => {
    if (recorder.phase === "done" && recorder.blob && recorder.blob !== lastBlob.current) {
      lastBlob.current = recorder.blob; void transcribe(recorder.blob);
    }
  }, [recorder.phase, recorder.blob]);
  useEffect(() => {
    if (mode !== 'turn' || (!reportPending && recorder.phase !== "recording" && !recorder.blob && !transcribing)) return;
    setNavigationGuard(() => window.confirm(reportPending ? "本轮 AI 复盘尚未保存到历史，请先重试保存或导出本轮文字。离开后可返回面试草稿继续保存；若本机草稿也保存失败，关闭页面会丢失当前副本。确定离开吗？" : "离开页面后本次录音无法保留，转写文字会保存在草稿中。确定离开吗？"));
    const before = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    if (reportPending) window.addEventListener('beforeunload', before);
    return () => { setNavigationGuard(undefined); window.removeEventListener('beforeunload', before); };
  }, [mode, reportPending, recorder.phase, recorder.blob, transcribing]);
  function saveReport(complete: Draft) {
    try {
      saveInterviewReport('turn', complete);
      update({ pendingReport: undefined });
      setSaved(readHistory()); setReportSaveError('');
      setReviewNotice('复盘已保存到本机历史，可展开查看或重新生成。');
    } catch (e) {
      setReportSaveError(e instanceof Error ? e.message : '复盘保存失败，请先导出本轮文字，再重试保存。');
      setReviewNotice('AI 复盘已生成，尚未保存到历史；无需再次调用 AI。');
    }
  }
  function downloadReport() {
    const text = ['开口练习 · 逐轮模拟面试', `岗位：${draft.role || '未填写'}`, ...draft.turns.map(t => `面试官：${t.question}\n我：${t.answer}`), `复盘：${JSON.stringify(draft.report, null, 2)}`].join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `逐轮面试-${draft.pendingReport?.id.slice(0, 8) || '本轮'}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importFile(file: File | undefined, field: "resume" | "job") {
    if (!file) return;
    setError(""); setBusy("正在读取文件…");
    try {
      const text = await extractDocument(file);
      const max = field === "resume" ? 12000 : 8000;
      if (text.length > max) throw Error(`文件文字超过 ${max} 字，请精简后粘贴。`);
      updatePreparation({ [field]: text });
    } catch (e) { setError(e instanceof Error ? e.message : "文件读取失败，请粘贴文字。"); revealMaterials(); }
    finally { setBusy(""); }
  }
  async function call(action: "question" | "feedback", turns: Turn[]) {
    if(requestRef.current) return;
    if (reportPending) { setReportSaveError('本轮复盘尚未保存到历史，请先点击“重试保存复盘”或导出后开始新一轮，避免覆盖待保存结果。'); return; }
    if (draft.resume.trim().length < 20 || draft.job.trim().length < 20) { setError("请填写至少 20 个字的简历和岗位描述。您可以上传文件或直接粘贴。"); revealMaterials(); return; }
    setError(""); setBusy(action === "question" ? "面试官正在准备问题…" : "正在整理面试复盘…");
    const controller=new AbortController();requestRef.current=controller;
    try {
      const response = await fetch("/api/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, role: draft.role, resume: draft.resume, job: draft.job, stage: draft.stage, project: draft.project, history: turns }), signal: AbortSignal.any([controller.signal,AbortSignal.timeout(100000)]) });
      const data = await response.json().catch(() => ({}));
      if(controller.signal.aborted) return;
      if (!response.ok) throw Error(data.error || "请求失败，请重试。");
      if (action === "question") { update({ question: data.question, report: null }); setMaterialsExpanded(false); setReportExpanded(false); }
      else {
        const complete: Draft = { ...draft, question:'',answer:'',report: data as Report, turns, pendingReport: { id: crypto.randomUUID(), time: new Date().toISOString() } };
        update(complete);
        setReportExpanded(true);
        recorder.reset();lastBlob.current=null;setPunctuationUndo(null);
        saveReport(complete);
      }
    } catch (e) { if(!controller.signal.aborted){const message=e instanceof Error ? e.message : "请求失败，请重试。已有文字仍保留。";setError(message);if(action==='feedback')setReviewNotice(message);} }
    finally { if(requestRef.current===controller){requestRef.current=null;if(!controller.signal.aborted)setBusy("");} }
  }
  function submitAnswer() {
    if (answerCharacters(draft.answer) < 5) { setReviewNotice('回答内容太少，请至少填写 5 个有效字（不计空格和标点）。'); return; }
    if (draft.turns.length >= 8) { setError("本轮已达到 8 个回答，请先生成复盘。"); return; }
    const turns = [...draft.turns, { question: draft.question, answer: draft.answer.trim() }];
    update({ turns, question: "", answer: "", report: null });
    recorder.reset(); lastBlob.current = null; setError("");setReviewNotice('本题已保存，可以生成复盘，也可以继续下一题。');setPunctuationUndo(null);
  }
  async function requestReview() {
    if (reportPending) { setReportSaveError('AI 复盘已经生成，请点击“重试保存复盘”；保存完成后才能重新生成，避免丢失本次结果。'); return; }
    if (busy) { setReviewNotice('当前请求还在处理中，请稍候。'); return; }
    if (transcribing || ['recording','requesting','processing'].includes(recorder.phase)) { setReviewNotice('请先结束录音并等待转写完成，再生成面试复盘。'); return; }
    if (!readiness.ready) { setReviewNotice(readiness.message); return; }
    if (candidateTurns.length > 8 || candidateTurns.some(t=>t.answer.length>3000)) { setReviewNotice('本轮最多 8 题，每题最多 3000 字；请精简当前回答后再试。'); return; }
    setReviewNotice(draft.answer.trim() ? '本次会包含当前回答；如果 AI 请求失败，文字和录音仍保留，可直接重试。' : '正在根据已完成的回答生成复盘。');
    await call('feedback',candidateTurns);
  }
  function reset() {
    if ((reportPending || draft.turns.length || draft.answer) && !window.confirm(reportPending ? "本轮 AI 复盘尚未保存到历史。开始新一轮会移除当前待保存副本，请先重试保存或导出本轮文字。确定放弃待保存复盘并开始新一轮吗？" : "开始新一轮？当前未生成复盘的回答将被清除，已保存的复盘仍可查看。")) return;
    recorder.reset(); lastBlob.current = null; update({ question: "", answer: "", turns: [], report: null, pendingReport: undefined }); setError("");setReportSaveError('');setReviewNotice('');setPunctuationUndo(null);
  }
  function clearInterviewData() {
    if (!window.confirm("清除逐轮面试的当前资料、草稿和复盘？LIVE 记录、项目素材库、补练任务、练习和 AI 设置仍保留。")) return;
    try { localStorage.removeItem(draftKey); localStorage.removeItem(historyKey); setSaved([]); setDraft({ ...blank, turns: [] }); recorder.reset(); lastBlob.current = null; setError("");setReportSaveError('');setReviewNotice(''); }
    catch { setError("未能清除面试数据，请检查本机存储。"); }
  }
  const reviewButton = <button className={`button ${draft.turns.length >= 8 && !draft.report ? 'primary' : 'secondary'}`} disabled={busy==='正在整理面试复盘…'} onClick={() => void requestReview()}>{busy==='正在整理面试复盘…' ? '正在生成 AI 复盘…' : '生成 AI 面试复盘'}</button>;
  return <><main className="interview-page interview-collected">
    <div className="interview-workspace-heading"><div className="interview-workspace-title"><button className="icon-button" aria-label="返回" onClick={() => go('/')}><ArrowLeft size={22} /></button><h1>模拟面试</h1></div><button className="text-button" onClick={() => go('/history?type=interview')}>面试记录与补练</button></div>
    <nav className="interview-modes" aria-label="面试模式"><div><button className="button secondary" aria-pressed={mode === "turn"} aria-disabled={liveActive} onClick={() => changeMode('turn')}>逐轮练习</button><button className="button secondary" aria-pressed={mode === "live"} onClick={() => changeMode('live')}>LIVE 实时面试</button></div>{modeNotice && <p role="status">{modeNotice}</p>}</nav>
    {error && <div className="interview-error" role="alert">{error} <button className="text-button" onClick={() => go("/settings")}>打开服务设置</button></div>}
    {busy && <p role="status">{busy}</p>}
    <details className="interview-panel interview-materials" key={mode} open={materialsExpanded} onToggle={e=>setMaterialsExpanded(e.currentTarget.open)}><summary>{preparation.resume.trim() && preparation.job.trim() ? `面试资料已保留 · ${preparation.role || '目标岗位'} · ${interviewStages.find(s=>s.id===(preparation.stage||'general'))?.name || '综合面试'}` : '准备面试资料 · 简历与岗位要求'}</summary><div className="interview-heading"><div><h2>简历与目标岗位</h2></div><button className="text-button" onClick={() => go("/settings")}>AI 服务设置</button></div>
      <label>岗位名称（选填）<input value={preparation.role} maxLength={120} disabled={locked} onChange={(e) => updatePreparation({ role: e.target.value })} placeholder="例如：产品经理" /></label>
      <h3>这次重点练什么</h3><div className="interview-stage" role="group" aria-label="面试训练重点">{interviewStages.map(stage=><button key={stage.id} className="button secondary" disabled={locked} aria-pressed={(preparation.stage || 'general')===stage.id} onClick={()=>updatePreparation({stage:stage.id})}>{stage.name}</button>)}</div><p>{interviewStages.find(s=>s.id===(preparation.stage||'general'))?.hint}</p>
      <div className="interview-columns">{([['resume','简历',12000],['job','岗位描述 JD',8000]] as const).map(([field,label,max]) => <label key={field}>{label}<small>支持 PDF、DOCX、TXT，最大 5 MB</small><input type="file" accept=".pdf,.docx,.txt,.md" disabled={locked} onChange={(e) => { void importFile(e.target.files?.[0], field); e.target.value = ""; }} /><textarea rows={8} maxLength={max} value={preparation[field]} disabled={locked} onChange={(e) => updatePreparation({ [field]: e.target.value })} placeholder={`上传文件，或在这里粘贴${label}文字`} /><small>{preparation[field].length} / {max} 字 · 可检查并编辑识别结果</small></label>)}</div>
      <ProjectStories project={preparation.project} disabled={locked} onUse={project=>updatePreparation({project})} />
      <p className="interview-help">生成问题或点评时，本轮资料及回答会发送给已配置的 AI 服务；上传文件只在本机读取，可先删去不想分享的信息。</p>
      {locked && <p>本轮资料已锁定，开始新一轮后可以修改。</p>}
    </details>
    {mode === "live" ? <LiveInterview source={liveSource} onLock={setLiveLocked} onActive={setLiveActive} onPendingReport={setLivePendingReport} onMaterialsRequired={revealMaterials} /> : <>
    <section className="interview-panel interview-current" hidden={Boolean(draft.report)}><div className="interview-heading"><div><h2>当前练习</h2></div><span>{draft.turns.length} / 8 题已回答</span></div>
      {!draft.question && <button className="button primary" disabled={Boolean(busy) || draft.turns.length >= 8} onClick={() => void call("question", draft.turns)}>{draft.turns.length ? "生成下一题 / 追问" : "生成第一道面试题"}</button>}
      {draft.question ? <><div className="interview-question"><div className="interview-question-heading"><strong>面试官</strong><button className="text-button" onClick={() => { if (!speakQuestion(draft.question)) setError("当前设备不支持朗读，请阅读屏幕上的问题。"); }}><SpeakerHigh size={18} aria-hidden="true" /> 朗读问题</button></div><p>{draft.question}</p></div>
        {(recorder.error || recorder.speechError) && <p role="alert">{recorder.error || recorder.speechError}</p>}{playback && <><audio controls src={playback} /><a className="text-button" href={playback} download={`面试回答.${recorder.blob?.type.includes('mp4')?'m4a':recorder.blob?.type.includes('wav')?'wav':'webm'}`}>下载本题录音</a></>}{recorder.blob && <button className="text-button" disabled={transcribing} onClick={() => void transcribe(recorder.blob!)}>重新转写录音</button>}
        <div className="interview-answer-heading"><label htmlFor="interview-answer">我的回答</label><div className="interview-controls">{["idle", "done"].includes(recorder.phase) && <button className={`button ${draft.answer.trim() ? 'secondary' : 'primary'}`} disabled={transcribing || Boolean(busy)} onClick={async () => { if (recorder.phase === "done") { recorder.reset(); lastBlob.current = null; } if (await recorder.prepare()) recorder.start(false); }}>开始录音</button>}{recorder.phase === "recording" && <button className="button primary" onClick={recorder.stop}>结束录音 · {recorder.seconds} 秒</button>}{["requesting", "processing"].includes(recorder.phase) && <span role="status">正在准备录音…</span>}{transcribing && <span role="status">正在转写录音…</span>}</div></div>
        <small id="interview-answer-help" className="interview-answer-help">可修改转写结果，AI 按此文字点评。{answerCharacters(draft.answer)} 个有效字</small><textarea id="interview-answer" aria-describedby="interview-answer-help" rows={4} maxLength={3000} disabled={Boolean(busy)} value={draft.answer} onChange={(e) => {update({ answer: e.target.value, report:null });setReviewNotice('');}} placeholder="录音转写后显示在这里，也可以直接输入。" />
        <div className="interview-text-tools"><button className="text-button" disabled={Boolean(busy)||transcribing||!draft.answer.trim()} onClick={formatAnswer}>补充标点</button>{punctuationUndo && draft.answer===punctuationUndo.after && <button className="text-button" disabled={Boolean(busy)} onClick={()=>{update({answer:punctuationUndo.before,report:null});setPunctuationUndo(null);setPunctuationNotice('已恢复补标点前的原文。');}}>撤销补标点</button>}<small role="status">{punctuationNotice}</small></div>
        <div className="interview-controls interview-answer-actions"><button className={`button ${answerCharacters(draft.answer) >= 5 && recorder.phase !== 'recording' ? 'primary' : 'secondary'}`} disabled={transcribing || recorder.phase === "recording" || Boolean(busy)} onClick={submitAnswer}>保存本题回答</button>{!draft.report && reviewButton}</div>
      </> : <p>填写资料并生成问题后，开始逐轮练习。</p>}
    </section>
    {reportPending && <div className="interview-error" role="alert"><p>{reportSaveError || '本轮 AI 复盘尚未保存到历史，待保存结果已恢复。请重试保存，无需再次调用 AI。'}</p><div className="interview-controls"><button className="button primary" onClick={() => saveReport(draft)}>重试保存复盘</button><button className="text-button" onClick={downloadReport}>导出本轮文字与复盘</button><button className="text-button" onClick={() => go('/history?type=interview')}>管理已保存的面试记录</button></div></div>}
    <div className="interview-review-status" aria-live="polite"><p>{reportPending ? 'AI 复盘已生成，尚未保存到历史；请处理上方保存提示。' : reviewNotice || (draft.report ? '本轮复盘可展开查看或重新生成。' : readiness.message)}</p></div>
    <div className="interview-controls interview-review-actions">{(!draft.question || draft.report) && reviewButton}<button className="text-button" disabled={Boolean(busy) || recorder.phase === "recording" || transcribing} onClick={reset}>开始新一轮</button></div>
    <details className="interview-disclosure"><summary>练习说明 <span>逐题回答 · 每题最多 3 分钟</span></summary><p>面试官朗读问题，你录音或打字回答，再生成下一题。草稿和复盘文字保存在本机，本题录音仅在当前页面保留，可在保存回答前下载。</p></details>
    {draft.turns.length > 0 && <details className="interview-disclosure interview-answers"><summary>本轮问答 <span>已保存 {draft.turns.length} 条回答</span></summary>{draft.turns.map((turn, index) => <details key={index} className="interview-turn"><summary>第 {index + 1} 题 · {turn.question}</summary><p>{turn.answer}</p></details>)}</details>}
    {draft.report && <details className="interview-panel interview-report" open={reportExpanded} onToggle={e=>setReportExpanded(e.currentTarget.open)}><summary>本轮 AI 面试复盘</summary><p>{draft.report.summary}</p><InterviewNextSteps key={JSON.stringify(draft.report)} source={{role:draft.role,resume:draft.resume,job:draft.job,stage:draft.stage,project:draft.project}} report={draft.report} turns={draft.turns} origin="turn" disabled={Boolean(busy)||transcribing||recorder.phase==='recording'} /><details className="interview-analysis"><summary>查看各维度分析 · {draft.report.dimensions.length} 项</summary><div className="interview-scores">{draft.report.dimensions.map((d, i) => <article key={i}><strong>{d.name}</strong><b>{d.score === null ? "证据不足" : `${d.score} / 5`}</b>{d.evidence && <blockquote>“{d.evidence}”</blockquote>}<p>{d.advice}</p></article>)}</div><p><strong>建议：</strong>{draft.report.nextStep}</p><small>评分是 AI 根据本次文字作出的练习参考，不代表真实录用结果。</small></details></details>}
    <details className="interview-disclosure interview-management"><summary>记录与数据管理 <span>{saved.length} 条本机面试复盘</span></summary><button className="text-button" onClick={() => go('/history?type=interview')}>查看本机面试复盘与补练</button><button className="text-button" disabled={Boolean(busy) || recorder.phase === "recording" || transcribing} onClick={clearInterviewData}>清除本机面试数据</button></details>
    </>}
    </main><BottomNav active="/interview" /></>;
}
