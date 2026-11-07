import type { RealTask, RuleProfile } from "./types";

export const realTaskTemplates: Record<RealTask["kind"], {
  label: string;
  goal: string;
  criteria: string;
  framework: string;
  profile: RuleProfile;
  hint: string;
}> = {
  report: {
    label: "工作汇报",
    goal: "说清当前进展、阻碍和下一步",
    criteria: "先说结论；交代已确认的事实；明确下一步的负责人和时间。",
    framework: "SCQA",
    profile: "report",
    hint: "适合需要交代变化和方案的汇报；若只需简短同步，可直接按已完成、阻碍、下一步说。",
  },
  delay: {
    label: "解释延期",
    goal: "解释延期原因、影响及补救安排",
    criteria: "直接说明延期；区分已确认原因与待核实事项；说明影响、补救行动及下次更新时间。",
    framework: "CAUSE",
    profile: "report",
    hint: "先承认变化，再说明原因和补救；不要用含糊理由代替事实。",
  },
  request: {
    label: "提出需求",
    goal: "让对方理解需求并确认下一步",
    criteria: "明确提出请求；说明原因和对方需要投入什么；回应可能的顾虑并约定下一步。",
    framework: "PREP",
    profile: "persuade",
    hint: "先说请求，再解释价值和对方需要做的事。",
  },
  interview: {
    label: "面试回答",
    goal: "用真实经历回答面试问题",
    criteria: "说清情境和任务；突出本人行动；交代实际结果和经验，不编造数字。",
    framework: "STAR",
    profile: "interview",
    hint: "用一件真实经历作答，重点说自己的行动和结果。",
  },
};

export function realTaskQuestion(task: RealTask) {
  return `请向${task.audience.trim() || "对方"}${task.goal.trim()}`;
}
