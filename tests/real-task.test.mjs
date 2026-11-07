import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import { analysisInput } from "../server/feedback.mjs";
import { buildAgnesMessages, coachingStandard } from "../server/agnes.mjs";

const input = {
  mode: "logic", topic: "请向主管解释延期", transcript: "项目延期两天，原因是测试环境未就绪。我今天联系测试团队确认，明天下午同步新的交付时间。", duration: 35,
  framework: "因果分析：现象 → 原因 → 影响 → 行动", ruleProfile: "report",
  realTask: { kind: "delay", audience: "主管", goal: "解释延期原因和补救安排", context: "测试环境仍在排查，影响暂未确认", criteria: "直接说明延期；说明已确认原因；交代下次更新时间。" },
};

test("a real task keeps user-confirmed goals in the Agnes rubric without treating background as spoken evidence", () => {
  assert.equal(analysisInput.parse(input).realTask.goal, input.realTask.goal);
  const rubric = coachingStandard(input);
  assert.match(rubric.dimensions[0].standard, /解释延期原因和补救安排/);
  assert.match(rubric.dimensions[5].standard, /下次更新时间/);
  const message = JSON.parse(buildAgnesMessages(input)[1].content);
  assert.deepEqual(message.realTask, input.realTask);
  assert.equal(message.transcript, input.transcript);
  assert.equal(analysisInput.safeParse({ ...input, realTask: { ...input.realTask, criteria: "字".repeat(501) } }).success, false);
});

async function serve(options, run) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await once(server, "listening");
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("follow-up needs a real chat model and returns one validated question", async () => {
  const body = { topic: input.topic, transcript: input.transcript, realTask: input.realTask };
  const post = (base) => fetch(`${base}/api/followup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await serve({ env: {} }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /连接模型/);
  });
  await serve({ env: { AI_API_KEY: "fictional", AI_BASE_URL: "https://api.typesafe.ai", AI_MODEL: "jev" } }, async (base) => {
    assert.equal((await post(base)).status, 422);
  });
  await serve({
    env: { AI_API_KEY: "fictional", AI_BASE_URL: "https://apihub.agnes-ai.com/v1", AI_MODEL: "test" },
    fetcher: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.deepEqual(JSON.parse(request.messages[1].content), body);
      assert.ok(request.max_tokens >= 1000, "reasoning model needs room for visible question text");
      return Response.json({ choices: [{ message: { content: '{"question":"如果测试环境明天仍未就绪，你准备什么时候通知相关同事？"}' } }] });
    },
  }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 200);
    assert.match((await response.json()).question, /什么时候通知/);
  });
});

test("follow-up accepts one plain spoken question but rejects commentary or multiple questions", async () => {
  const { parseFollowupQuestion } = await import("../server/app.mjs");
  assert.equal(parseFollowupQuestion("追问：如果这周还不能交付，你准备先通知谁？"), "如果这周还不能交付，你准备先通知谁？");
  assert.equal(parseFollowupQuestion('{"question":"如果这周还不能交付，你准备先通知谁？"}'), "如果这周还不能交付，你准备先通知谁？");
  assert.equal(parseFollowupQuestion("这次大概会延迟多久？对后续节点会有什么影响？"), "这次大概会延迟多久？");
  assert.throws(() => parseFollowupQuestion("先说明时间，再解释风险。"));
  assert.throws(() => parseFollowupQuestion("先做这些事：\n什么时候通知？"));
});
