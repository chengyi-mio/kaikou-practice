import type { RealTask, Session } from "./types";

export type InterviewSource = {
  role: string;
  resume: string;
  job: string;
  stage?: string;
  project?: string;
};
export type InterviewReport = {
  summary: string;
  dimensions: {
    name: string;
    score: number | null;
    evidence: string;
    advice: string;
  }[];
  nextStep: string;
};
export type InterviewTurn = { question: string; answer: string };
export const interviewStages = [
  {
    id: "general",
    name: "综合面试",
    hint: "从岗位要求出发，逐步覆盖经历、动机和能力。",
  },
  {
    id: "project",
    name: "项目深挖",
    hint: "说明你负责什么、为什么这样做、如何证明结果。",
  },
  {
    id: "match",
    name: "岗位匹配",
    hint: "把岗位要求与自己的真实经历一一对应。",
  },
  {
    id: "transition",
    name: "跳槽 / 转岗",
    hint: "讲清选择动机、可迁移能力，以及还需补齐的差距。",
  },
] as const;
export type InterviewTask = {
  id: string;
  createdAt: string;
  origin: "turn" | "live";
  source: InterviewSource;
  question: string;
  originalAnswer: string;
  focus: string;
  advice: string;
  evidence: string;
  framework: string;
  steps: string[];
  reportSummary: string;
};
const tasksKey = "kaikou.interview.training.v1";

export function readInterviewTasks(): InterviewTask[] {
  const text = localStorage.getItem(tasksKey);
  if (!text) return [];
  const value: unknown = JSON.parse(text);
  if (
    !Array.isArray(value) ||
    value.some(
      (t) =>
        !t ||
        typeof t.id !== "string" ||
        ['question','originalAnswer','focus','advice','evidence','reportSummary','createdAt','framework'].some(k => typeof t[k] !== 'string') ||
        !Array.isArray(t.steps) ||
        t.steps.some((step: unknown) => typeof step !== 'string') ||
        !t.source || ['role','resume','job'].some(k => typeof t.source[k] !== 'string'),
    )
  )
    throw Error("无法读取面试补练记录，原数据已保留。");
  return value;
}
export function getInterviewTask(id?: string | null) {
  if (!id) return undefined;
  try {
    return readInterviewTasks().find((t) => t.id === id);
  } catch {
    return undefined;
  }
}
export function trainingMethod(focus: string) {
  if (/匹配|动机|转岗/.test(focus))
    return {
      framework: "PREP",
      steps: [
        "先说岗位需要什么能力",
        "用一段真实经历作证",
        "说明迁移到新岗位的方法",
        "坦诚指出仍需补齐的差距",
      ],
    };
  if (/回应|重点|简洁/.test(focus))
    return {
      framework: "PREP",
      steps: [
        "第一句直接回答问题",
        "只保留一个核心理由",
        "给出一个具体例子",
        "用一句话回扣问题",
      ],
    };
  return {
    framework: "STAR",
    steps: [
      "用一句话交代背景和目标",
      "区分团队工作与自己的职责",
      "讲清关键行动和取舍理由",
      "说明可核实结果；没有数字就说明事实变化",
    ],
  };
}
export function saveInterviewTask(
  input: Omit<InterviewTask, "id" | "createdAt" | "framework" | "steps">,
): InterviewTask {
  const all = readInterviewTasks();
  const existing = all.find(
    (t) =>
      t.question === input.question &&
      t.originalAnswer === input.originalAnswer &&
      t.focus === input.focus &&
      t.source.job === input.source.job &&
      t.source.role === input.source.role &&
      t.source.resume === input.source.resume &&
      t.source.project === input.source.project &&
      t.source.stage === input.source.stage,
  );
  if (existing) return existing;
  if (all.length >= 100)
    throw Error(
      "补练记录已达 100 条，请先移除不再需要的补练任务；原面试和练习不会删除。",
    );
  const task: InterviewTask = {
    ...input,
    ...trainingMethod(input.focus),
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(tasksKey, JSON.stringify([task, ...all]));
  } catch {
    throw Error("补练任务未保存，请检查本机空间后重试。原面试内容仍在。");
  }
  return task;
}
export function removeInterviewTask(id: string) {
  localStorage.setItem(
    tasksKey,
    JSON.stringify(readInterviewTasks().filter((t) => t.id !== id)),
  );
}
export function interviewPracticePath(task: InterviewTask, retest = false) {
  return `/practice/logic?interviewTask=${encodeURIComponent(task.id)}&framework=${task.framework}${retest ? "&retest=1" : ""}`;
}
export function trainingContext(task: InterviewTask): RealTask {
  return {
    kind: "interview",
    audience: `${task.source.role || "目标岗位"}的面试官`.slice(0, 80),
    goal: `回答这道面试题，重点改善${task.focus}`.slice(0, 180),
    context:
      `岗位要求：${task.source.job.slice(0, 430)}\n真实项目素材：${(task.source.project || "").slice(0, 280)}`.slice(
        0,
        800,
      ),
    criteria: `${task.focus}：${task.advice}\n${task.steps.join("；")}`.slice(
      0,
      500,
    ),
  };
}
export function taskAttempts(task: InterviewTask, sessions: Session[]) {
  return sessions
    .filter((s) => s.interviewTaskId === task.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
