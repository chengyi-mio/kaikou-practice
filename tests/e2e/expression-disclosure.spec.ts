import { expect, test } from '@playwright/test';

const answer = '我建议提前分享会议材料，因为大家可以先了解背景，再把时间用来讨论真正需要解决的问题。';

test('browser transcription disclosure stays visible outside collapsed settings', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: class {} }); });
  await page.route('**/api/status', route => route.fulfill({ json: { ai: false, asr: false } }));
  await page.goto('/#/practice/improv');
  await expect(page.locator('.practice-settings')).not.toHaveAttribute('open', '');
  await expect(page.locator('.browser-transcription-notice')).toContainText('语音可能发送至浏览器厂商');
  await page.locator('.practice-settings > summary').click();
  await page.getByRole('checkbox', { name: /同时使用浏览器转写/ }).uncheck();
  await page.locator('.practice-settings > summary').click();
  await expect(page.locator('.browser-transcription-notice')).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`optional settings and outline stay intact when collapsed at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/status', route => route.fulfill({ json: { ai: false, asr: false } }));
    await page.goto('/#/practice/improv');
    await expect(page.getByLabel('我的表达提纲')).toBeHidden();
    await expect(page.getByLabel('表达时长')).toBeHidden();
    await expect(page.getByRole('button', { name: '开始表达', exact: true })).toBeVisible();

    await page.locator('.practice-settings > summary').click();
    await page.getByLabel('表达时长').getByRole('button', { name: '90' }).click();
    await page.locator('.practice-settings > summary').click();
    await expect(page.locator('.practice-settings > summary')).toContainText('90 秒表达');

    await page.locator('.preparation-draft summary').click();
    await page.getByLabel('我的表达提纲').fill(answer);
    await page.locator('.preparation-draft summary').click();
    await expect(page.getByLabel('我的表达提纲')).toBeHidden();
    await page.locator('.preparation-draft summary').click();
    await expect(page.getByLabel('我的表达提纲')).toHaveValue(answer);

    await page.getByRole('button', { name: '也可以用文字练习' }).click();
    await expect(page.getByLabel('我的表达', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: '生成 AI 点评', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '查看基础反馈', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('feedback details are genuinely disclosed and full transcript remains available', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: { ai: true, asr: false } }));
  await page.route('**/api/analyze', route => route.fulfill({ json: {
    source: 'ai', provider: 'agnes', model: 'isolated-test', summary: '观点明确，可以补充行动的负责人。',
    dimensions: [{ id: 'structure', title: '结构与逻辑', status: 'partial', text: '行动负责人尚未说明。', advice: '说明由谁在何时完成。', evidence: [answer] }],
    improvements: ['说明由谁在何时完成。'], rewrite: '建议主持人在周三前分享材料。',
    metrics: { characters: answer.length, duration: 0, fillers: 0 },
  } }));
  await page.goto('/#/practice/improv');
  await page.getByRole('button', { name: '也可以用文字练习' }).click();
  await page.getByLabel('我的表达', { exact: true }).fill(answer);
  await page.getByRole('button', { name: '生成 AI 点评', exact: true }).click();
  await expect(page.getByRole('button', { name: '针对这一点再练', exact: true })).toBeVisible();
  await expect(page.locator('.feedback-full-analysis .report')).toBeHidden();
  await expect(page.locator('.feedback-comparison-section')).toHaveCount(0);
  await page.locator('.feedback-full-analysis > summary').click();
  await expect(page.locator('.feedback-full-analysis .report')).toBeVisible();
  await page.locator('.feedback-full-analysis > summary').click();
  await expect(page.locator('.feedback-full-analysis .report')).toBeHidden();
  await page.getByRole('button', { name: '查看我的完整表达' }).click();
  await expect(page.locator('.feedback-transcript')).toHaveAttribute('open', '');
  await expect(page.locator('.feedback-transcript')).toContainText(answer);
});
