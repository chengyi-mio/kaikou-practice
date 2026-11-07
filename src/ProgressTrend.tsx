import { useMemo, useState } from "react";
import type { Session } from "./types";

const statusText: Record<string, string> = {
  good: "已做到", partial: "需完善", missing: "未体现", unsure: "无法判断",
};
type Row = { session: Session; status: string; evidence: string };
type Skill = { key: string; title: string; scene: string; rows: Row[] };

/** A judgment is comparable only if every part of its rubric identity matches. */
export function skillTrend(sessions: Session[]): Skill[] {
  const groups = new Map<string, Skill>();
  for (const session of sessions) {
    const feedback = session.feedback;
    if (feedback?.source !== "ai" || feedback.provider !== "agnes") continue;
    for (const dimension of feedback.dimensions) {
      if (!dimension.id || !dimension.standard || !dimension.status) continue;
      const key = [feedback.provider, feedback.model, feedback.ruleVersion, feedback.ruleProfile, feedback.profileName, dimension.id, dimension.standard].join("|");
      const group = groups.get(key) || { key, title: dimension.title, scene: feedback.profileName || "通用表达", rows: [] };
      group.rows.push({ session, status: dimension.status, evidence: dimension.evidence?.[0] || "" });
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.rows.length >= 2)
    .map((group) => ({ ...group, rows: group.rows.sort((a, b) => a.session.createdAt.localeCompare(b.session.createdAt)) }))
    .sort((a, b) => b.rows.at(-1)!.session.createdAt.localeCompare(a.rows.at(-1)!.session.createdAt));
}

export function ProgressTrend({ sessions }: { sessions: Session[] }) {
  const skills = useMemo(() => skillTrend(sessions), [sessions]);
  const [selected, setSelected] = useState("");
  const [windowDays, setWindowDays] = useState(0);
  const active = skills.find((skill) => skill.key === selected) || skills[0];
  const cutoff = windowDays ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : 0;
  const rows = active?.rows.filter((row) => Date.parse(row.session.createdAt) >= cutoff).slice(-12) || [];
  const recent = rows.filter((row) => row.status !== "unsure").slice(-3);
  return <section className="skill-progress" aria-label="表达能力趋势">
    <div><span className="eyebrow">持续练习</span><h2>看一项能力怎样变化</h2><p>只比较同模型、同版本、同场景和同一条标准下的判断。图中的点是模型结论，不是能力分数。</p></div>
    {active ? <>
      <div className="skill-progress-controls">
        <label>选择能力<select value={active.key} onChange={(event) => setSelected(event.target.value)}>{skills.map((skill) => <option key={skill.key} value={skill.key}>{skill.scene} · {skill.title}（{skill.rows.length} 次）</option>)}</select></label>
        <div role="group" aria-label="查看时间范围">{[[7, "近7天"], [28, "近28天"], [0, "全部"]].map(([days, label]) => <button key={days} aria-pressed={windowDays === days} className={windowDays === days ? "selected" : ""} onClick={() => setWindowDays(Number(days))}>{label}</button>)}</div>
      </div>
      {rows.length ? <>
        <p className="skill-progress-summary">{rows.length} 次同标准练习 · 最近 {recent.length} 次可判断的练习中，{recent.filter((row) => row.status === "good").length} 次“已做到”。可逐条核对下方原话。</p>
        <div className="skill-progress-timeline" role="list" aria-label="历次模型判断">
          {rows.map((row, i) => <article key={row.session.id} role="listitem" className={`status-${row.status}`}>
            <time dateTime={row.session.createdAt}>{new Date(row.session.createdAt).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}</time>
            <strong>{statusText[row.status] || row.status}</strong>
            <span>第 {i + 1} 次</span>
          </article>)}
        </div>
        <details className="skill-progress-evidence"><summary>逐次查看原话依据</summary>{rows.map((row) => <div key={row.session.id}><strong>{new Date(row.session.createdAt).toLocaleString("zh-CN")} · {statusText[row.status] || row.status}</strong><p>{row.evidence || "这次模型未定位到原话，请打开练习记录核对。"}</p></div>)}</details>
      </> : <p>这个时间范围内还没有同标准的练习，试试“全部”。</p>}
    </> : <p className="skill-progress-empty">完成两次使用相同标准的 Agnes 点评后，这里会显示可核对的趋势。现有记录仍可在下方查看。</p>}
  </section>;
}
