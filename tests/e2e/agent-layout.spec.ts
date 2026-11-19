import { expect, test } from '@playwright/test';
import { nativePeer, prepare } from './helpers/live-peer';

const source = {
  role: '合成产品经理',
  resume: '这是合成测试简历，具有需求分析、项目推进与跨部门协作经验。',
  job: '这是合成岗位描述，负责产品规划、项目协同与交付结果跟进。',
};
const unsent = '这是尚未提交的当前回答，收起界面和查看历史都不能自动发送。';

test('侧栏折叠和跨断点不重建未提交回答，偏好重启保留', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  let modelCalls = 0;
  await page.route('**/api/interview', route => { modelCalls++; return route.abort(); });
  await page.goto('/#/interview');
  await page.evaluate(({ source, unsent }) => {
    localStorage.setItem('kaikou.interview.mode', 'turn');
    localStorage.setItem('kaikou.interview.draft.v1', JSON.stringify({ ...source, question: '请介绍一个项目？', answer: unsent, turns: [], report: null }));
  }, { source, unsent });
  await page.reload();
  await expect(page.getByRole('button', { name: '新练习', exact: true })).toHaveCount(0);
  const answer = page.getByLabel(/我的回答/);
  await expect(answer).toHaveValue(unsent);
  await answer.evaluate(element => { (window as any).__originalAnswer = element; });
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await expect.poll(() => answer.evaluate(element => (window as any).__originalAnswer === element)).toBe(true);
  const collapsedWidth = await page.locator('.app-sidebar').evaluate(element => element.getBoundingClientRect().width);
  expect(collapsedWidth).toBeLessThanOrEqual(80);
  for (const width of [1080, 390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(answer).toHaveValue(unsent);
    expect(await answer.evaluate(element => (window as any).__originalAnswer === element)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.reload();
  await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible();
  await expect(answer).toHaveValue(unsent);
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
  expect(modelCalls).toBe(0);
});

test('最近面试进入独立历史，返回首页保留当前草稿', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto('/#/');
  await page.evaluate(({ source, unsent }) => {
    localStorage.setItem('kaikou.interview.mode', 'turn');
    localStorage.setItem('kaikou.interview.draft.v1', JSON.stringify({ ...source, question: '当前问题？', answer: unsent, turns: [], report: null }));
    localStorage.setItem('kaikou.interview.history.v1', JSON.stringify([{ id: 'agent-shell-old-record', time: '2026-11-14T03:00:00Z', draft: {
      ...source, role: '历史面试测试岗位', question: '旧问题？', answer: '', turns: [{ question: '旧问题？', answer: '这是历史答案，不能写回当前草稿。' }],
      report: { summary: '这是合成历史复盘。', dimensions: [{ name: '结构', score: 3, evidence: '历史答案', advice: '明确个人行动。' }], nextStep: '补练项目经历。' },
    } }]));
  }, { source, unsent });
  await page.reload();
  const before = await page.evaluate(() => localStorage.getItem('kaikou.interview.draft.v1'));
  await page.getByLabel('最近练习', { exact: true }).getByRole('link', { name: /历史面试测试岗位/ }).click();
  await expect(page.getByText('这是合成历史复盘。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('kaikou.interview.draft.v1'))).toBe(before);
  await page.getByRole('navigation', { name: '桌面导航', exact: true }).getByRole('link', { name: '首页', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始表达训练' })).toBeVisible();
  await expect(page.getByRole('button', { name: '进入模拟面试' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('kaikou.interview.draft.v1'))).toBe(before);
});

test('LIVE 右侧文字常显，收缩和缩放保持连接及录音', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nativePeer(page);
  await prepare(page);
  await page.getByRole('button', { name: '开始 LIVE 面试', exact: true }).click();
  await expect(page.locator('.live-current-question')).toContainText('请介绍你负责的一次产品项目？');
  await expect(page.locator('.live-transcript-disclosure')).toHaveAttribute('open', '');
  await page.evaluate(() => (window as any).__emit([
    { type: 'input_audio_buffer.speech_started', item_id: 'layout-answer' },
    { type: 'conversation.item.input_audio_transcription.completed', item_id: 'layout-answer', transcript: '我先访谈用户，再和研发确认交付范围，并跟踪上线后的真实反馈。' },
  ]));
  await expect(page.locator('.live-transcript')).toContainText('我先访谈用户');
  await page.locator('.live-call-room').evaluate(element => { (window as any).__callRoom = element; });
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  for (const width of [1080, 390, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.locator('.live-call-room').evaluate(element => element === (window as any).__callRoom)).toBe(true);
    expect(await page.evaluate(() => (window as any).__provider.connectionState)).toBe('connected');
    await expect(page.locator('.live-recording-disclosure > summary')).toContainText('正在录制双方声音');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__liveRequests.length)).toBe(1);
  await page.locator('.live-call-room').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.reference-analysis/agent-live-0.14.2/live-active-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.live-call-room').scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.reference-analysis/agent-live-0.14.2/live-active-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
  await expect(page.locator('.live-recording-row')).toContainText('已保存到本机');
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
});
