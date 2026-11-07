import { answerCharacters } from '../server/interview-readiness.mjs';
// Preserve provider item order; transcription completion may arrive after the reply.
export function transcriptEvent(messages, event) {
  if (event.type === "response.done" && ["cancelled", "incomplete", "failed"].includes(event.response?.status)) {
    const ids = new Set((event.response.output || []).map((item) => item.id));
    return messages.map(m => m.role === "assistant" && ids.has(m.id) ? { ...m, interrupted: true } : m);
  }
  let id = event.item_id || event.item?.id;
  let role, text, final;
  const t = event.type || "";
  if (t === "input_audio_buffer.speech_started") role = "user";
  if (t === "conversation.item.created" || t === "response.output_item.added") {
    role = event.item?.role;
    if (!["user", "assistant"].includes(role)) return messages;
    text =
      event.item?.content?.map((c) => c.transcript || c.text || "").join("") ||
      undefined;
  }
  if (t.startsWith("conversation.item.input_audio_transcription.")) {
    role = "user";
    if (t.endsWith("completed")) {
      text = event.transcript;
      final = true;
    } else if (t.endsWith("delta"))
      text =
        typeof event.text === "string"
          ? event.text + (event.stash || "")
          : (messages.find((m) => m.id === id)?.text || "") +
            (event.delta || "");
  }
  if (
    t.startsWith("response.audio_transcript.") ||
    t.startsWith("response.text.")
  ) {
    role = "assistant";
    if (t.endsWith("done")) {
      text = event.transcript ?? event.text;
      final = true;
    } else if (t.endsWith("delta"))
      text =
        (messages.find((m) => m.id === id)?.text || "") + (event.delta || "");
  }
  if (!id || !["user", "assistant"].includes(role)) return messages;
  const existing = messages.findIndex((m) => m.id === id);
  if (existing >= 0) {
    return messages.map((m, i) =>
      i !== existing || (m.final && !final)
        ? m
        : {
            ...m,
            ...(typeof text === "string" ? { text } : {}),
            ...(final ? { final: true } : {}),
          },
    );
  }
  const next = {
    id,
    role,
    text: typeof text === "string" ? text : "",
    final: Boolean(final),
  };
  const preceding = messages.findIndex((m) => m.id === event.previous_item_id);
  if (preceding >= 0)
    return [
      ...messages.slice(0, preceding + 1),
      next,
      ...messages.slice(preceding + 1),
    ];
  return [...messages, next];
}

export function reviewTurns(messages) {
  const turns = [];
  let question = "",
    questionId = "";
  for (const m of messages) {
    if (m.role === "assistant" && m.interrupted && m.text.trim().length >= 6) { question = ""; questionId = ""; }
    if (m.role === "assistant" && m.final && !m.interrupted && (m.text.trim().length >= 6 || /[?？]$/.test(m.text.trim()))) {
      question = m.text.trim();
      questionId = m.id;
    }
    if (m.role !== "user" || !m.final || !question || !m.text.trim()) continue;
    const last = turns.at(-1);
    if (last?.id === questionId) last.answer += "\n" + m.text.trim();
    else turns.push({ id: questionId, question, answer: m.text.trim() });
  }
  return turns
    .filter((t) => answerCharacters(t.answer) >= 5)
    .map(({ question, answer }) => ({ question, answer }));
}
