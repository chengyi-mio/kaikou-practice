import { useEffect, useState } from "react";
import { ArrowRight, Briefcase, CheckCircle } from "@phosphor-icons/react";
import { go } from "./components";
import { getSessions } from "./storage";
import type { Session } from "./types";
import {
  getInterviewTask,
  interviewPracticePath,
  readInterviewTasks,
  removeInterviewTask,
  saveInterviewTask,
  taskAttempts,
} from "./interviewTraining";
import type {
  InterviewSource,
  InterviewReport,
  InterviewTurn,
  InterviewTask,
} from "./interviewTraining";
import "./interview-journey.css";

export function InterviewHome({ sessions }: { sessions: Session[] }) {
  let tasks: InterviewTask[] = [];
  try {
    tasks = readInterviewTasks();
  } catch {
    /* the workspace presents the actionable error */
  }
  const next = tasks.find((t) => !taskAttempts(t, sessions).length);
  return (
    <section className="interview-home" aria-label="求职面试训练">
      <div>
        <Briefcase size={28} />
        <h2>把做过的事，讲成岗位需要的能力</h2>
        <p>
          跳槽、转岗前，先用自己的项目练一场。发现短板后，再回到表达训练逐个补齐。
        </p>
        <ol>
          <li>准备岗位与项目</li>
          <li>逐轮 / LIVE 面试</li>
          <li>补练后再检验</li>
        </ol>
      </div>
      <div className="journey-actions">
        <button className="button primary" onClick={() => go("/interview")}>
          进入面试工作台 <ArrowRight size={18} />
        </button>
        {next ? (
          <button
            className="button secondary"
            onClick={() => go(interviewPracticePath(next))}
          >
            继续补练 · {next.focus}
          </button>
        ) : (
          <button
            className="text-button"
            onClick={() =>
              go(
                "/practice/logic?scene=interview&framework=STAR&profile=interview&question=" +
                  encodeURIComponent(
                    "请用一个真实项目，说明你的个人贡献与实际结果。",
                  ),
              )
            }
          >
            先练一次项目表达
          </button>
        )}
      </div>
    </section>
  );
}

