import { prepare, nativePeer } from "./helpers/live-peer";
import { test, expect } from "@playwright/test";
const resume = "我有五年产品设计经验，负责需求分析、项目交付和团队沟通。";
const job = "负责产品规划和需求分析，协调研发团队推进项目按期落地。";
const report = {
  summary: "你说明了本人行动，下一步补充可核实的结果。",
  dimensions: [
    {
      name: "回答结构",
      score: 4,
      evidence: "我负责需求分析",
      advice: "先说结论，再解释行动。",
    },
    {
      name: "具体证据",
      score: null,
      evidence: "",
      advice: "补充实际项目结果，不编造数字。",
    },
  ],
  nextStep: "用一分钟讲清项目结果。",
};
test("LIVE and AI review entries stay visible when realtime status fails", async ({
  page,
}) => {
  await page.route("**/api/realtime/status", (r) =>
    r.fulfill({ status: 503, json: {} }),
  );
  await prepare(page);
  await expect(
    page.getByRole("button", { name: "开始 LIVE 面试", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "生成 AI 面试复盘", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "开始 LIVE 面试", exact: true })
    .click();
  await expect(page.locator(".live-panel > .interview-error")).toContainText("LIVE 服务配置");
  await expect(page.locator(".interview-columns textarea").first()).toHaveValue(
    resume,
  );
});

test("free-only trial blocks unchecked quota without microphone or provider calls", async ({ page }) => {
  await page.route("**/api/realtime/status", r => r.fulfill({ json: { configured: true, trial: { ready: false, message: "请先核对免费额度和用完即停" } } }));
  let calls = 0;
  await page.route("**/api/realtime/session", r => { calls++; return r.abort(); });
  await prepare(page);
  await page.getByRole("button", { name: "开始 LIVE 面试", exact: true }).click();
  await expect(page.locator(".live-panel > .interview-error")).toContainText("免费额度");
  expect(calls).toBe(0);
  await expect(page.getByRole("button", { name: "生成 AI 面试复盘", exact: true })).toBeVisible();
});

test("pre-usage-report LIVE history remains readable without losing its review", async ({ page }) => {
  await page.goto('/#/interview');
  await page.evaluate(({resume,job,report}) => localStorage.setItem('kaikou.live-interview.history.v1',JSON.stringify([{time:'2026-11-01T00:00:00Z',draft:{id:'old-live-report',source:{role:'旧版面试',resume,job},messages:[{id:'q',role:'assistant',text:'你负责什么？',final:true},{id:'a',role:'user',text:'我负责需求分析和产品协调。',final:true}],tokens:500,elapsed:60,minutes:10,report}}])),{resume,job,report});
  await page.reload();
  await page.getByRole('button',{name:'LIVE 实时面试',exact:true}).click();
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:/旧版面试/}).click();
  await expect(page.getByText(report.summary,{exact:true})).toBeVisible();
  await page.locator('.live-usage summary').click();
  await expect(page.locator('.live-usage table')).toContainText('未完整回报');
});
test("native WebRTC: captions, interruption, failure recovery, persisted report and no old answers", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1420, height: 1000 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("kaikou.interview.draft.v1"))
      localStorage.setItem(
        "kaikou.interview.draft.v1",
        JSON.stringify({
          role: "旧岗位",
          resume: "旧简历，必须保留原来的内容不能因为LIVE填写就变化。",
          job: "旧岗位描述，需要保留原来的记录和全部回答内容。",
          question: "旧题目",
          answer: "不能自动提交的旧草稿",
          turns: [{ question: "旧问题", answer: "旧回答不属于LIVE" }],
          report: null,
        }),
      );
  });
  await nativePeer(page);
  let reviews = 0;
  await page.route("**/api/realtime/review", (route) => {
    reviews++;
    const body = route.request().postDataJSON();
    expect(JSON.stringify(body)).not.toContain("旧回答");
    expect(JSON.stringify(body)).not.toContain("旧草稿");
    expect(body.history[0].question).toBe("请介绍你负责的一次产品项目？");
    return reviews === 1
      ? route.fulfill({
          status: 503,
          json: { error: "点评服务暂时不可用，回答已保留。" },
        })
      : route.fulfill({ json: report });
  });
  await prepare(page);
  await page.locator(".live-panel").scrollIntoViewIfNeeded();
  const consentLayout = await page
    .locator(".live-panel > .live-consent")
    .evaluate((label) => ({
      text: label.querySelector("span")!.getBoundingClientRect().width,
      checkbox: label.querySelector("input")!.getBoundingClientRect().width,
    }));
  expect(consentLayout.checkbox).toBeLessThan(25);
  expect(consentLayout.text).toBeGreaterThan(300);
  await page.screenshot({ path: ".reference-analysis/live-ready.png" });
  await page
    .getByRole("button", { name: "开始 LIVE 面试", exact: true })
    .click();
  await expect(
    page.getByText("请介绍你负责的一次产品项目？", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as any).__liveRequests[0].history),
  ).toEqual([]);
  expect(await page.evaluate(() => (window as any).__providerEvents.find((e: any) => e.type === 'response.create')?.response?.instructions)).toContain('现在开始或继续本轮面试');
  await page.getByRole("button", { name: "打断面试官", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__providerEvents.some(
          (e: any) => e.type === "response.cancel",
        ),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "麦克风静音", exact: true }).click();
  await expect(page.getByText("麦克风已静音；通话仍在计时")).toBeVisible();
  await page.getByRole("button", { name: "开启麦克风", exact: true }).click();
  await page.evaluate(() =>
    (window as any).__emit([
      { type: "input_audio_buffer.speech_started", item_id: "a1" },
      {
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "a1",
        text: "我负责需求分析",
        stash: "和优先级梳理。",
      },
      { type: "input_audio_buffer.speech_stopped" },
      { type: "response.created" },
      {
        type: "response.audio_transcript.done",
        item_id: "q2",
        transcript: "你如何验证最终效果？",
      },
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "a1",
        transcript: "我负责需求分析和优先级梳理，并与研发一起确认排期。",
      },
      {
        type: "response.done",
        response: {
          id: "r1",
          status: "completed",
          usage: { total_tokens: 231, input_tokens: 200, output_tokens: 31, input_tokens_details: { text_tokens: 150, audio_tokens: 50 }, output_tokens_details: { text_tokens: 11, audio_tokens: 20 } },
        },
      },
    ]),
  );
  await expect(
    page.getByText("我负责需求分析和优先级梳理，并与研发一起确认排期。", {
      exact: true,
    }),
  ).toBeVisible();
  await page.locator(".live-usage summary").click();
  await expect(page.locator(".live-usage tbody tr").nth(1)).toContainText("50");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出本轮用量 JSON", exact: true }).click();
  const artifact = await download;
  const content = JSON.parse(await (await import("node:fs/promises")).readFile((await artifact.path())!, "utf8"));
  expect(content.reportedTotalTokens).toBe(231); expect(content.billing.status).toBe("not_verified");
  expect(content).not.toHaveProperty("source");
  await page.screenshot({
    path: ".reference-analysis/live-dialogue-test-peer.png",
  });
  await page
    .getByRole("button", { name: "结束 / 暂停通话", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "重新连接 / 继续本轮", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "生成 AI 面试复盘", exact: true })
    .click();
  await expect(page.locator(".live-panel > .interview-error")).toContainText("点评服务暂时不可用");
  await expect(page.locator(".live-message textarea")).toHaveValue(
    /我负责需求分析/,
  );
  await page
    .getByRole("button", { name: "生成 AI 面试复盘", exact: true })
    .click();
  await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
  await page.locator(".live-report").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: ".reference-analysis/live-report-test-fixture.png",
  });
  await page.reload();
  await page.getByRole('button',{name:'逐轮练习',exact:true}).click();
  await expect(page.getByLabel(/我的回答/)).toHaveValue("不能自动提交的旧草稿");
  await expect(page.getByLabel("岗位名称（选填）")).toHaveValue("旧岗位");
  await page
    .getByRole("button", { name: "LIVE 实时面试", exact: true })
    .click();
  await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
});
test("network loss retains subtitles, reconnect restores context and time limit closes the session", async ({
  page,
}) => {
  await nativePeer(page);
  await prepare(page);
  await page
    .getByRole("button", { name: "开始 LIVE 面试", exact: true })
    .click();
  await expect(
    page.getByText("请介绍你负责的一次产品项目？", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as any).__emit([
      { type: "input_audio_buffer.speech_started", item_id: "answer" },
      {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "answer",
        transcript: "我负责需求分析并整理项目关键风险。",
      },
    ]),
  );
  await expect(
    page.getByText("我负责需求分析并整理项目关键风险。", { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => (window as any).__channel.close());
  await expect(page.locator(".live-panel > .interview-error")).toContainText("通道已关闭");
  await page
    .getByRole("button", { name: "重新连接 / 继续本轮", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__liveRequests?.length))
    .toBe(2);
  expect(
    await page.evaluate(() => (window as any).__liveRequests[1].history),
  ).toContainEqual({
    role: "user",
    text: "我负责需求分析并整理项目关键风险。",
  });
  await expect(page.locator(".live-assistant")).toHaveCount(2);
  await page
    .getByRole("button", { name: "结束 / 暂停通话", exact: true })
    .click();
  await page.evaluate(() => {
    const d = JSON.parse(
      localStorage.getItem("kaikou.live-interview.draft.v1")!,
    );
    d.minutes = 5;
    d.elapsed = 299;
    localStorage.setItem("kaikou.live-interview.draft.v1", JSON.stringify(d));
  });
  await page.reload();
  await page
    .getByRole("button", { name: "LIVE 实时面试", exact: true })
    .click();
  await page.locator(".live-panel > .live-consent input").check();
  await page
    .getByRole("button", { name: "重新连接 / 继续本轮", exact: true })
    .click();
  await expect(page.locator(".live-panel > .interview-error")).toContainText("达到设定时长");
  await expect(
    page.getByRole("button", { name: "生成 AI 面试复盘", exact: true }),
  ).toBeEnabled();
});
test("failed handshake retains material and cancellation rejects a late microphone grant", async ({
  page,
}) => {
  await page.route("**/api/realtime/status", (r) =>
    r.fulfill({ json: { configured: true, trial: { ready: true, message: "隔离测试" } } }),
  );
  await page.route("**/api/realtime/session", (r) =>
    r.fulfill({
      status: 502,
      json: { error: "实时模型未获授权，请检查地域和权限。" },
    }),
  );
  await prepare(page);
  await page
    .getByRole("button", { name: "开始 LIVE 面试", exact: true })
    .click();
  await expect(page.locator(".live-panel > .interview-error")).toContainText("未获授权");
  await expect(
    page.getByRole("button", { name: "重新连接 / 继续本轮", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const w = window as any;
    const native = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = () =>
      new Promise((resolve) => {
        w.__grantMic = async () => {
          const stream = await native({ audio: true });
          w.__lateStream = stream;
          resolve(stream);
        };
      });
  });
  await page
    .getByRole("button", { name: "重新连接 / 继续本轮", exact: true })
    .click();
  await page
    .getByRole("button", { name: "结束 / 暂停通话", exact: true })
    .click();
  await page.evaluate(() => (window as any).__grantMic());
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).__lateStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === "ended"),
      ),
    )
    .toBe(true);
});

