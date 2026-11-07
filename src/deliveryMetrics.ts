import type { TranscriptSegment } from "./types";

export type DeliveryMetrics = {
  voicedSeconds: number;
  charactersPerMinute: number;
  pauses: { start: number; duration: number }[];
};

export function deliveryMetrics(text: string, segments?: TranscriptSegment[], words?: TranscriptSegment[]): DeliveryMetrics | undefined {
  if (!segments?.length || !text.trim()) return undefined;
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  if (ordered.some((part, i) => part.start < 0 || part.end <= part.start || part.end > 300 || part.startChar < 0 || part.endChar > text.length || text.slice(part.startChar, part.endChar) !== part.text || (i > 0 && (part.start < ordered[i - 1].end - 0.15 || part.startChar < ordered[i - 1].endChar)))) return undefined;
  if (ordered.map((part) => part.text).join("").replace(/\s/gu, "") !== text.replace(/\s/gu, "")) return undefined;
  const characters = [...text.replace(/[\s\p{P}\p{S}]/gu, "")].length;
  const alignedWords = words?.filter((part) => part.start >= 0 && part.end > part.start && part.end <= 300 && text.slice(part.startChar, part.endChar) === part.text).sort((a, b) => a.start - b.start) || [];
  const wordCharacters = [...alignedWords.map((part) => part.text).join("").replace(/[\s\p{P}\p{S}]/gu, "")].length;
  const timed = alignedWords.length > 1 && wordCharacters >= characters * 0.9 && alignedWords.every((part, i) => i === 0 || (part.start >= alignedWords[i - 1].end - 0.15 && part.startChar >= alignedWords[i - 1].endChar)) ? alignedWords : ordered;
  const voicedSeconds = timed.reduce((sum, part) => sum + part.end - part.start, 0);
  if (Math.round(voicedSeconds * 10) / 10 < 3) return undefined;
  const pauses = timed.slice(1).map((part, i) => ({ start: timed[i].end, duration: part.start - timed[i].end })).filter((gap) => gap.duration >= 0.8);
  return { voicedSeconds: Math.round(voicedSeconds * 10) / 10, charactersPerMinute: Math.round(characters / voicedSeconds * 60), pauses };
}

export function timeForEvidence(quote: string, text: string, segments?: TranscriptSegment[], words?: TranscriptSegment[]): number | undefined {
  if (!quote || !segments?.length) return undefined;
  const index = text.indexOf(quote);
  if (index < 0 || text.indexOf(quote, index + 1) >= 0) return undefined;
  const valid = (part: TranscriptSegment) => Number.isFinite(part.start) && part.start >= 0 && part.end > part.start && text.slice(part.startChar, part.endChar) === part.text;
  const word = words?.find((part) => part.endChar > index && part.startChar < index + quote.length && valid(part));
  if (word) return word.start;
  const segment = segments.find((part) => part.startChar <= index && part.endChar > index && valid(part));
  return segment?.start;
}
