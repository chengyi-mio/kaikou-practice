import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import { parseInterview } from "../server/interview.mjs";
import { interviewInput } from '../server/interview.mjs';
import { liveSession } from '../server/realtime.mjs';
import { analysisInput } from '../server/feedback.mjs';

const input = { action: "feedback", role: "产品经理", resume: "有多年产品设计经验，负责过需求分析和项目沟通协调。", job: "负责产品规划，协调研发团队并推进项目按期交付。", history: [{ question: "请介绍一次项目经历？", answer: "我负责梳理需求并与研发确认优先级。" }] };
test('项目素材与转岗重点进入面试规则，但准备资料不得作为回答证据', async () => {
  const candidate = {...input, stage:'transition', project:'我负责工单系统优化，处理速度提高。'};
  assert.equal(interviewInput.parse(candidate).stage, 'transition');
  assert.equal(interviewInput.safeParse({...candidate,stage:'untrusted'}).success, false);
  const instructions=liveSession({...candidate,history:[],silence:2000}).instructions;
  assert.match(instructions,/可迁移能力/);
  assert.match(instructions,/不是本次已经说出的回答/);
  assert.match(instructions,/工单系统/);
  const report=parseInterview(JSON.stringify({summary:'六维报告',dimensions:['岗位匹配','回答结构','个人贡献','结果证据','问题回应','复盘反思'].map(name=>({name,score:4,evidence:name==='结果证据'?'处理速度提高':'我负责梳理需求',advice:'补充可核实的实际变化。'})),nextStep:'先练结果证据。'}),candidate);
  assert.equal(report.dimensions.length,6);
  assert.equal(report.dimensions[3].score,null);
  assert.equal(report.dimensions[2].score,4);
  const analysis=analysisInput.parse({transcript:input.history[0].answer,topic:'介绍一个项目',mode:'logic',interviewContext:{role:input.role,job:input.job,project:candidate.project}});
  assert.equal(analysis.interviewContext.project,candidate.project);
});
test("面试复盘只对可在回答中找到的原话保留分数", () => {
  const result = parseInterview(JSON.stringify({ summary: "有条理", dimensions: [{ name: "具体证据", score: 4, evidence: "我负责梳理需求", advice: "说明具体结果。" }, { name: "岗位匹配", score: 5, evidence: "提高收入百分之五十", advice: "补充可核实的结果。" }], nextStep: "用一个例子再练。" }), input);
  assert.equal(result.dimensions[0].score, 4);
  assert.equal(result.dimensions[1].score, null);
  assert.equal(result.dimensions[1].evidence, "");
});
test("模型未配置或输出无效时，不返回伪造的面试结果", async () => {
  const server = createApp({ env: {} }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/interview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /连接 AI/);
    assert.throws(() => parseInterview("不是 JSON", input));
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test("简历和岗位内容作为资料传给模型，追问包含真实历史", async () => {
  let request;
  const server = createApp({ env: { AI_API_KEY: "test", AI_BASE_URL: "https://example.com/v1", AI_MODEL: "model" }, fetcher: async (_url, options) => { request = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: '{"question":"你如何确定需求优先级？"}' } }] }); } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/interview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, action: "question" }) });
    assert.equal((await response.json()).question, "你如何确定需求优先级？");
    assert.match(request.messages[0].content, /不可信资料/);
    assert.equal(JSON.parse(request.messages[1].content).history[0].answer, input.history[0].answer);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
