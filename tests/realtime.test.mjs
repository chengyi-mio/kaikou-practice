import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import { liveConfig } from "../server/realtime.mjs";
import { transcriptEvent, reviewTurns } from "../src/liveTranscript.mjs";
const { createRealtimeSettings } = createRequire(import.meta.url)(
  "../desktop/realtime-settings.cjs",
);
const source = {
  resume: "我有五年产品设计经验，负责需求分析、项目交付与团队沟通。",
  job: "负责产品规划和跨团队协作，推进项目按期交付并复盘效果。",
  role: "产品经理",
};
const body = {
  ...source,
  sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
  minutes: 10,
  silence: 2000,
  history: [],
};
const env = {
  LIVE_REGION: "cn-beijing",
  LIVE_WORKSPACE: "test-workspace",
  LIVE_MODEL: "qwen3.8-omni-flash-realtime",
  LIVE_API_KEY: "fake-live-secret",
  LIVE_TRIAL: JSON.stringify({ freeTierOnly: true, remainingTokens: 1000000, expiresAt: new Date(Date.now() + 86400000).toISOString(), checkedAt: Date.now() }),
};
async function server(t, options) {
  const s = createApp(options).listen(0, "127.0.0.1");
  await once(s, "listening");
  t.after(async () => {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  });
  return `http://127.0.0.1:${s.address().port}`;
}
const post = (url, data) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
function settings(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "kaikou-live-test-"));
  // Only the exact directory returned by mkdtemp is removed; never real app data.
  t.after(() => {
    if (
      path.dirname(directory) === path.resolve(os.tmpdir()) &&
      path.basename(directory).startsWith("kaikou-live-test-")
    )
      fs.rmSync(directory, { recursive: true, force: true });
  });
  const env = {
    AI_API_KEY: "original-fake-review-key",
    ASR_API_KEY: "original-fake-asr-key",
  };
  const options = {
    env,
    file: path.join(directory, "live.json"),
    encrypt: (s) => Buffer.from(`test-cipher:${s}`),
    decrypt: (b) => b.toString().replace("test-cipher:", ""),
  };
  return { api: createRealtimeSettings(options), options, env };
}
const config = {
  region: "cn-beijing",
  workspace: "workspace-123",
  model: "qwen3.8-omni-flash-realtime",
  apiKey: "fake-test-key",
};
test("LIVE key persists across blank save and restart, never replaces Agnes/ASR keys", (t) => {
  const { api, options, env } = settings(t);
  api.save(config);
  api.save({ ...config, apiKey: "" });
  const restored = createRealtimeSettings(options);
  assert.equal(restored.read().hasKey, true);
  assert.equal(env.LIVE_API_KEY, config.apiKey);
  assert.equal(env.AI_API_KEY, "original-fake-review-key");
  assert.equal(env.ASR_API_KEY, "original-fake-asr-key");
  assert.ok(!JSON.stringify(restored.read()).includes(config.apiKey));
  assert.throws(() =>
    api.save({ ...config, workspace: "another-space", apiKey: "" }),
  );
  assert.equal(env.LIVE_API_KEY, config.apiKey);
});
test("Unreadable LIVE settings do not break app construction or silently replace key", (t) => {
  const { options } = settings(t);
  fs.writeFileSync(options.file, "broken saved json");
  const api = createRealtimeSettings(options);
  assert.throws(() => api.read());
  assert.throws(() => api.save(config));
  assert.equal(fs.readFileSync(options.file, "utf8"), "broken saved json");
});
test("Encryption failure leaves prior LIVE configuration intact", (t) => {
  const { api, options } = settings(t);
  api.save(config);
  const before = fs.readFileSync(options.file);
  const broken = createRealtimeSettings({
    ...options,
    encrypt: () => {
      throw Error("no OS encryption");
    },
  });
  assert.throws(() => broken.save({ ...config, apiKey: "new-fake-key" }));
  assert.deepEqual(fs.readFileSync(options.file), before);
});
test("Realtime endpoint never accepts arbitrary hosts or reuses review credentials", () => {
  assert.throws(() => liveConfig({ AI_API_KEY: "not-a-realtime-key" }));
  assert.throws(() =>
    liveConfig({ ...env, LIVE_WORKSPACE: "space.evil.example/" }),
  );
  assert.throws(() => liveConfig({ ...env, LIVE_REGION: "evil.example" }));
});
test("LIVE handshake uses private server key and keeps interview rules separate from supplied documents", async (t) => {
  let call;
  const url = await server(t, {
    env,
    refreshConfig: () => {
      throw Error("review settings broken");
    },
    fetcher: async (url, options) => {
      call = { url, options };
      return new Response(body.sdp);
    },
  });
  const response = await post(`${url}/api/realtime/session`, body);
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(
    call.options.headers.Authorization,
    `Bearer ${env.LIVE_API_KEY}`,
  );
  assert.match(
    call.url,
    /^https:\/\/test-workspace.cn-beijing.maas.aliyuncs.com/,
  );
  assert.equal(call.options.body, body.sdp);
  assert.equal(value.session.turn_detection.silence_duration_ms, 2000);
  assert.match(value.session.instructions, /不可信资料/);
  assert.ok(!JSON.stringify(value).includes(env.LIVE_API_KEY));
});
test("Missing config, unauthorized API and invalid SDP return actionable errors, never fake success", async (t) => {
  const missing = await server(t, { env: {} });
  assert.equal(
    (await post(`${missing}/api/realtime/session`, body)).status,
    503,
  );
  const denied = await server(t, {
    env,
    fetcher: async () =>
      new Response("secret provider details", { status: 401 }),
  });
  const response = await post(`${denied}/api/realtime/session`, body);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /密钥无效/);
  const invalid = await server(t, {
    env,
    fetcher: async () => new Response("OK"),
  });
  assert.equal(
    (await post(`${invalid}/api/realtime/session`, body)).status,
    502,
  );
});

