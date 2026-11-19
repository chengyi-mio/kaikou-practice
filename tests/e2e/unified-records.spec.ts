import { test, expect, type Page } from "@playwright/test";

const source = { role: "产品经理", resume: "我负责过跨团队项目，完成需求访谈、方案设计和上线效果复盘，积累了五年的相关经验。", job: "岗位要求独立完成需求分析与方案设计，协调研发上线并持续关注真实用户反馈和产品指标。" };
const question = "请讲一个你主导的项目，你具体做了什么？";
const answer = "我访谈了用户，整理高频问题并确定优先级，再协调研发分阶段上线。";
const report = { summary: "已经说明个人行动，可以补充结果证据。", dimensions: [{ name: "结果证据", score: 2, evidence: "分阶段上线", advice: "说明上线后的实际观察，不编造数据。" }], nextStep: "补充一种你实际采用的验证方式。" };
const turnDraftKey = "kaikou.interview.draft.v1", liveDraftKey = "kaikou.live-interview.draft.v1";
const turnHistoryKey = "kaikou.interview.history.v1", liveHistoryKey = "kaikou.live-interview.history.v1";

async function seed(page: Page) {
  await page.route("**/api/status", route => route.fulfill({ json: { ai: true, asr: false } }));
  await page.goto("/#/");
  await page.evaluate(({ source, question, answer, report, turnDraftKey, liveDraftKey, turnHistoryKey, liveHistoryKey }) => {
    localStorage.setItem(turnDraftKey, JSON.stringify({ ...source, question: "当前尚未提交的问题", answer: "这段草稿绝不能被历史记录覆盖或提交。", turns: [], report: null }));
    localStorage.setItem(liveDraftKey, JSON.stringify({ id: "active-live", source, messages: [{ id: "a", role: "user", text: "当前 LIVE 未提交文本", final: false }], elapsed: 30, minutes: 10, report: null, tokens: 0, usage: [] }));
    localStorage.setItem(turnHistoryKey, JSON.stringify([{ id: "turn-saved", time: "2026-11-14T01:00:00.000Z", draft: { ...source, question: "", answer: "", turns: [{ question, answer }], report } }]));
    localStorage.setItem(liveHistoryKey, JSON.stringify([{ time: "2026-11-14T02:00:00.000Z", draft: { id: "live-saved", source, messages: [{ id: "q", role: "assistant", text: question, final: true }, { id: "a", role: "user", text: answer, final: true }], report, elapsed: 68, minutes: 10, tokens: 200, usage: [] } }]));
  }, { source, question, answer, report, turnDraftKey, liveDraftKey, turnHistoryKey, liveHistoryKey });
  await page.goto("/#/history?type=interview");
}
async function drafts(page: Page) {
  return page.evaluate(({ turnDraftKey, liveDraftKey }) => [localStorage.getItem(turnDraftKey), localStorage.getItem(liveDraftKey)], { turnDraftKey, liveDraftKey });
}