test('LIVE 通话场景可见，通话中复盘说明先结束，退出后保持 LIVE 模式',async({page})=>{
  await page.setViewportSize({width:1420,height:1000});await nativePeer(page);await prepare(page);
  await page.getByRole('button',{name:'开始 LIVE 面试',exact:true}).click();
  await expect(page.getByLabel('LIVE 语音面试现场')).toContainText('AI 面试官');
  await expect(page.locator('.live-current-question')).toContainText('请介绍你负责的一次产品项目？');
  await page.locator('.live-call-room').evaluate(e=>e.scrollIntoView({block:'start'}));
  await page.screenshot({path:'.impeccable/review/desktop.png'});
  await page.setViewportSize({width:1080,height:720});
  await page.locator('.live-call-room').evaluate(e=>e.scrollIntoView({block:'start'}));
  await page.screenshot({path:'.impeccable/review/compact-desktop.png'});
  await page.getByRole('button',{name:'生成 AI 面试复盘',exact:true}).click();
  await expect(page.locator(".live-panel > .interview-error")).toContainText('先点击“结束 / 暂停通话”');
  await page.evaluate(()=>(window as any).__emit([{type:'input_audio_buffer.speech_started',item_id:'punctuation-answer'},{type:'conversation.item.input_audio_transcription.completed',item_id:'punctuation-answer',transcript:'我负责需求分析然后核对了交付范围'}]));
  await page.getByRole('button',{name:'结束 / 暂停通话',exact:true}).click();
  await expect(page.getByLabel(/第 \d+ 条回答文字/)).toHaveValue('我负责需求分析，然后核对了交付范围。');
  await page.getByRole('button',{name:'撤销这段标点',exact:true}).click();
  await expect(page.getByLabel(/第 \d+ 条回答文字/)).toHaveValue('我负责需求分析然后核对了交付范围');
  await page.reload();
  await expect(page.getByRole('button',{name:'LIVE 实时面试',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('LIVE 语音面试现场')).toBeVisible();
});

test("a short pause never submits an answer; resumed speech and ending cancel pending follow-ups", async ({ page }) => {
  await nativePeer(page);
  await prepare(page);
  await page.locator('.live-preflight > summary').click();
  await page.getByLabel('思考停顿').selectOption('3000');
  await page.getByRole('button', { name: '开始 LIVE 面试', exact: true }).click();
  await expect(page.getByText('请介绍你负责的一次产品项目？', { exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__emit([{type:'response.done',response:{id:'opening',status:'completed'}}]));
  await expect(page.locator('.live-speaking-status')).toContainText('正在认真听');
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const creates = () => page.evaluate(() => (window as any).__providerEvents.filter((e: any) => e.type === 'response.create').length);
  await page.evaluate(() => (window as any).__emit([{ type: 'input_audio_buffer.speech_started' }, { type: 'input_audio_buffer.speech_stopped' }]));
  await expect(page.locator('.live-speaking-status')).toContainText('准备追问');
  await page.clock.runFor(600);
  expect(await creates()).toBe(1);
  await page.evaluate(() => (window as any).__emit([{ type: 'input_audio_buffer.speech_started' }]));
  await expect(page.locator('.live-speaking-status')).toContainText('正在认真听');
  await page.clock.runFor(3100);
  expect(await creates()).toBe(1);
  await page.evaluate(() => (window as any).__emit([{ type: 'input_audio_buffer.speech_stopped' }]));
  await expect(page.locator('.live-speaking-status')).toContainText('准备追问');
  await page.clock.runFor(3100);
  await expect.poll(creates).toBe(2);
  await page.evaluate(() => (window as any).__emit([{ type: 'input_audio_buffer.speech_started' }, { type: 'input_audio_buffer.speech_stopped' }]));
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
  await page.clock.runFor(3100);
  expect(await creates()).toBe(2);
});