test("Free trial fails closed before provider calls without a fresh Beijing quota check", async (t) => {
  let calls = 0;
  for (const change of [
    { LIVE_TRIAL: "" },
    { LIVE_REGION: "ap-southeast-1" },
    { LIVE_TRIAL: JSON.stringify({ freeTierOnly: false, remainingTokens: 1000000 }) },
    { LIVE_TRIAL: JSON.stringify({ freeTierOnly: true, remainingTokens: 10, expiresAt: new Date(Date.now() + 86400000).toISOString(), checkedAt: Date.now() - 13 * 3600000 }) },
  ]) {
    const url = await server(t, { env: { ...env, ...change }, fetcher: async () => { calls++; return new Response(body.sdp); } });
    assert.equal((await post(`${url}/api/realtime/session`, body)).status, 412);
  }
  const url = await server(t, { env, fetcher: async () => { calls++; return new Response(body.sdp); } });
  assert.equal((await post(`${url}/api/realtime/session`, { ...body, minutes: 15 })).status, 400);
  assert.equal(calls, 0);
});

test("Expired quota and FreeTierOnly errors remain blocked without paid fallback", async (t) => {
  const expired = await server(t, { env: { ...env, LIVE_TRIAL: JSON.stringify({ freeTierOnly: true, remainingTokens: 1000000, expiresAt: new Date(Date.now() - 1).toISOString(), checkedAt: Date.now() }) } });
  assert.equal((await post(`${expired}/api/realtime/session`, body)).status, 412);
  let calls = 0;
  const url = await server(t, { env, fetcher: async () => { calls++; return Response.json({ code: "AllocationQuota.FreeTierOnly", secret: "never-print" }, { status: 403 }); } });
  const result = await (await post(`${url}/api/realtime/session`, body)).json();
  assert.match(result.error, /免费额度已用尽/); assert.ok(!JSON.stringify(result).includes("never-print")); assert.equal(calls, 1);
});

