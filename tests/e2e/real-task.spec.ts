import { test, expect } from "@playwright/test";

test("real work task reaches the review request and keeps AI entry visible", async ({ page }) => {
  let request: Record<string, unknown> | undefined;
  await page.route("**/api/status", (route) => route.fulfill({ json: { ai: false, asr: false } }));
  await page.route("**/api/analyze", async (route) => {
    request = route.request().postDataJSON();
    return route.fulfill({ json: { source: "basic", summary: "基础自查", dimensions: [], improvements: ["补充行动"], rewrite: "", metrics: { characters: 35, duration: 0, fillers: 0 } } });
  });
  await page.goto("/#/");
  await page.getByRole("button", { name: "准备一次真实沟通" }).click();
  await expect(page.getByRole("heading", { name: "你最近需要说清楚什么？" })).toBeVisible();
  await page.getByRole("button", { name: "解释延期" }).click();
  await page.getByLabel("希望达成什么").fill("解释原因并获得新的截止时间");
  await page.getByLabel("必要背景").fill("测试环境昨天不可用");
  await page.getByLabel("本次检查重点").fill("说明影响和下次更新时间");
  await page.getByRole("button", { name: "也可以用文字练习" }).click();
  await expect(page.getByRole("button", { name: "生成 AI 点评", exact: true })).toBeVisible();
  await page.getByLabel("我的表达", { exact: true }).fill("项目需要延期，因为测试环境不可用。我今天确认影响，明天下午更新交付时间。");
  await page.getByRole("button", { name: "查看基础反馈", exact: true }).click();
  await expect(page.getByText("基础自查", { exact: true }).first()).toBeVisible();
  expect(request?.realTask).toMatchObject({ kind: "delay", goal: "解释原因并获得新的截止时间", criteria: "说明影响和下次更新时间" });
  await page.goto("/#/history");
  await page.locator(".history-card").first().click();
  await expect(page.getByRole("button", { name: "生成 AI 点评", exact: true })).toBeVisible();
});

test("an AI listener question becomes a separate linked practice", async ({ page }) => {
  const followupRequests: unknown[] = [];
  await page.route("**/api/status", (route) => route.fulfill({ json: { ai: true, asr: false } }));
  await page.route("**/api/analyze", (route) => route.fulfill({ json: {
    source: "ai", provider: "agnes", summary: "已说明延期。", dimensions: [{ id: "focus", title: "目标与重点", text: "说了延期。", status: "partial", standard: "直接说明变化", evidence: ["项目延期了"] }],
    improvements: ["补充对团队的影响。"], rewrite: "", metrics: { characters: 20, duration: 0, fillers: 0 },
  } }));
  await page.route("**/api/followup", (route) => {
    followupRequests.push(route.request().postDataJSON());
    return route.fulfill({ json: { question: followupRequests.length === 1 ? "如果主管担心客户受影响，你准备如何回应？" : "如果客户要求今天确认时间，你会怎样答复？" } });
  });
  await page.goto("/#/practice/improv");
  await page.getByRole("button", { name: "也可以用文字练习" }).click();
  await page.getByLabel("我的表达", { exact: true }).fill("项目延期了，我明天会确认影响。 ");
  await page.getByRole("button", { name: "生成 AI 点评", exact: true }).click();
  await page.getByRole("button", { name: "生成听众追问" }).click();
  await expect(page.getByText("如果主管担心客户受影响，你准备如何回应？")).toBeVisible();
  await page.getByRole("button", { name: "录音回答这个问题" }).click();
  await expect(page.getByRole("heading", { name: "如果主管担心客户受影响，你准备如何回应？" })).toBeVisible();
  await page.getByRole("button", { name: "也可以用文字练习" }).click();
  await page.getByLabel("我的表达", { exact: true }).fill("我会先确认影响范围，再主动联系客户说明调整安排。 ");
  await page.getByRole("button", { name: "仅保存练习" }).click();
  await expect(page.locator(".history-card")).toHaveCount(2);
  await expect(page.getByText("听众追问", { exact: false }).first()).toBeVisible();
  await page.locator(".history-card").first().click();
  await page.getByRole("button", { name: "生成 AI 点评", exact: true }).click();
  await page.getByRole("button", { name: "生成听众追问" }).click();
  await expect(page.getByText("如果客户要求今天确认时间，你会怎样答复？")).toBeVisible();
  expect(followupRequests[1]).toMatchObject({ history: [{ answer: "项目延期了，我明天会确认影响。" }] });
});
