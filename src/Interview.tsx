import { useEffect, useRef, useState } from "react";
import { Header, BottomNav, go, setNavigationGuard } from "./components";
import { useRecorder } from "./useRecorder";
import { transcribeDetailed } from "./api";
import { speakQuestion } from "./voicePrompt";
import { LiveInterview } from "./LiveInterview";
import { punctuateAnswer } from "./interviewPunctuation.mjs";
import { answerCharacters, reviewReadiness } from "../server/interview-readiness.mjs";
import "./interview.css";

type Turn = { question: string; answer: string };
type Dimension = { name: string; score: number | null; evidence: string; advice: string };
type Report = { summary: string; dimensions: Dimension[]; nextStep: string };
type Draft = { role: string; resume: string; job: string; question: string; answer: string; turns: Turn[]; report: Report | null };
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
  const [materialsExpanded, setMaterialsExpanded] = useState(()=>{try{const source=JSON.parse(localStorage.getItem('kaikou.live-interview.draft.v1')||'null')?.source||JSON.parse(localStorage.getItem('kaikou.live-interview.preparation.v1')||'null')||readDraft();return !source.resume?.trim()||!source.job?.trim();}catch{return true;}});
  const [reviewNotice, setReviewNotice] = useState('');
  const [punctuationUndo, setPunctuationUndo] = useState<{before:string;after:string} | null>(null);
  const [punctuationNotice, setPunctuationNotice] = useState('');
  const [liveLocked, setLiveLocked] = useState(false);
  const [liveActive, setLiveActive] = useState(false);
  useEffect(()=>{if(liveActive)setMaterialsExpanded(false);},[liveActive]);
  const [draft, setDraft] = useState<Draft>(readDraft);
  const [liveSource, setLiveSource] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("kaikou.live-interview.draft.v1") || "null")?.source || JSON.parse(localStorage.getItem("kaikou.live-interview.preparation.v1") || "null");
      if (saved && [saved.role, saved.resume, saved.job].every((v) => typeof v === "string")) return saved as { role: string; resume: string; job: string };
    } catch { /* use current materials only, never previous answers */ }
    return { role: draft.role, resume: draft.resume, job: draft.job };
  });
  const [saved, setSaved] = useState<Saved[]>(readHistory);
  const [error, setError] = useState("");
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
  function changeMode(next: 'turn' | 'live') {
    if (next === mode) return;
    if (liveActive) { setModeNotice('请先结束 LIVE 通话或等待复盘完成，再切换模式。'); return; }
    if (busy || transcribing || ['recording','requesting','processing'].includes(recorder.phase)) { setModeNotice('请先结束录音并等待转写或当前请求完成，再进入另一种面试模式。'); return; }
    document.querySelectorAll('audio').forEach(audio => audio.pause());
    window.speechSynthesis?.cancel();
    if(next==='live') {
      const nextSource=!liveSource.resume.trim()&&!liveSource.job.trim()?{role:draft.role,resume:draft.resume,job:draft.job}:liveSource;
      setLiveSource(nextSource);setMaterialsExpanded(!nextSource.resume.trim()||!nextSource.job.trim());
    }
    setMode(next);setModeNotice('');setError('');
    if(next==='live') requestAnimationFrame(()=>document.querySelector('.live-panel')?.scrollIntoView({block:'start'}));
    try { localStorage.setItem('kaikou.interview.mode',next); } catch { setModeNotice('模式偏好未能保存，本次仍可继续练习。'); }
  }
  function formatAnswer() {
    const after=punctuateAnswer(draft.answer);
    if (after===draft.answer) { setPunctuationNotice('没有发现可确定的断句位置，原文已保留，可以手动调整。'); return; }
    setPunctuationUndo({before:draft.answer,after});update({answer:after,report:null});setPunctuationNotice('已在本机补充标点，未改动用词。请核对断句，可撤销。');
  }
  const updatePreparation = (part: Partial<{ role: string; resume: string; job: string }>) => mode === "live" ? setLiveSource((v) => ({ ...v, ...part })) : update(part);
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
    if (recorder.phase !== "recording" && !recorder.blob && !transcribing) return;
    setNavigationGuard(() => window.confirm("离开页面后本次录音无法保留，转写文字会保存在草稿中。确定离开吗？"));
    return () => setNavigationGuard(undefined);
  }, [recorder.phase, recorder.blob, transcribing]);
  async function importFile(file: File | undefined, field: "resume" | "job") {
    if (!file) return;
    setError(""); setBusy("正在读取文件…");
    try {
      const text = await extractDocument(file);
      const max = field === "resume" ? 12000 : 8000;
      if (text.length > max) throw Error(`文件文字超过 ${max} 字，请精简后粘贴。`);
      updatePreparation({ [field]: text });
    } catch (e) { setError(e instanceof Error ? e.message : "文件读取失败，请粘贴文字。"); }
    finally { setBusy(""); }
  }
  async function call(action: "question" | "feedback", turns: Turn[]) {
    if(requestRef.current) return;
    if (draft.resume.trim().length < 20 || draft.job.trim().length < 20) { setError("请填写至少 20 个字的简历和岗位描述。您可以上传文件或直接粘贴。"); return; }
    setError(""); setBusy(action === "question" ? "面试官正在准备问题…" : "正在整理面试复盘…");
    const controller=new AbortController();requestRef.current=controller;
    try {
      const response = await fetch("/api/interview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, role: draft.role, resume: draft.resume, job: draft.job, history: turns }), signal: AbortSignal.any([controller.signal,AbortSignal.timeout(100000)]) });
      const data = await response.json().catch(() => ({}));
      if(controller.signal.aborted) return;
      if (!response.ok) throw Error(data.error || "请求失败，请重试。");
      if (action === "question") { update({ question: data.question, report: null }); }
      else {
        const complete = { ...draft, question:'',answer:'',report: data as Report, turns };
        update({ turns,question:'',answer:'',report: data as Report });
        recorder.reset();lastBlob.current=null;setPunctuationUndo(null);
        const prior = readHistory();
        if (prior.length >= 20) throw Error("复盘已显示，但本机已保存 20 条，请删除不需要的记录后重新保存。");
        const next = [{ id: crypto.randomUUID(), time: new Date().toISOString(), draft: complete }, ...prior];
        try { localStorage.setItem(historyKey, JSON.stringify(next)); setSaved(next); }
        catch { setError("复盘已显示，但无法保存到本机，请检查存储空间。"); }
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
    if (busy) { setReviewNotice('当前请求还在处理中，请稍候。'); return; }
    if (transcribing || ['recording','requesting','processing'].includes(recorder.phase)) { setReviewNotice('请先结束录音并等待转写完成，再生成面试复盘。'); return; }
    if (!readiness.ready) { setReviewNotice(readiness.message); return; }
    if (candidateTurns.length > 8 || candidateTurns.some(t=>t.answer.length>3000)) { setReviewNotice('本轮最多 8 题，每题最多 3000 字；请精简当前回答后再试。'); return; }
    setReviewNotice(draft.answer.trim() ? '本次会包含当前回答；如果 AI 请求失败，文字和录音仍保留，可直接重试。' : '正在根据已完成的回答生成复盘。');
    await call('feedback',candidateTurns);
  }
  function reset() {
    if ((draft.turns.length || draft.answer) && !window.confirm("开始新一轮？当前未生成复盘的回答将被清除，已保存的复盘仍可查看。")) return;
    recorder.reset(); lastBlob.current = null; update({ question: "", answer: "", turns: [], report: null }); setError("");setReviewNotice('');setPunctuationUndo(null);
  }
  function clearInterviewData() {
    if (!window.confirm("清除本机模拟面试的简历、岗位描述、草稿和全部面试复盘？原有口才练习和 AI 服务设置不受影响。")) return;
    try { localStorage.removeItem(draftKey); localStorage.removeItem(historyKey); setSaved([]); setDraft({ ...blank, turns: [] }); recorder.reset(); lastBlob.current = null; setError(""); }
    catch { setError("未能清除面试数据，请检查本机存储。"); }
  }
  return <><Header title="模拟面试" /><main className="interview-page">
    <div className="interview-hero"><span>AI 面试练习</span><h1>把面试，先练一遍</h1><p>结合简历和岗位要求提问，选择逐轮练习或 LIVE 实时语音对练。</p></div>
    <nav className="interview-modes" aria-label="面试模式"><div><button className="button secondary" aria-pressed={mode === "turn"} aria-disabled={liveActive} onClick={() => changeMode('turn')}>逐轮练习</button><button className="button secondary" aria-pressed={mode === "live"} onClick={() => changeMode('live')}>LIVE 实时面试</button></div><p>{modeNotice || (mode === 'live' ? '当前为 LIVE · 连续语音对话，面试官实时追问' : '当前为逐轮练习 · 录音 → 转写 → 复盘；也可以进入 LIVE 连续对话')}</p></nav>
    {mode === "turn" ? <div className="interview-notice">当前为逐轮语音对练：面试官朗读问题，你录音回答并确认转写，AI 再生成追问。不是可打断的实时通话。生成问题或复盘时，简历、岗位描述及回答会发送给你配置的 AI 服务；请先删除不想分享的信息。草稿和复盘文字保存在本机，录音仅在当前页面保留。</div> : <div className="interview-notice">LIVE 使用独立实时语音服务，连续对话、自动识别停顿并追问。旧的逐轮练习不会自动作为本轮回答提交。请先删去简历中不想分享的信息。</div>}
    {error && <div className="interview-error" role="alert">{error} <button className="text-button" onClick={() => go("/settings")}>打开服务设置</button></div>}
    {busy && <p role="status">{busy}</p>}
    <details className="interview-panel interview-materials" key={mode} open={mode === 'turn' || materialsExpanded} onToggle={e=>{if(mode==='live')setMaterialsExpanded(e.currentTarget.open);}}><summary>{mode === 'live' && preparation.resume.trim() && preparation.job.trim() ? '面试资料已保留 · 查看简历与岗位要求' : '准备面试资料 · 简历与岗位要求'}</summary><div className="interview-heading"><div><h2>让问题贴近你的岗位</h2></div><button className="text-button" onClick={() => go("/settings")}>AI 服务设置</button></div>
      <label>岗位名称（选填）<input value={preparation.role} maxLength={120} disabled={locked} onChange={(e) => updatePreparation({ role: e.target.value })} placeholder="例如：产品经理" /></label>
      <div className="interview-columns">{([['resume','简历',12000],['job','岗位描述 JD',8000]] as const).map(([field,label,max]) => <label key={field}>{label}<small>支持 PDF、DOCX、TXT，最大 5 MB</small><input type="file" accept=".pdf,.docx,.txt,.md" disabled={locked} onChange={(e) => { void importFile(e.target.files?.[0], field); e.target.value = ""; }} /><textarea rows={8} maxLength={max} value={preparation[field]} disabled={locked} onChange={(e) => updatePreparation({ [field]: e.target.value })} placeholder={`上传文件，或在这里粘贴${label}文字`} /><small>{preparation[field].length} / {max} 字 · 可检查并编辑识别结果</small></label>)}</div>
      {locked && <p>本轮资料已锁定，开始新一轮后可以修改。</p>}
      {mode === "turn" && <button className="button primary" disabled={Boolean(busy) || Boolean(draft.question) || draft.turns.length >= 8} onClick={() => void call("question", draft.turns)}>{draft.turns.length ? "生成下一题 / 追问" : "生成第一道面试题"}</button>}
    </details>
    {mode === "live" ? <LiveInterview source={liveSource} onLock={setLiveLocked} onActive={setLiveActive} /> : <>
    <section className="interview-panel"><div className="interview-heading"><div><span>02 / 面试对练</span><h2>面试官提问</h2></div><span>{draft.turns.length} / 8 题已回答</span></div>
      {draft.question ? <><div className="interview-question"><strong>面试官</strong><p>{draft.question}</p><button className="text-button" onClick={() => { if (!speakQuestion(draft.question)) setError("当前设备不支持朗读，请阅读屏幕上的问题。"); }}>▶ 朗读问题</button></div>
        <div className="interview-controls">{["idle", "done"].includes(recorder.phase) && <button className="button secondary" disabled={transcribing || Boolean(busy)} onClick={async () => { if (recorder.phase === "done") { recorder.reset(); lastBlob.current = null; } if (await recorder.prepare()) recorder.start(false); }}>开始录音</button>}{recorder.phase === "recording" && <button className="button primary" onClick={recorder.stop}>结束录音 · {recorder.seconds} 秒</button>}{["requesting", "processing"].includes(recorder.phase) && <span role="status">正在准备录音…</span>}{transcribing && <span role="status">正在转写录音…</span>}</div>
        {(recorder.error || recorder.speechError) && <p role="alert">{recorder.error || recorder.speechError}</p>}{playback && <><audio controls src={playback} /><a className="text-button" href={playback} download={`面试回答.${recorder.blob?.type.includes('mp4')?'m4a':recorder.blob?.type.includes('wav')?'wav':'webm'}`}>下载本题录音</a></>}{recorder.blob && <button className="text-button" disabled={transcribing} onClick={() => void transcribe(recorder.blob!)}>重新转写录音</button>}
        <label>我的回答 <small>可修改转写结果，AI 按此文字点评。{answerCharacters(draft.answer)} 个有效字</small><textarea rows={6} maxLength={3000} disabled={Boolean(busy)} value={draft.answer} onChange={(e) => {update({ answer: e.target.value, report:null });setReviewNotice('');}} placeholder="录音转写后显示在这里，也可以直接输入。" /></label>
        <div className="interview-text-tools"><button className="text-button" disabled={Boolean(busy)||transcribing||!draft.answer.trim()} onClick={formatAnswer}>补充标点</button>{punctuationUndo && draft.answer===punctuationUndo.after && <button className="text-button" disabled={Boolean(busy)} onClick={()=>{update({answer:punctuationUndo.before,report:null});setPunctuationUndo(null);setPunctuationNotice('已恢复补标点前的原文。');}}>撤销补标点</button>}<small role="status">{punctuationNotice}</small></div>
        <button className="button primary" disabled={transcribing || recorder.phase === "recording" || Boolean(busy)} onClick={submitAnswer}>保存本题回答</button>
      </> : <p>填写资料并生成问题后，开始逐轮练习。</p>}
      {draft.turns.map((turn, index) => <details key={index} className="interview-turn"><summary>第 {index + 1} 题 · {turn.question}</summary><p>{turn.answer}</p></details>)}
      <div className="interview-review-status" aria-live="polite"><strong>1 题即可复盘，不需要答得很好</strong><p>{reviewNotice || readiness.message}</p><small>每题至少 5 个有效字（不计标点）；建议练习 3 题以上。内容不足的维度会标注“证据不足”。{draft.question&&draft.answer.trim() ? ' 点击生成会一并包含当前回答，不必先点保存。' : ''}</small></div>
      <div className="interview-controls"><button className="button primary" disabled={busy==='正在整理面试复盘…'} onClick={() => void requestReview()}>{busy==='正在整理面试复盘…' ? '正在生成 AI 复盘…' : '生成 AI 面试复盘'}</button><button className="button secondary" disabled={Boolean(busy) || recorder.phase === "recording" || transcribing} onClick={reset}>开始新一轮</button><button className="text-button" disabled={Boolean(busy) || recorder.phase === "recording" || transcribing} onClick={clearInterviewData}>清除本机面试数据</button></div>
    </section>
    {draft.report && <section className="interview-panel"><div className="interview-heading"><div><span>03 / 面试复盘</span><h2>把下一次说得更具体</h2></div></div><p>{draft.report.summary}</p><div className="interview-scores">{draft.report.dimensions.map((d, i) => <article key={i}><strong>{d.name}</strong><b>{d.score === null ? "证据不足" : `${d.score} / 5`}</b>{d.evidence && <blockquote>“{d.evidence}”</blockquote>}<p>{d.advice}</p></article>)}</div><p><strong>下一步：</strong>{draft.report.nextStep}</p><small>评分是 AI 根据本次文字作出的练习参考，不代表真实录用结果。</small></section>}
    {saved.length > 0 && <section className="interview-panel"><h2>本机面试复盘</h2>{saved.map((item) => <div className="interview-history" key={item.id}><button className="text-button" onClick={() => { if (window.confirm("查看这次复盘将替换当前草稿，是否继续？")) { recorder.reset(); lastBlob.current = null; setDraft(item.draft); } }}>{item.draft.role || "模拟面试"} · {new Date(item.time).toLocaleString("zh-CN")}</button><button className="text-button" onClick={() => { if (!window.confirm("删除这条本机面试复盘？")) return; const next = saved.filter((s) => s.id !== item.id); try { localStorage.setItem(historyKey, JSON.stringify(next)); setSaved(next); } catch { setError("未能删除记录，请检查本机存储。"); } }}>删除</button></div>)}</section>}
    </>}
    </main><BottomNav active="/practice/improv" /></>;
}