test("Quota check cannot silently survive changing credentials or model, blank save retains its original timestamp", (t) => {
  const { api } = settings(t);
  api.save({ ...config, trial: { freeTierOnly: true, remainingTokens: 1000000, expiresAt: new Date(Date.now() + 86400000).toISOString() } });
  const checkedAt = api.read().trial.checkedAt;
  api.save({ ...config, apiKey: "" });
  assert.equal(api.read().trial.checkedAt, checkedAt);
  api.save({ ...config, model: "qwen-another-realtime", apiKey: "" });
  assert.equal(api.read().trial, undefined);
  assert.equal(api.read().hasKey, true);
});
test("Cross-site realtime connections and invalid durations are rejected before provider calls", async (t) => {
  let calls = 0;
  const url = await server(t, {
    env,
    fetcher: async () => {
      calls++;
      return new Response(body.sdp);
    },
  });
  const cross = await fetch(`${url}/api/realtime/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://untrusted.example",
    },
    body: JSON.stringify(body),
  });
  assert.equal(cross.status, 403);
  assert.equal(
    (await post(`${url}/api/realtime/session`, { ...body, minutes: 1000 }))
      .status,
    400,
  );
  assert.equal(calls, 0);
});
test("Late transcription retains original question/answer order, repeated completed event is idempotent", () => {
  let m = [];
  for (const e of [
    {
      type: "response.audio_transcript.done",
      item_id: "q1",
      transcript: "你如何确定优先级？",
    },
    { type: "input_audio_buffer.speech_started", item_id: "a1" },
    {
      type: "response.audio_transcript.done",
      item_id: "q2",
      transcript: "最后结果如何？",
    },
    {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a1",
      transcript: "我对照用户影响和开发成本确定优先级。",
    },
  ])
    m = transcriptEvent(m, e);
  const turns = reviewTurns(m);
  assert.equal(turns[0].question, "你如何确定优先级？");
  assert.equal(turns.length, 1);
  assert.deepEqual(
    transcriptEvent(m, {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "a1",
      transcript: m[1].text,
    }),
    m,
  );
});
test("Unconfirmed, orphaned or empty answers are never treated as completed interview responses", () => {
  const m = [
    { id: "orphan", role: "user", text: "旧草稿不能误提交", final: true },
    { id: "q", role: "assistant", text: "介绍一次经历？", final: true },
    { id: "a", role: "user", text: "还没确认的识别文字", final: false },
  ];
  assert.deepEqual(reviewTurns(m), []);
});

test("Interrupted interviewer fragments do not replace the actual question for answer evidence", () => {
  const messages = [
    {id:'q',role:'assistant',text:'请介绍一个项目经历。',final:true},
    {id:'a1',role:'user',text:'我负责需求分析。',final:true},
    {id:'fragment',role:'assistant',text:'你',final:true},
    {id:'a2',role:'user',text:'也负责跨团队协调。',final:true},
  ];
  const updated = transcriptEvent(messages,{type:'response.done',response:{status:'cancelled',output:[{id:'fragment'}]}});
  assert.equal(updated[2].interrupted,true);
  assert.deepEqual(reviewTurns(updated),[{question:'请介绍一个项目经历。',answer:'我负责需求分析。\n也负责跨团队协调。'}]);
  assert.deepEqual(reviewTurns([...updated,{id:'long',role:'assistant',text:'你如何判断这个方案的',final:true,interrupted:true},{id:'ambiguous',role:'user',text:'我先和同事确认。',final:true}]),reviewTurns(updated));
});
test("LIVE review uses current review model, with quotation evidence validation", async (t) => {
  let request;
  const url = await server(t, {
    env: {
      ...env,
      AI_BASE_URL: "https://review.example/v1",
      AI_MODEL: "review-test",
      AI_API_KEY: "fake-review",
    },
    fetcher: async (url, options) => {
      request = { url, options };
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "需要具体结果",
                dimensions: [
                  {
                    name: "结构",
                    score: 4,
                    evidence: "我负责需求分析",
                    advice: "补充行动",
                  },
                  {
                    name: "证据",
                    score: 5,
                    evidence: "提高一倍收入",
                    advice: "补充真实结果",
                  },
                ],
                nextStep: "说明实际成果",
              }),
            },
          },
        ],
      });
    },
  });
  const res = await post(`${url}/api/realtime/review`, {
    ...source,
    action: "feedback",
    history: [
      { question: "你做了什么？", answer: "我负责需求分析和整理项目优先级。" },
    ],
  });
  const report = await res.json();
  assert.match(request.url, /review.example/);
  assert.equal(request.options.headers.Authorization, "Bearer fake-review");
  assert.equal(report.dimensions[0].score, 4);
  assert.equal(report.dimensions[1].score, null);
});
