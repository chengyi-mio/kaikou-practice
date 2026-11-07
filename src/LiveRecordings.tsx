import { useEffect, useRef, useState } from 'react';
import { deleteRecording, listRecordings, recordingBlob, recordingFilename, playableRecordingBlob } from './liveRecordingStore';
import type { LiveRecording } from './liveRecordingStore';
import type { RecordingState } from './liveRecording';

const duration = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
function download(blob: Blob, record: LiveRecording) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = recordingFilename(record); link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function RecordingRow({record, disabled, hasReview, onReview}: {record: LiveRecording; disabled: boolean; hasReview: boolean; onReview: (id: string) => void}) {
  const [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const alive = useRef(true);
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  // Autoplay only follows an explicit replay click, never the end of a call/review.
  useEffect(() => { if(url && !disabled) void audio.current?.play().catch(()=>{}); },[url]);
  useEffect(() => { if(disabled) audio.current?.pause(); },[disabled]);
  async function load(save = false) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const blob = await recordingBlob(record);
      if (!alive.current) return;
      if (save) download(blob, record);
      else setUrl(URL.createObjectURL(blob));
    } catch(e) { if(alive.current) setError(e instanceof Error ? e.message : '读取录音失败，请重试。'); }
    finally { if(alive.current) setBusy(false); }
  }
  return <article className="live-recording-row" data-recording-id={record.id}>
    <div className="live-recording-description"><strong>{record.role || '模拟面试'} · 双方通话</strong><small>{new Date(record.createdAt).toLocaleString('zh-CN')} · {duration(record.duration)} · {(record.bytes / 1024 / 1024).toFixed(2)} MB</small><small>{record.status === 'saved' ? '已保存到本机' : '中断保留 · 可能缺少结束前未写入的声音'}</small></div>
    <div className="live-recording-actions">
      <button className="text-button" disabled={busy || disabled} onClick={() => void load()}>回放录音</button>
      <button className="text-button" disabled={busy || disabled} onClick={() => void load(true)}>下载录音</button>
      {hasReview && <button className="text-button" disabled={disabled} onClick={() => onReview(record.roundId)}>查看对应复盘</button>}
      <button className="text-button" disabled={busy || disabled} onClick={async () => {
        if (!window.confirm('删除这段通话录音？仅删除本机音频，对话文字和 AI 复盘仍保留。下载到其他位置的副本不受影响。')) return;
        setBusy(true); setError('');
        try { await deleteRecording(record.id); }
        catch { if(alive.current) setError('删除失败，录音仍保留，请重试。'); }
        finally { if(alive.current) setBusy(false); }
      }}>删除录音</button>
    </div>
    {busy && <small role="status">正在处理录音…</small>}
    {url && <audio ref={audio} controls hidden={disabled} preload="metadata" src={url} aria-label={`${record.role || '模拟面试'}双方通话录音`} />}
    {error && <p className="live-recording-error" role="alert">{error}</p>}
  </article>;
}

export function LiveRecordings({roundId, state, active, reviews, onReview, onRetry, onDiscard}: {roundId: string; state: RecordingState; active: boolean; reviews: string[]; onReview: (id:string)=>void; onRetry:()=>void; onDiscard:()=>void}) {
  const [records, setRecords] = useState<LiveRecording[]>([]), [error, setError] = useState(''), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => { void listRecordings().then(value => { if(alive){setRecords(value);setError('');} }).catch(e => {if(alive)setError(e.message);}); };
    load(); window.addEventListener('kaikou-live-recordings-changed',load);
    return () => { alive = false; window.removeEventListener('kaikou-live-recordings-changed',load); };
  },[refresh,state.phase]);
  const visible = records.filter(r => r.id !== state.unsaved?.record.id && !(['recording','saving'].includes(state.phase) && r.id === state.id));
  const current = visible.filter(r => r.roundId === roundId), prior = visible.filter(r => r.roundId !== roundId);
  const row = (record: LiveRecording) => <RecordingRow key={record.id} record={record} disabled={active || state.phase === 'saving'} hasReview={reviews.includes(record.roundId)} onReview={onReview}/>;
  return <section className="live-recordings" aria-label="LIVE 通话录音">
    <div className="live-transcript-heading"><h3>通话录音</h3><span role="status">{state.phase==='recording' ? '正在录制双方声音' : state.phase==='saving' ? '正在保存，请稍候…' : state.unsaved ? '尚未完整保存' : '本机录音库'}</span></div>
    <p>每次接通自动录制双方声音，结束或断线后保存；重连另存一段。不生成复盘也会保存，开始新一轮不会删除录音。</p>
    {state.message && <p className="live-recording-error" role="alert">{state.message}</p>}
    {state.unsaved && <div className="live-recording-actions"><button className="button secondary" disabled={state.phase==='saving'} onClick={onRetry}>重试保存录音</button><button className="text-button" onClick={async()=>{const temporary=state.unsaved!;const blob=new Blob(temporary.chunks,{type:temporary.record.mimeType});download(await playableRecordingBlob(blob,temporary.record).catch(()=>blob),temporary.record);}}>下载临时录音</button><button className="text-button" disabled={state.phase==='saving'} onClick={()=>{if(window.confirm('请确认已下载临时录音。放弃后无法恢复尚未写入的声音，确定继续？'))onDiscard();}}>放弃临时副本</button></div>}
    {error && <p className="live-recording-error" role="alert">{error} <button className="text-button" onClick={()=>setRefresh(n=>n+1)}>重新读取录音</button></p>}
    {current.map(row)}
    {!current.length && !active && state.phase!=='saving' && !state.unsaved && <p className="live-recording-empty">本轮还没有录音。旧版本未录制的通话无法补回。</p>}
    {prior.length>0 && <details className="live-recording-history"><summary>以前的通话录音 · {prior.length} 段</summary>{prior.map(row)}</details>}
    <small>录音仅保存到此设备，不额外上传。建议佩戴耳机，减少扬声器回声；重要录音可下载备份。</small>
  </section>;
}
