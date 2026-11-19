import { expect, test } from '@playwright/test';
import { nativePeer, prepare } from './helpers/live-peer';

const resume = '我有五年产品设计经验，负责需求分析、项目交付和团队沟通。';
const job = '负责产品规划和需求分析，协调研发团队推进项目按期落地。';

test('收纳资料不会丢草稿，资料校验失败会展开对应输入', async ({ page }) => {
  await page.goto('/#/interview');
  await page.locator('.interview-columns textarea').nth(0).fill(resume);
  await page.locator('.interview-columns textarea').nth(1).fill('太短');
  await page.locator('.interview-materials > summary').click();
  let calls = 0;
  await page.route('**/api/interview', route => { calls++; return route.abort(); });
  await page.getByRole('button', { name: '生成第一道面试题' }).click();
  await expect(page.locator('.interview-materials')).toHaveAttribute('open', '');
  await expect(page.locator('.interview-columns textarea').nth(1)).toBeFocused();
  await expect(page.locator('.interview-columns textarea').nth(0)).toHaveValue(resume);
  expect(calls).toBe(0);
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
});

test('AI 失败保留当前答案，成功后收纳维度分析且 AI 入口仍在', async ({ page }) => {
  await page.goto('/#/interview');
  await page.evaluate(({ resume, job }) => localStorage.setItem('kaikou.interview.draft.v1', JSON.stringify({
    role: '产品经理', resume, job, question: '请介绍你的个人贡献？',
    answer: '我负责需求分析，并与研发确认交付范围。', turns: [], report: null,
  })), { resume, job });
  await page.reload();
  await expect(page.locator('.interview-materials')).not.toHaveAttribute('open', '');
  let requests = 0;
  await page.route('**/api/interview', route => {
    requests++;
    const body = route.request().postDataJSON();
    expect(body.history).toHaveLength(1);
    expect(body.history[0].answer).toBe('我负责需求分析，并与研发确认交付范围。');
    return requests === 1 ? route.fulfill({ status: 503, json: { error: '测试服务暂不可用' } }) : route.fulfill({ json: {
      summary: '你说明了自己的行动，需要补充项目结果。',
      dimensions: [{ name: '结果证据', score: null, evidence: '我负责需求分析', advice: '补充可以核实的结果。' }], nextStep: '讲清项目结果。',
    } });
  });
  await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('测试服务暂不可用');
  await expect(page.getByLabel(/我的回答/)).toHaveValue('我负责需求分析，并与研发确认交付范围。');
  await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
  await expect(page.locator('.interview-report')).toHaveAttribute('open', '');
  await expect(page.locator('.interview-analysis .interview-scores')).not.toBeVisible();
  await expect(page.locator('.journey-adjustment select').first()).not.toBeVisible();
  await page.locator('.interview-analysis > summary').click();
  await expect(page.locator('.interview-analysis .interview-scores')).toContainText('结果证据');
  await page.locator('.interview-report > summary').click();
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('kaikou.interview.draft.v1')!).turns)).toHaveLength(1);
});

test('LIVE 文字默认展示且可收起，结束自动展开录音，未确认回答定位到文字', async ({ page }) => {
  await nativePeer(page);
  await prepare(page);
  await page.getByRole('button', { name: '开始 LIVE 面试', exact: true }).click();
  await expect(page.getByLabel('LIVE 语音面试现场')).toContainText('请介绍你负责的一次产品项目？');
  await expect(page.locator('.live-transcript-disclosure')).toHaveAttribute('open', '');
  await expect(page.locator('.live-recording-disclosure > summary')).toContainText('正在录制双方声音');
  await page.evaluate(() => (window as any).__emit([
    { type: 'conversation.item.input_audio_transcription.delta', item_id: 'answer-incomplete', text: '我负责需求分析和项目协调。' },
  ]));
  await expect(page.locator('.live-transcript-disclosure')).toHaveAttribute('open', '');
  await page.locator('.live-transcript-disclosure > summary').click();
  await page.getByRole('button', { name: '结束 / 暂停通话', exact: true }).click();
  await expect(page.locator('.live-recording-disclosure')).toHaveAttribute('open', '');
  await expect(page.locator('.live-transcript-disclosure')).toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: '确认这段回答', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
});
