export const minimumAnswerCharacters = 5;
export function answerCharacters(text) {
  return (String(text || '').match(/[\p{L}\p{N}]/gu) || []).length;
}
export function reviewReadiness(turns) {
  if (!Array.isArray(turns) || !turns.length) return { ready: false, message: '还没有可复盘的回答。至少回答 1 道问题即可，不需要答得很好。' };
  if (turns.some(t => !t.question?.trim())) return { ready: false, message: '回答需要对应一道明确的面试题，请先生成问题。' };
  if (turns.some(t => answerCharacters(t.answer) < minimumAnswerCharacters)) return { ready: false, message: '回答内容太少，暂时无法生成面试复盘。每题至少 5 个有效字（不计空格和标点），请补充你做了什么或具体例子。' };
  return { ready: true, message: `已有 ${turns.length} 题可复盘。${turns.length < 3 ? '现在即可生成；建议练习 3 题以上，让反馈更充分。' : '将根据本轮实际回答给出建议。'}` };
}
