import { useState } from "react";

type Story = {
  id: string;
  name: string;
  background: string;
  action: string;
  result: string;
  relevance: string;
};
const key = "kaikou.interview.projects.v1";
const empty = (): Story => ({
  id: crypto.randomUUID(),
  name: "",
  background: "",
  action: "",
  result: "",
  relevance: "",
});
function read(): Story[] {
  const value = JSON.parse(localStorage.getItem(key) || "[]");
  if (
    !Array.isArray(value) ||
    value.some(
      (v) =>
        !v ||
        ["id", "name", "background", "action", "result", "relevance"].some(
          (k) => typeof v[k] !== "string",
        ),
    )
  )
    throw Error("项目素材暂时无法读取，原数据已保留。");
  return value;
}
export function ProjectStories({
  project,
  disabled,
  onUse,
}: {
  project?: string;
  disabled: boolean;
  onUse: (text: string) => void;
}) {
  const [load] = useState(() => {
    try {
      return { stories: read(), error: "" };
    } catch (e) {
      return { stories: [] as Story[], error: (e as Error).message };
    }
  });
  const [stories, setStories] = useState(load.stories);
  const [draft, setDraft] = useState(empty);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState(load.error);
  function commit(next: Story[]) {
    if (load.error) {
      setError(load.error);
      return false;
    }
    try {
      localStorage.setItem(key, JSON.stringify(next));
      setStories(next);
      setError("");
      return true;
    } catch {
      setError("项目素材未保存，请检查本机空间后重试。编辑内容仍在。");
      return false;
    }
  }
  function save() {
    if (!draft.name.trim() || !draft.action.trim()) {
      setError("请填写项目名称和你亲自做的事；结果不确定时可以先留空。");
      return;
    }
    if (!stories.some((s) => s.id === draft.id) && stories.length >= 20) {
      setError("已保存 20 个项目，请编辑现有项目或删除不用的素材后再保存。");
      return;
    }
    if (commit([draft, ...stories.filter((s) => s.id !== draft.id)]))
      setNotice("项目已保存到本机，可选择用于本轮面试。");
  }
  return (
    <details className="project-stories">
      <summary>项目素材库 · 准备能讲清楚的真实经历（选填）</summary>
      <p>
        把“我们做了什么”拆成“我做了什么”。只记录真实事实；缺少数字也可以描述前后变化。
      </p>
      {project && (
        <div className="project-selected">
          <strong>本轮使用的项目</strong>
          <p>{project}</p>
          <button
            className="text-button"
            disabled={disabled}
            onClick={() => onUse("")}
          >
            本轮不带入此项目
          </button>
        </div>
      )}
      {stories.length > 0 && (
        <ul className="project-list">
          {stories.map((s) => (
            <li key={s.id}>
              <strong>{s.name}</strong>
              <div>
                <button
                  className="text-button"
                  disabled={disabled}
                  onClick={() => {
                    onUse(
                      `项目：${s.name}\n背景与目标：${s.background}\n我亲自做的事：${s.action}\n结果与证据：${s.result || "尚未补充，不得编造"}\n与目标岗位的联系：${s.relevance || "待说明"}`,
                    );
                    setNotice("已用于本轮；生成面试问题时将随资料发送给 AI。");
                  }}
                >
                  用于本轮面试
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    setDraft(s);
                    setNotice("正在编辑已保存项目，修改后请重新保存。");
                  }}
                >
                  编辑
                </button>
                <button
                  className="text-button"
                  onClick={() => {
                    if (
                      confirm(
                        "删除该项目素材？已开始的面试、训练记录仍保留原来的项目快照。",
                      )
                    ) {
                      if (
                        commit(stories.filter((v) => v.id !== s.id)) &&
                        draft.id === s.id
                      )
                        setDraft(empty());
                    }
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="journey-fields">
        <label>
          项目名称
          <input
            maxLength={100}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="例如：客户工单处理流程优化"
          />
        </label>
        <label>
          背景与目标
          <textarea
            maxLength={400}
            rows={3}
            value={draft.background}
            onChange={(e) => setDraft({ ...draft, background: e.target.value })}
            placeholder="当时存在什么问题？你们要解决什么？"
          />
        </label>
        <label>
          我亲自做的事
          <textarea
            maxLength={800}
            rows={4}
            value={draft.action}
            onChange={(e) => setDraft({ ...draft, action: e.target.value })}
            placeholder="你的职责、关键行动和取舍理由，区分自己与团队的工作。"
          />
        </label>
        <label>
          结果与证据
          <textarea
            maxLength={500}
            rows={4}
            value={draft.result}
            onChange={(e) => setDraft({ ...draft, result: e.target.value })}
            placeholder="上线变化、用户反馈、可核实数据；暂时没有结果也可说明验证计划。"
          />
        </label>
        <label>
          与目标岗位的联系
          <textarea
            maxLength={400}
            rows={3}
            value={draft.relevance}
            onChange={(e) => setDraft({ ...draft, relevance: e.target.value })}
            placeholder="这段经历证明哪项岗位能力？仍有什么差距？"
          />
        </label>
      </div>
      <div className="journey-actions">
        <button className="button secondary" onClick={save}>
          保存项目素材
        </button>
        <button
          className="text-button"
          onClick={() => {
            if (
              (draft.name || draft.action) &&
              !confirm("新增另一段经历？请确认当前编辑内容已经保存。")
            )
              return;
            setDraft(empty());
            setNotice("");
          }}
        >
          新增另一段经历
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
