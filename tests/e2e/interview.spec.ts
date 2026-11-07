import { test, expect } from "@playwright/test";
import JSZip from "jszip";

test("面试草稿在 AI 失败后保留，恢复后可追问并保存复盘", async ({ page }) => {
  let requests = 0;
  await page.route("**/api/interview", async (route) => {
    const body = route.request().postDataJSON();
    requests++;
    if (requests === 1) return route.fulfill({ status: 503, json: { error: "AI 暂时不可用" } });
    if (body.action === "question") return route.fulfill({ json: { question: body.history.length ? "你如何验证这个方案？" : "请介绍一次产品项目？" } });
    return route.fulfill({ json: { summary: "表达有重点。", dimensions: [{ name: "问题回应", score: 4, evidence: "我负责需求分析", advice: "补充结果。" }, { name: "具体证据", score: null, evidence: "", advice: "说明实际结果。" }], nextStep: "再练一次结果描述。" } });
  });
  await page.goto("/#/interview");
  await page.getByLabel("岗位名称（选填）").fill("产品经理");
  const areas = page.locator(".interview-columns textarea");
  await areas.nth(0).fill("我有五年产品工作经验，负责需求分析和团队沟通协作。");
  await areas.nth(1).fill("负责产品规划、项目协调和需求分析，并推进项目落地。");
  await page.getByRole("button", { name: "生成第一道面试题" }).click();
  await expect(page.getByRole("alert")).toContainText("AI 暂时不可用");
  await page.reload();
  await expect(areas.nth(0)).toHaveValue(/五年产品/);
  await page.getByRole("button", { name: "生成第一道面试题" }).click();
  await expect(page.getByText("请介绍一次产品项目？")).toBeVisible();
  await page.getByLabel(/我的回答/).fill("我负责需求分析，并与研发讨论方案优先级。");
  await page.getByRole("button", { name: "保存本题回答" }).click();
  await page.getByRole("button", { name: "生成下一题 / 追问" }).click();
  await expect(page.getByText("你如何验证这个方案？")).toBeVisible();
  await page.getByLabel(/我的回答/).fill("我通过用户反馈和业务指标验证方案效果。");
  await page.getByRole("button", { name: "保存本题回答" }).click();
  await page.getByRole("button", { name: "生成 AI 面试复盘" }).click();
  await expect(page.getByText("表达有重点。")).toBeVisible();
  await expect(page.getByText("本机面试复盘")).toBeVisible();
  await page.reload();
  await expect(page.getByText("表达有重点。")).toBeVisible();
});

