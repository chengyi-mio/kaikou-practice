export type LiveMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  final: boolean;
  interrupted?: boolean;
};
export function transcriptEvent(
  messages: LiveMessage[],
  event: Record<string, unknown>,
): LiveMessage[];
export function reviewTurns(
  messages: LiveMessage[],
): { question: string; answer: string }[];
