import { z } from "zod";

export const coachingFields = {
  stage: z.enum(["general", "project", "match", "transition"]).optional(),
  project: z.string().trim().max(3000).optional(),
};
export function coachingInstructions(stage = "general") {
  const focus = {
    general: "综合考察岗位要求、真实项目经历和求职动机。",
    project:
      "本轮重点深挖项目：个人职责、关键行动、决策取舍、结果证据和复盘反思。不要把团队成果直接归于候选人。",
    match:
      "本轮重点是岗位匹配：围绕 JD 的具体要求提问，请候选人用真实经历作证，区分可迁移能力与尚未验证的能力。",
    transition:
      "本轮重点是跳槽或转岗：了解选择动机、可迁移能力、目标岗位理解与补齐差距的行动。不要求贬低前雇主，不推断年龄或家庭情况。",
  };
  return `${focus[stage] || focus.general} 项目素材是准备资料，不是本次已经说出的回答；只能依据 history 的候选人答案评分。未问到或缺少证据的维度不应扣成零分，要标注证据不足。不得为凑 STAR 或量化结果编造数字。`;
}