export function InterviewNextSteps({
  source,
  report,
  turns,
  origin,
  disabled = false,
}: {
  source: InterviewSource;
  report: InterviewReport;
  turns: InterviewTurn[];
  origin: "turn" | "live";
  disabled?: boolean;
}) {
  const ranked = report.dimensions
    .map((d, i) => ({ ...d, order: i }))
    .sort((a, b) => (a.score ?? -1) - (b.score ?? -1));
  const [choice, setChoice] = useState(ranked[0]?.order ?? 0);
  const focus = report.dimensions[choice] || report.dimensions[0];
  const evidenceIndex = turns.findIndex(
    (t) => focus?.evidence && t.answer.includes(focus.evidence),
  );
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const selected =
    turns[turnIndex ?? (evidenceIndex < 0 ? turns.length - 1 : evidenceIndex)];
  const [error, setError] = useState("");
  if (!focus || !selected) return null;
  function start() {
    try {
      const task = saveInterviewTask({
        origin,
        source,
        focus: focus.name,
        advice: focus.advice,
        evidence: selected.answer.includes(focus.evidence)
          ? focus.evidence
          : "",
        question: selected.question,
        originalAnswer: selected.answer,
        reportSummary: report.summary,
      });
      go(interviewPracticePath(task));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="interview-next" aria-label="面试复盘转专项训练">
      <h3>这次先补一个短板</h3>
      <p className="journey-focus">{focus.advice}</p>
      {focus.evidence && selected.answer.includes(focus.evidence) && <blockquote className="journey-evidence">{focus.evidence}</blockquote>}
      <p className="journey-selected-question">练习原题：{selected.question}</p>
      <details className="journey-adjustment"><summary>调整练习重点与题目 <span>{focus.name}</span></summary><div className="journey-fields">
        <label>
          本次练习重点
          <select
            value={choice}
            disabled={disabled}
            onChange={(e) => {
              setChoice(Number(e.target.value));
              setTurnIndex(null);
            }}
          >
            {ranked.map((d) => (
              <option key={d.order} value={d.order}>
                {d.name} · {d.score === null ? "待补充证据" : `${d.score} / 5`}
              </option>
            ))}
          </select>
        </label>
        <label>
          用哪道题来练
          <select
            value={
              turnIndex ??
              (evidenceIndex < 0 ? turns.length - 1 : evidenceIndex)
            }
            disabled={disabled}
            onChange={(e) => setTurnIndex(Number(e.target.value))}
          >
            {turns.map((t, i) => (
              <option key={i} value={i}>
                第 {i + 1} 题 · {t.question}
              </option>
            ))}
          </select>
        </label>
      </div></details>
      {!focus.evidence && (
        <small>这项反馈没有可定位的原话，请核对选中的题目是否适合补练。</small>
      )}
      <button className="button primary" disabled={disabled} onClick={start}>
        去练这一项 · {focus.name} <ArrowRight size={18} />
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function InterviewPracticeGuide({
  task,
  retest,
}: {
  task: InterviewTask;
  retest: boolean;
}) {
  return (
    <section className="interview-practice-guide" aria-label="面试专项练习">
      <div className="journey-title">
        <h2>
          {retest ? "原题复测" : "面试专项补练"} · {task.focus}
        </h2>
        <span>{task.source.role || "我的目标岗位"}</span>
      </div>
      <p>
        {retest
          ? "先独立回答，不看上一版。保存后可以对照原话检查变化。"
          : task.advice}
      </p>
      {!retest && (
        <>
          <ol>
            {task.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <details>
            <summary>回看面试原话与岗位要求</summary>
            <blockquote>{task.originalAnswer}</blockquote>
            <p>{task.source.job}</p>
          </details>
        </>
      )}
      <small>本次会单独保存，不会把旧回答填入新答案，也不会覆盖原面试。</small>
    </section>
  );
}

export function InterviewReturn({
  session,
  disabled = false,
}: {
  session: Session;
  disabled?: boolean;
}) {
  const task =
    session.interviewTraining || getInterviewTask(session.interviewTaskId);
  if (!task) return null;
  return (
    <section className="interview-return" aria-label="回到面试训练">
      <h3>练完这一点，回到面试中试一试</h3>
      <p>
        本次{session.interviewAttempt === "retest" ? "复测" : "补练"}
        与原面试关联保存。
        {session.feedback?.source === "basic"
          ? "当前是基础反馈，仍可在记录中生成 AI 点评。"
          : "可以回看原话，检验是否更具体。"}
      </p>
      <details>
        <summary>对比面试原话与这次回答</summary>
        <div className="journey-comparison">
          <div>
            <h4>面试原话</h4>
            <p>{task.originalAnswer}</p>
          </div>
          <div>
            <h4>这次回答</h4>
            <p>{session.transcript}</p>
          </div>
        </div>
        <small>对照同一道题的表达变化；不同点评标准的分数不直接比较。</small>
      </details>
      <div className="journey-actions">
        <button
          className="button primary"
          disabled={disabled}
          onClick={() => go("/interview")}
        >
          回到面试工作台
        </button>
        <button
          className="button secondary"
          disabled={disabled}
            onClick={() => go(`${interviewPracticePath(task, true)}&retry=${encodeURIComponent(session.id)}`)}
        >
          同题独立复测
        </button>
      </div>
    </section>
  );
}

export function InterviewTrainingHistory() {
  const [tasks, setTasks] = useState<InterviewTask[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState("");
  const [all, setAll] = useState(false);
  useEffect(() => {
    let active = true;
    try {
      setTasks(readInterviewTasks());
    } catch (e) {
      setError((e as Error).message);
    }
    void getSessions()
      .then((s) => {
        if (active) setSessions(s);
      })
      .catch(() => {
        if (active)
          setError("暂时无法读取补练结果，请重新打开工作台；已有数据未改动。");
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section
      className="interview-panel interview-training-history"
      id="interview-training"
    >
      <h2>面试后的专项训练</h2>
      <p>
        从复盘选择一个重点，每次只改一件事。保存补练后，可以查看回答并独立复测。
      </p>
      {error && <p role="alert">{error}</p>}
      {!tasks.length && !error && (
        <div className="journey-empty">
          <CheckCircle size={24} />
          <div>
            <strong>先完成一题面试，就能开始补练</strong>
            <p>
              生成 AI 面试复盘 → 选择短板 →
              针对性表达训练。无需等待完成整场面试。
            </p>
          </div>
        </div>
      )}
      {(all ? tasks : tasks.slice(0, 4)).map((t) => {
        const attempts = taskAttempts(t, sessions);
        return (
          <article className="journey-task" key={t.id}>
            <div>
              <span>
                {t.source.role || "目标岗位"} ·{" "}
                {t.origin === "live" ? "LIVE" : "逐轮面试"}
              </span>
              <h3>{t.focus}</h3>
              <p>{t.question}</p>
              <small>
                {attempts.length
                  ? `已保存 ${attempts.length} 次训练 · ${attempts.filter((a) => a.interviewAttempt === "retest").length} 次复测`
                  : "尚未保存补练"}
              </small>
            </div>
            <div className="journey-actions">
              <button
                className="button secondary"
                onClick={() => go(interviewPracticePath(t))}
              >
                {attempts.length ? "再练这一项" : "开始补练"}
              </button>
              {attempts[0] && (
                <>
                  <button
                    className="text-button"
                    onClick={() => go(`/record/${attempts[0].id}`)}
                  >
                    查看最近回答
                  </button>
                  <button
                    className="text-button"
                    onClick={() => go(interviewPracticePath(t, true))}
                  >
                    同题复测
                  </button>
                </>
              )}
              <button
                className="text-button"
                onClick={() => {
                  if (
                    !confirm(
                      "移除这个补练入口？面试、已保存的练习和录音仍保留。",
                    )
                  )
                    return;
                  try {
                    removeInterviewTask(t.id);
                    setTasks(readInterviewTasks());
                  } catch {
                    setError("移除失败，请检查本机存储后重试。");
                  }
                }}
              >
                移除任务
              </button>
            </div>
          </article>
        );
      })}
      {tasks.length > 4 && (
        <button className="text-button" onClick={() => setAll(!all)}>
          {all ? "收起任务" : `展开全部 ${tasks.length} 项`}
        </button>
      )}
    </section>
  );
}
