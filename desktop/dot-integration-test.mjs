import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const textA = '我建议会前共享材料，把会议时间留给需要共同解决的问题。';
const textB = '我建议先确认目标，再用一个具体例子说明新的安排。';
const userData = path.join(root, '.reference-analysis', `dot-desktop-check-${Date.now()}`);
fs.mkdirSync(userData, { recursive: true });
const env = { ...process.env, KAIKOU_TEST_USER_DATA: userData, KAIKOU_TEST_PORT: '47939', KAIKOU_TEST_HIDE_WINDOW: '1' };
delete env.ELECTRON_RUN_AS_NODE;

async function launch() {
  const executablePath = process.env.KAIKOU_TEST_EXE;
  const app = await _electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: ['.'] }),
    cwd: root, env, timeout: 60000,
  });
  const page = await app.firstWindow();
  page.on('dialog', (dialog) => { void dialog.accept().catch(() => {}); });
  await page.setViewportSize({ width: 1440, height: 900 });
  return { app, page };
}

let running;
try {
  running = await launch();
  let { page } = running;
  await page.goto('http://127.0.0.1:47939/#/practice/improv');
  await page.getByRole('button', { name: '随机词语', exact: true }).click();
  await page.getByLabel('词语数量').selectOption('3');
  const wordAlignment = await page.locator('.word-card').evaluate((card) => {
    const container = card.getBoundingClientRect();
    const words = Array.from(card.children, (child) => child.getBoundingClientRect());
    const panel = card.closest('.practice-topic-panel');
    const lefts = ['.topic-kind', '.practice-topic-tags > span', '.word-selects', '.topic-instruction'].map((selector) => {
      const box = panel.querySelector(selector).getBoundingClientRect();
      return box.left;
    });
    return {
      sectionOffsets: lefts.map((left) => Math.abs(words[0].left - left)),
      widths: words.map((word) => word.width),
      textCentered: Array.from(card.children).every((word) => getComputedStyle(word).textAlign === 'center'),
      fits: words.at(-1).right <= container.right,
    };
  });
  assert.ok(wordAlignment.sectionOffsets.every((offset) => offset < 2));
  assert.ok(Math.max(...wordAlignment.widths) - Math.min(...wordAlignment.widths) < 1);
  assert.equal(wordAlignment.textCentered, true);
  assert.equal(wordAlignment.fits, true);
  await page.screenshot({ path: path.join(root, '.reference-analysis', 'word-prompt-desktop-0.11.6.png') });
  const saved = await page.evaluate(() => window.desktopApp.saveServiceSettings({
    baseUrl: 'http://127.0.0.1:57939/v1', model: 'fictional-model', apiKey: 'synthetic-only-key',
  }));
  assert.equal(saved.success, true);
  await page.goto('http://127.0.0.1:47939/#/practice/improv');
  await page.getByRole('button', { name: '也可以用文字练习' }).click();
  await page.getByLabel('我的表达').fill(textA);
  await page.getByRole('button', { name: '查看基础反馈' }).click();
  await expect(page.getByText('基础反馈 · 非 AI 点评')).toBeVisible();
  await page.getByRole('button', { name: '查看练习记录' }).click();
  await page.locator('.history-card').first().click();
  await page.getByRole('button', { name: '生成 AI 点评', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/未能连接 AI 服务|AI 服务暂时不可用/);
  await expect(page.locator('#saved-transcript')).toHaveValue(textA);
  await expect(page.getByRole('button', { name: '重试 AI 点评', exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(root, '.reference-analysis', 'dot-ai-failure-after.png'), fullPage: true });
  await running.app.close();
  running = undefined;

  const draftData = path.join(root, '.reference-analysis', `dot-draft-check-${Date.now()}`);
  fs.mkdirSync(draftData, { recursive: true });
  env.KAIKOU_TEST_USER_DATA = draftData;
  running = await launch();
  page = running.page;
  await page.goto('http://127.0.0.1:47939/#/practice/improv');
  await page.getByRole('button', { name: '也可以用文字练习' }).click();
  await page.getByLabel('我的表达').fill(textA);
  const pending = [];
  let analyzeCalls = 0;
  await page.route('**/api/analyze', (route) => { analyzeCalls++; return route.fulfill({ json: { source: 'basic' } }); });
  await page.route('**/api/status', (route) => { pending.push(route); });
  await page.getByRole('button', { name: '生成 AI 点评', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await page.getByLabel('我的表达').fill(textB);
  await pending[0].fulfill({ json: { ai: true, asr: false } });
  await page.waitForTimeout(350);
  assert.equal(analyzeCalls, 0, 'old draft must not be submitted after editing');
  await expect(page.getByLabel('我的表达')).toHaveValue(textB);
  await expect(page.getByRole('button', { name: '生成 AI 点评', exact: true })).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  console.log('PASS: real Electron basic feedback, AI failure recovery, and stale draft protection with isolated fictional data.');
} finally {
  if (running) await running.app.evaluate(({ app }) => { setTimeout(() => app.exit(0), 0); });
}
