import { _electron, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const [exe, label = 'after'] = process.argv.slice(2);
assert.ok(exe && path.isAbsolute(exe) && fs.existsSync(exe));
const output = path.resolve('.reference-analysis/ux-disclosure-0.14.1');
const profile = path.join(output, `profile-${label}-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const env = { ...process.env, KAIKOU_TEST_USER_DATA: profile, KAIKOU_TEST_PORT: '47938', KAIKOU_TEST_HIDE_WINDOW: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: exe, env, timeout: 60000 });
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 1000));
  await page.waitForLoadState('domcontentloaded');
  await page.route('**/api/interview', route => route.fulfill({ status: 503, json: { error: '隔离界面验证，不调用真实模型。' } }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const capture = async name => {
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
    fs.writeFileSync(path.join(output, `${label}-${name}.png`), Buffer.from(data, 'base64'));
  };
  await expect(page.locator('.desktop-home')).toBeVisible();
  if (label !== 'before') {
    await expect(page.locator('.home-core-entry')).toHaveCount(2);
    await expect(page.getByRole('button', { name: '开始表达训练' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入模拟面试' })).toBeVisible();
  }
  await capture('home');
  await page.evaluate(() => {
    localStorage.setItem('kaikou.interview.mode', 'turn');
    localStorage.setItem('kaikou.interview.draft.v1', JSON.stringify({
      role: '产品经理', resume: '合成演示资料：负责新用户引导改版，访谈用户，协同设计研发交付并观察完成率。',
      job: '合成演示岗位：负责用户需求研究，推动产品落地并验证交付结果。', stage: 'project',
      question: '请讲一个你主导的项目，你具体做了什么？',
      answer: '我负责过一次新用户引导改版。当时，用户完成注册后，经常不知道下一步该做什么。\n\n我先访谈了用户，再和设计、研发一起简化操作步骤。上线后，我持续观察完成率，并根据反馈做了两轮调整。',
      turns: [{ question: '请简单介绍你的工作经历。', answer: '我从运营岗位转向产品，曾负责用户引导和需求分析。' }], report: null,
    }));
  });
  await page.goto('http://127.0.0.1:47938/#/interview');
  await expect(page.getByLabel('我的回答', { exact: false })).toHaveValue(/新用户引导改版/);
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await capture('interview');
  if (label !== 'before') {
    await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
    await expect(page.locator('[role="alert"]').first()).toBeVisible();
    await expect(page.getByLabel('我的回答', { exact: false })).toHaveValue(/新用户引导改版/);
  }
  console.log(`PASS ${label}: isolated desktop layout, preserved answer and visible AI entry. Screenshots: ${output}`);
} finally { await app.close(); }
