import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTranscription } from "../server/app.mjs";
import { createApp } from "../server/app.mjs";
import { once } from "node:events";
import { deliveryMetrics, timeForEvidence } from "../src/deliveryMetrics.ts";

test("timestamped transcription keeps exact character offsets and refuses mismatched text", () => {
  const aligned = normalizeTranscription({
    text: "项目延期了。明天下午同步。",
    segments: [
      { start: 0.5, end: 2.0, text: "项目延期了。", words: [{ start: 0.55, end: 0.9, word: "项目" }, { start: 1.0, end: 1.7, word: "延期了" }] },
      { start: 3.1, end: 4.6, text: "明天下午同步。" },
    ],
  });
  assert.equal(aligned.segments.length, 2);
  assert.equal(aligned.segments[1].startChar, 6);
  assert.equal(timeForEvidence("明天下午同步。", aligned.text, aligned.segments), 3.1);
  assert.equal(timeForEvidence("延期了", aligned.text, aligned.segments, aligned.words), 1.0);
  assert.equal(deliveryMetrics(aligned.text, aligned.segments).pauses[0].duration, 1.1);
  assert.equal(timeForEvidence("不存在的原话", aligned.text, aligned.segments), undefined);
  assert.deepEqual(normalizeTranscription({ text: "真实文字", segments: [{ start: 0, end: 2, text: "错误文字" }] }), { text: "真实文字" });
});

test("ambiguous evidence and invalid timestamps never produce a seek or speech rate", () => {
  const text = "项目延期了。项目延期了。";
  const segments = [
    { start: 0, end: 2, text: "项目延期了。", startChar: 0, endChar: 6 },
    { start: 3, end: 5, text: "项目延期了。", startChar: 6, endChar: 12 },
  ];
  assert.equal(timeForEvidence("项目延期了。", text, segments), undefined);
  assert.equal(deliveryMetrics(text, [{ ...segments[0], endChar: 5 }]), undefined);
  assert.equal(deliveryMetrics(text, undefined), undefined);
});

test("whisper cloud transcription requests real timestamps and returns only aligned words", async () => {
  const server = createApp({
    env: { ASR_API_KEY: "fictional", ASR_BASE_URL: "https://example.test/v1", ASR_MODEL: "whisper-1" },
    fetcher: async (_url, options) => {
      assert.equal(options.body.get("response_format"), "verbose_json");
      assert.deepEqual(options.body.getAll("timestamp_granularities[]"), ["segment", "word"]);
      return Response.json({ text: "项目延期了。明天下午同步。", segments: [{ start: 0.2, end: 1.8, text: "项目延期了。" }, { start: 2.7, end: 4.0, text: "明天下午同步。" }], words: [{ start: 2.8, end: 3.2, word: "明天" }] });
    },
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const body = new FormData();
    body.append("audio", new Blob(["RIFFtest"], { type: "audio/wav" }), "test.wav");
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/transcribe`, { method: "POST", body });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.segments[1].startChar, 6);
    assert.equal(data.words[0].start, 2.8);
    assert.equal(data.internal, undefined);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
