export type PendingInterviewReportSave = { id: string; time: string };

const keys = {
  turn: "kaikou.interview.history.v1",
  live: "kaikou.live-interview.history.v1",
};
type Kind = keyof typeof keys;
type ReportDraft = { report: unknown; pendingReport?: PendingInterviewReportSave };
type Stored = { id?: string; time?: string; draft?: Record<string, unknown> };

/** Save against the raw store, never a filtered list used for presentation. */
export function saveInterviewReport(kind: Kind, draft: ReportDraft): void {
  const pending = draft.pendingReport;
  if (!draft.report || !pending || typeof pending.id !== "string" || !pending.id || typeof pending.time !== "string")
    throw Error("待保存复盘信息不完整，请先导出本轮文字。原历史记录未改动。");
  let entries: unknown[];
  try {
    const raw = localStorage.getItem(keys[kind]);
    const value: unknown = raw === null ? [] : JSON.parse(raw);
    if (!Array.isArray(value)) throw Error();
    entries = value;
  } catch {
    throw Error("历史记录无法读取或格式损坏，本次复盘尚未保存到历史。原数据未改动；请先导出本轮文字，恢复历史数据后重试保存。");
  }
  const index = entries.findIndex(item => {
    const value = item as Stored | null;
    return (kind === "live" ? value?.draft?.id : value?.id) === pending.id;
  });
  if (index < 0 && entries.length >= 20)
    throw Error("本机已达到 20 条面试复盘上限，本次复盘尚未保存到历史。请先导出本轮文字，在面试记录中手动删除不需要的旧记录，再回来重试保存。");
  const { pendingReport: _pending, ...complete } = draft;
  const previous = index >= 0 ? entries[index] as Stored : undefined;
  const next = {
    ...previous,
    ...(kind === "turn" ? { id: pending.id } : {}),
    time: pending.time,
    draft: { ...previous?.draft, ...complete, ...(kind === "live" ? { id: pending.id } : {}) },
  };
  // Retrying the same report updates its stable identity instead of inserting twice.
  if (index < 0) entries.unshift(next);
  else entries[index] = next;
  try { localStorage.setItem(keys[kind], JSON.stringify(entries)); }
  catch { throw Error("复盘已生成，但保存到历史失败。请检查本机存储空间或权限，再点击“重试保存复盘”；无需再次调用 AI。"); }
  window.dispatchEvent(new Event("kaikou-interview-records-changed"));
}