test("PDF 简历和 DOCX 岗位描述能够在本机读取并编辑", async ({ page, context }) => {
  const pdfPage = await context.newPage();
  await pdfPage.setContent("<html><body>Product manager with five years of experience building enterprise software and coordinating teams.</body></html>");
  const pdf = await pdfPage.pdf();
  await pdfPage.close();
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file("_rels/.rels", '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file("word/document.xml", '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Responsible for product planning, team collaboration and delivery management.</w:t></w:r></w:p></w:body></w:document>');
  const docx = await zip.generateAsync({ type: "nodebuffer" });
  await page.goto("/#/interview");
  const files = page.locator('.interview-columns input[type="file"]');
  await files.nth(0).setInputFiles({ name: "resume.pdf", mimeType: "application/pdf", buffer: pdf });
  await expect(page.locator(".interview-columns textarea").nth(0)).toHaveValue(/five years of experience/);
  await files.nth(1).setInputFiles({ name: "job.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: docx });
  await expect(page.locator(".interview-columns textarea").nth(1)).toHaveValue(/product planning/);
});

test("面试录音转写失败时保留录音，重试成功后可以继续", async ({ page }) => {
  let transcriptions = 0;
  await page.route("**/api/interview", (route) => route.fulfill({ json: { question: "请介绍一次产品项目？" } }));
  await page.route("**/api/transcribe", (route) => {
    transcriptions++;
    return transcriptions === 1 ? route.fulfill({ status: 503, json: { error: "转写服务暂不可用" } }) : route.fulfill({ json: { text: "我负责需求分析然后与研发确认项目优先级" } });
  });
  await page.goto("/#/interview");
  const areas = page.locator(".interview-columns textarea");
  await areas.nth(0).fill("我有五年产品工作经验，负责需求分析和团队沟通协作。");
  await areas.nth(1).fill("负责产品规划、项目协调和需求分析，并推进项目落地。");
  await page.getByRole("button", { name: "生成第一道面试题" }).click();
  await page.getByRole("button", { name: "开始录音" }).click();
  await expect(page.getByRole("button", { name: /结束录音/ })).toBeVisible();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /结束录音/ }).click();
  await expect(page.getByRole("alert")).toContainText("转写服务暂不可用");
  await expect(page.locator("audio")).toBeVisible();
  await page.getByRole("button", { name: "重新转写录音" }).click();
  await expect(page.getByLabel(/我的回答/)).toHaveValue(/我负责需求分析/);
  await expect(page.getByLabel(/我的回答/)).toHaveValue('我负责需求分析，然后与研发确认项目优先级。');
  await page.getByRole('button',{name:'撤销补标点',exact:true}).click();
  await expect(page.getByLabel(/我的回答/)).toHaveValue('我负责需求分析然后与研发确认项目优先级');
  await page.getByRole('button',{name:'补充标点',exact:true}).click();
  await page.getByRole('button',{name:'LIVE 实时面试',exact:true}).click();
  await expect(page.getByLabel('LIVE 语音面试现场')).toBeVisible();
  await page.getByRole('button',{name:'逐轮练习',exact:true}).click();
  await expect(page.locator('audio')).toBeVisible();
  await expect(page.getByLabel(/我的回答/)).toHaveValue('我负责需求分析，然后与研发确认项目优先级。');
  await page.getByRole("button", { name: "保存本题回答" }).click();
  await expect(page.getByText("1 / 8 题已回答")).toBeVisible();
});

test('复盘入口可解释条件，当前一题直接复盘，AI 失败不丢答案或重复提交',async({page})=>{
  let feedbackCalls=0;
  await page.route('**/api/interview',r=>{
    const body=r.request().postDataJSON();
    if(body.action==='question')return r.fulfill({json:{question:'请介绍一次产品项目？'}});
    feedbackCalls++;expect(body.history).toHaveLength(1);expect(body.history[0].answer).toBe('我负责需求分析然后核对了交付范围。');
    return feedbackCalls===1?r.fulfill({status:503,json:{error:'点评暂时不可用，请重试。'}}):r.fulfill({json:{summary:'已根据这一题生成复盘。',dimensions:[{name:'回答结构',score:3,evidence:'我负责需求分析',advice:'补充结果。'},{name:'具体证据',score:null,evidence:'',advice:'补充可核实证据。'}],nextStep:'练习一个完整例子。'}});
  });
  await page.goto('/#/interview');
  await page.getByRole('button',{name:'生成 AI 面试复盘',exact:true}).click();
  await expect(page.locator('.interview-review-status')).toContainText('至少回答 1 道问题');expect(feedbackCalls).toBe(0);
  await page.locator('.interview-columns textarea').nth(0).fill('我有五年产品工作经验，负责需求分析和团队沟通协作。');
  await page.locator('.interview-columns textarea').nth(1).fill('负责产品规划、项目协调和需求分析，并推进项目落地。');
  await page.getByRole('button',{name:'生成第一道面试题'}).click();
  await page.getByLabel(/我的回答/).fill('好。。。。。。');
  await page.getByRole('button',{name:'生成 AI 面试复盘',exact:true}).click();
  await expect(page.locator('.interview-review-status')).toContainText('回答内容太少');expect(feedbackCalls).toBe(0);
  await page.getByLabel(/我的回答/).fill('我负责需求分析然后核对了交付范围。');
  await page.getByRole('button',{name:'生成 AI 面试复盘',exact:true}).click();
  await expect(page.locator('.interview-review-status')).toContainText('点评暂时不可用');
  await expect(page.getByLabel(/我的回答/)).toHaveValue('我负责需求分析然后核对了交付范围。');
  await page.getByRole('button',{name:'生成 AI 面试复盘',exact:true}).click();
  await expect(page.getByText('已根据这一题生成复盘。')).toBeVisible();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('kaikou.interview.draft.v1')!).turns.length)).toBe(1);
});