test("统一展示逐题和 LIVE 历史，查看详情及返回不替换当前草稿", async ({ page }) => {
  await seed(page);
  const before = await drafts(page);
  await expect(page.locator(".interview-history-card")).toHaveCount(2);
  await page.locator(".interview-history-card").filter({ hasText: "逐题面试" }).getByRole("button").click();
  await expect(page.getByRole("heading", { name: "产品经理 · 逐题面试" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成 AI 面试复盘", exact: true })).toBeVisible();
  await expect(page.locator(".saved-question")).not.toBeVisible();
  await page.getByText("查看本轮问答 · 1 题", { exact: true }).click();
  await expect(page.locator(".saved-question")).toContainText(answer);
  await page.getByRole("button", { name: "返回面试记录", exact: true }).click();
  await page.locator(".interview-history-card").filter({ hasText: "LIVE 面试" }).getByRole("button").click();
  await expect(page.getByRole("heading", { name: "产品经理 · LIVE", exact: true })).toBeVisible();
  expect(await drafts(page)).toEqual(before);
  await expect(page.locator(".record-disclosure[open]")).toHaveCount(0);
});

for (const kind of ["turn", "live"] as const) {
  test(`${kind} 历史重评只提交选中记录，AI 失败重试保留原复盘与当前草稿`, async ({ page }) => {
    await seed(page);
    const before = await drafts(page);
    const updated = { ...report, summary: "新的复盘：个人行动清晰，仍应补充结果。" };
    let calls = 0;
    await page.route(kind === "turn" ? "**/api/interview" : "**/api/realtime/review", route => {
      const body = route.request().postDataJSON();
      expect(body.history).toEqual([{ question, answer }]);
      expect(body.resume).toBe(source.resume);
      expect(JSON.stringify(body)).not.toContain("当前尚未提交");
      expect(JSON.stringify(body)).not.toContain("当前 LIVE");
      return ++calls === 1 ? route.fulfill({ status: 503, json: { error: "测试服务暂不可用，原记录保留。" } }) : route.fulfill({ json: updated });
    });
    await page.goto(`/#/history?type=interview&kind=${kind}&id=${kind}-saved`);
    await page.getByRole("button", { name: "重新生成 AI 面试复盘", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("服务暂不可用");
    await expect(page.locator(".saved-interview-review")).toContainText(report.summary);
    await page.getByRole("button", { name: "重试 AI 面试复盘", exact: true }).click();
    await expect(page.locator(".saved-interview-review")).toContainText(updated.summary);
    expect(await drafts(page)).toEqual(before);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!)[0].draft.report.summary, kind === "turn" ? turnHistoryKey : liveHistoryKey)).toBe(updated.summary);
  });
}

test("服务未配置时历史 AI 入口保留，配置检查不提交任何回答", async ({ page }) => {
  await seed(page);
  await page.route("**/api/status", route => route.fulfill({ json: { ai: false, asr: false } }));
  let submitted = false;
  await page.route("**/api/interview", route => { submitted = true; return route.abort(); });
  const before = await drafts(page);
  await page.goto("/#/history?type=interview&kind=turn&id=turn-saved");
  await page.getByRole("button", { name: "重新生成 AI 面试复盘", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新检查 AI 服务", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重新生成 AI 面试复盘", exact: true })).toBeVisible();
  expect(submitted).toBe(false);
  expect(await drafts(page)).toEqual(before);
});

test("只删除选中的历史复盘，保留另一类型记录及当前草稿", async ({ page }) => {
  await seed(page);
  const before = await drafts(page);
  const other = await page.evaluate(key => localStorage.getItem(key), liveHistoryKey);
  await page.goto("/#/history?type=interview&kind=turn&id=turn-saved");
  await page.getByText("记录管理", { exact: true }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除这条面试记录" }).click();
  await expect(page.locator(".interview-history-card")).toHaveCount(1);
  expect(await drafts(page)).toEqual(before);
  expect(await page.evaluate(key => localStorage.getItem(key), liveHistoryKey)).toBe(other);
});

test("历史存储损坏时明确提示，仍能读取另一类型且不改写损坏数据", async ({ page }) => {
  await seed(page);
  await page.evaluate(key => localStorage.setItem(key, "broken-existing-records"), turnHistoryKey);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText("逐题面试记录暂时无法读取");
  await expect(page.locator(".interview-history-card")).toHaveCount(1);
  expect(await page.evaluate(key => localStorage.getItem(key), turnHistoryKey)).toBe("broken-existing-records");
});

test("复盘生成后存储失败可单独重试保存，不重复调用模型", async ({ page }) => {
  await seed(page);
  let calls = 0;
  const updated = { ...report, summary: "这是一份待保存的新复盘。" };
  await page.route("**/api/interview", route => { calls++; return route.fulfill({ json: updated }); });
  await page.goto("/#/history?type=interview&kind=turn&id=turn-saved");
  const before = await drafts(page);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (name, value) {
      if (name === key && !failed) { failed = true; throw Error("测试存储已满"); }
      original.call(this, name, value);
    };
  }, turnHistoryKey);
  await page.getByRole("button", { name: "重新生成 AI 面试复盘", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("未保存");
  await expect(page.locator(".saved-interview-review")).toContainText(updated.summary);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!)[0].draft.report.summary, turnHistoryKey)).toBe(report.summary);
  await page.getByRole("button", { name: "重试保存复盘", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "AI 复盘已更新" })).toBeVisible();
  expect(calls).toBe(1);
  expect(await drafts(page)).toEqual(before);
});

test("历史 LIVE 录音可读取回放、下载和单独删除，复盘与草稿保留", async ({ page }) => {
  await seed(page);
  await page.evaluate(async () => {
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const destination = audio.createMediaStreamDestination();
    oscillator.connect(destination); oscillator.start();
    const recorder = new MediaRecorder(destination.stream);
    const chunks: Blob[] = [];
    const blob = await new Promise<Blob>(resolve => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
      recorder.start(); setTimeout(() => recorder.stop(), 350);
    });
    oscillator.stop(); await audio.close();
    const request = indexedDB.open("kaikou-live-recordings", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("recordings", { keyPath: "id" });
      request.result.createObjectStore("chunks", { keyPath: ["recordingId", "index"] });
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["recordings", "chunks"], "readwrite");
      tx.objectStore("recordings").put({ id: "saved-voice", roundId: "live-saved", role: "产品经理", createdAt: "2026-11-14T02:00:00.000Z", duration: 0.35, bytes: blob.size, mimeType: blob.type, status: "saved" });
      tx.objectStore("chunks").put({ recordingId: "saved-voice", index: 0, blob });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    db.close(); window.dispatchEvent(new Event("kaikou-live-recordings-changed"));
  });
  const before = await drafts(page);
  const saved = await page.evaluate(key => localStorage.getItem(key), liveHistoryKey);
  await page.goto("/#/history?type=interview&kind=live&id=live-saved");
  await page.getByText("本轮通话录音 · 回放与下载", { exact: true }).click();
  await page.getByRole("button", { name: "回放录音", exact: true }).click();
  await expect(page.getByLabel("保存的双方通话录音")).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate((node: HTMLAudioElement) => node.readyState)).toBeGreaterThan(0);
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载录音", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toContain("LIVE-产品经理");
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "删除录音", exact: true }).click();
  await expect(page.locator(".saved-interview-audio")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), liveHistoryKey)).toBe(saved);
  expect(await drafts(page)).toEqual(before);
});
