import { test, expect } from '@playwright/test';

for (const width of [390, 1080, 1440]) {
  test(`首页提供并列核心入口，面试草稿可继续且不自动发送 ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let modelCalls = 0;
    await page.route('**/api/status', route => route.fulfill({ json: { ai: false, asr: false } }));
    await page.route('**/api/interview', route => { modelCalls++; return route.fulfill({ status: 503, json: { error: '隔离测试' } }); });
    await page.goto('/#/');
    await expect(page.getByRole('button', { name: '开始表达训练' })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入模拟面试' })).toBeVisible();
    await expect(page.getByRole('region', { name: '继续上次练习' })).toHaveCount(0);
    await page.evaluate(() => {
      localStorage.setItem('kaikou.interview.mode', 'turn');
      localStorage.setItem('kaikou.interview.draft.v1', JSON.stringify({
        role: '合成岗位', resume: '合成简历，包括需求分析和项目协调经历。', job: '合成岗位，要求能够跟进项目交付并协同团队。',
        question: '请介绍一次项目经历。', answer: '这是一段尚未提交的回答，不能自动发送。', turns: [], report: null,
      }));
    });
    await page.reload();
    await page.getByRole('region', { name: '继续上次练习' }).getByRole('button', { name: '继续练习' }).click();
    await expect(page.getByLabel('我的回答', { exact: false })).toHaveValue('这是一段尚未提交的回答，不能自动发送。');
    expect(modelCalls).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
