import type { InterviewReport, InterviewSource, InterviewTurn } from "./interviewTraining";
import { reviewTurns } from "./liveTranscript.mjs";
import type { LiveMessage } from "./liveTranscript.mjs";
import type { UsageEntry } from "./liveUsage.mjs";

export type InterviewRecordKind = "turn" | "live";
export type InterviewRecord = {
  id: string;
  kind: InterviewRecordKind;
  time: string;
  source: InterviewSource | null;
  turns: InterviewTurn[];
  messages?: LiveMessage[];
  report: InterviewReport | null;
  usage?: UsageEntry[];
  elapsed?: number;
  tokens?: number;
};
const keys = { turn: "kaikou.interview.history.v1", live: "kaikou.live-interview.history.v1" };
type Stored = { id?: string; time?: string; draft: Record<string, unknown> };

function entries(kind: InterviewRecordKind): Stored[] {
  const saved: unknown = JSON.parse(localStorage.getItem(keys[kind]) || "[]");
  if (!Array.isArray(saved)) throw Error("记录格式无法读取，原数据仍保留。");
  return saved;
}
function identity(item: Stored, kind: InterviewRecordKind) {
  return kind === "live" ? item?.draft?.id : item?.id;
}
export function validInterviewReport(value: unknown): value is InterviewReport {
  if (!value || typeof value !== "object") return false;
  const report = value as InterviewReport;
  return typeof report.summary === "string" && !!report.summary.trim() &&
    typeof report.nextStep === "string" && Array.isArray(report.dimensions) &&
    report.dimensions.length > 0 && report.dimensions.every(d => d &&
      typeof d.name === "string" && typeof d.evidence === "string" && typeof d.advice === "string" &&
      (d.score === null || (typeof d.score === "number" && Number.isFinite(d.score) && d.score >= 0 && d.score <= 5)));
}
// Older reports remain readable even if newer fields were not recorded.
function readableReport(value: unknown): InterviewReport | null {
  if (!value || typeof value !== "object") return null;
  const report = value as Record<string, unknown>;
  if (typeof report.summary !== "string") return null;
  const dimensions = Array.isArray(report.dimensions) ? report.dimensions.filter(d => d && typeof d === "object").map(d => ({
    name: typeof d.name === "string" ? d.name : typeof d.title === "string" ? d.title : "历史反馈",
    score: typeof d.score === "number" && Number.isFinite(d.score) && d.score >= 0 && d.score <= 5 ? d.score : null,
    evidence: typeof d.evidence === "string" ? d.evidence : Array.isArray(d.evidence) ? d.evidence.filter((v: unknown) => typeof v === "string").join("\n") : "",
    advice: typeof d.advice === "string" ? d.advice : typeof d.text === "string" ? d.text : "",
  })) : [];
  return { summary: report.summary, dimensions, nextStep: typeof report.nextStep === "string" ? report.nextStep : "" };
}
function sourceOf(value: unknown): InterviewSource | null {
  if (!value || typeof value !== "object") return null;
  const source = value as InterviewSource;
  if (![source.role, source.resume, source.job].every(v => typeof v === "string")) return null;
  return { role: source.role, resume: source.resume, job: source.job,
    ...(typeof source.stage === "string" ? { stage: source.stage } : {}),
    ...(typeof source.project === "string" ? { project: source.project } : {}) };
}

/** Read through existing stores; never migrate them or touch an in-progress draft. */
export function readInterviewRecords(): { records: InterviewRecord[]; error: string } {
  const records: InterviewRecord[] = [];
  const errors: string[] = [];
  for (const kind of ["turn", "live"] as const) {
    try {
      for (const item of entries(kind)) {
        const id = identity(item, kind), draft = item?.draft;
        if (typeof id !== "string" || !draft || typeof draft !== "object") {
          errors.push("部分面试记录无法展示，原数据仍保留。");
          continue;
        }
        const messages = kind === "live" && Array.isArray(draft.messages)
          ? draft.messages.filter((m): m is LiveMessage => m && typeof m.id === "string" &&
            ["user", "assistant"].includes(m.role) && typeof m.text === "string") : undefined;
        const turns = kind === "live" ? reviewTurns(messages || []) : Array.isArray(draft.turns)
          ? draft.turns.filter((t): t is InterviewTurn => t && typeof t.question === "string" && typeof t.answer === "string") : [];
        records.push({ id, kind, time: typeof item.time === "string" ? item.time : "",
          source: sourceOf(kind === "live" ? draft.source : draft), turns, messages,
          report: readableReport(draft.report),
          ...(kind === "live" ? {
            usage: Array.isArray(draft.usage) ? draft.usage.filter((e): e is UsageEntry => e && typeof e.id === "string" && Number.isSafeInteger(e.total) && e.total >= 0) : [],
            elapsed: typeof draft.elapsed === "number" && Number.isFinite(draft.elapsed) ? Math.max(0, draft.elapsed) : 0,
            tokens: typeof draft.tokens === "number" && Number.isSafeInteger(draft.tokens) ? Math.max(0, draft.tokens) : 0,
          } : {}) });
      }
    } catch { errors.push(`${kind === "live" ? "LIVE" : "逐题"}面试记录暂时无法读取，请重试。原数据未改动。`); }
  }
  return { records: records.sort((a, b) => b.time.localeCompare(a.time)), error: [...new Set(errors)].join(" ") };
}
export function interviewRecordPath(record: Pick<InterviewRecord, "id" | "kind">) {
  return `/history?type=interview&kind=${record.kind}&id=${encodeURIComponent(record.id)}`;
}
export function updateInterviewRecord(record: InterviewRecord, report: InterviewReport) {
  const all = entries(record.kind);
  const index = all.findIndex(item => identity(item, record.kind) === record.id);
  if (index < 0) throw Error("这条记录已被移除，新的复盘未写入。当前练习草稿不受影响。");
  // Read the latest store immediately before writing so unrelated records are preserved.
  all[index] = { ...all[index], draft: { ...all[index].draft, report } };
  localStorage.setItem(keys[record.kind], JSON.stringify(all));
  window.dispatchEvent(new Event("kaikou-interview-records-changed"));
}
export function deleteInterviewRecord(record: InterviewRecord) {
  const all = entries(record.kind);
  localStorage.setItem(keys[record.kind], JSON.stringify(all.filter(item => identity(item, record.kind) !== record.id)));
  window.dispatchEvent(new Event("kaikou-interview-records-changed"));
}
