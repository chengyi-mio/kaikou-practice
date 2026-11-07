const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function usageEntry(response, context) {
  if (!response?.id || !response.usage || typeof response.id !== "string") return null;
  const u = response.usage;
  const total = count(u.total_tokens);
  if (total === null) return null;
  return {
    id: `${context.connection}:${response.id}`, responseId: response.id,
    model: context.model, at: new Date().toISOString(), status: String(response.status || "unknown"),
    total, input: count(u.input_tokens), output: count(u.output_tokens),
    inputText: count(u.input_tokens_details?.text_tokens), inputAudio: count(u.input_tokens_details?.audio_tokens),
    outputText: count(u.output_tokens_details?.text_tokens), outputAudio: count(u.output_tokens_details?.audio_tokens),
  };
}
export function usageTotals(entries) {
  const fields = ["total", "input", "output", "inputText", "inputAudio", "outputText", "outputAudio"];
  return Object.fromEntries(fields.map((field) => [field,
    entries.length && entries.every((e) => count(e[field]) !== null)
      ? entries.reduce((n, e) => n + e[field], 0) : null,
  ]));
}
