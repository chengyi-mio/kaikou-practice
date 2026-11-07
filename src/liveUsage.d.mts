export type UsageEntry = { id: string; responseId: string; model: string; at: string; status: string; total: number; input: number | null; output: number | null; inputText: number | null; inputAudio: number | null; outputText: number | null; outputAudio: number | null };
export function usageEntry(response: unknown, context: { connection: string; model: string }): UsageEntry | null;
export function usageTotals(entries: UsageEntry[]): Record<'total' | 'input' | 'output' | 'inputText' | 'inputAudio' | 'outputText' | 'outputAudio', number | null>;
