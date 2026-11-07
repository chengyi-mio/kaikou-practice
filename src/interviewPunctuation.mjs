// Local, conservative punctuation only. Never invent words or correct ASR terminology.
export function punctuateAnswer(value, words = []) {
  const text = String(value || '');
  if (!/\p{Script=Han}/u.test(text)) return text;
  const marks = new Map();
  const priority = { '，': 1, '；': 2, '。': 3 };
  function add(at, mark) {
    if (at <= 0 || at > text.length) return;
    const before = text.slice(0, at).trimEnd(), after = text.slice(at).trimStart();
    if (!before || /[\p{P}\p{S}]$/u.test(before) || /^[\p{P}\p{S}]/u.test(after)) return;
    if (!marks.has(at) || priority[mark] > priority[marks.get(at)]) marks.set(at, mark);
  }
  // Timing is used only when the provider's character offsets match this text.
  let lastBoundary = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (!Number.isInteger(a.endChar) || !Number.isInteger(a.startChar) || text.slice(a.startChar, a.endChar) !== a.text || text.slice(b.startChar, b.endChar) !== b.text || b.startChar < a.endChar) continue;
    const gap = b.start - a.end;
    if (!Number.isFinite(gap) || gap < 0.35 || text.slice(lastBoundary, a.endChar).replace(/[\p{P}\s]/gu, '').length < 6) continue;
    add(a.endChar, gap >= 0.85 ? '。' : '，'); lastBoundary = a.endChar;
  }
  const enumerations = [...text.matchAll(/第[一二三四五六七八九十\d]+(?:个|点|步|项)?(?:就是|是|呢)/g)];
  if (enumerations.length >= 2) for (const match of enumerations) add(match.index, '；');
  for (const match of text.matchAll(/首先|其次|再次|最后|然后|但是|所以|因此|另外|那么|同时|比如说|例如/g)) {
    const previous = text.slice(0, match.index).split(/[。！？；，,;!?\n]/).at(-1);
    const lastMark = Math.max(0, ...[...marks.keys()].filter(n => n < match.index));
    if (previous.length >= 6 && match.index - lastMark >= 6) add(match.index, /^(其次|再次|最后)$/.test(match[0]) ? '；' : '，');
  }
  const end = text.trimEnd().length;
  add(end, '。');
  let result = text;
  for (const [at, mark] of [...marks].sort((a,b) => b[0]-a[0])) result = result.slice(0,at)+mark+result.slice(at);
  return result;
}
