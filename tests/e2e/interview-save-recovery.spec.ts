import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

const source = {
  role: '合成保存恢复测试岗位',
  resume: '合成简历：负责需求分析、跨部门沟通以及产品项目交付，参与上线后的结果跟踪。',
  job: '合成岗位：负责产品规划、需求梳理、团队协作和项目交付，需要说明个人贡献。',
};
const question = '请介绍一次你负责的产品项目？';
const answer = '我负责需求分析，与研发确认交付范围，并在上线后追踪用户反馈。';
const report = {
  summary: '这是本次合成保存恢复测试的复盘。',
  dimensions: [{ name: '个人贡献', score: 3, evidence: '我负责需求分析', advice: '补充结果证据。' }],
  nextStep: '再练一次项目结果说明。',
};
type Mode = 'turn' | 'live';
const historyKey = (mode: Mode) => mode === 'turn' ? 'kaikou.interview.history.v1' : 'kaikou.live-interview.history.v1';
const draftKey = (mode: Mode) => mode === 'turn' ? 'kaikou.interview.draft.v1' : 'kaikou.live-interview.draft.v1';

async function seed(page: Page, mode: Mode, broken = false) {
  await page.goto('/#/interview');
  return page.evaluate(({ mode, source, question, answer, report, broken, key }) => {
    const turn = { ...source, question, answer, turns: [], report: null };
    const live = {
      id: 'audit-current-live', source,
      messages: [{ id: 'q', role: 'assistant', text: question, final: true }, { id: 'a', role: 'user', text: answer, final: true }],
      elapsed: 40, tokens: 0, minutes: 10, usage: [], report: null,
    };
    localStorage.setItem('kaikou.interview.mode', mode);
    localStorage.setItem('kaikou.interview.draft.v1', JSON.stringify(turn));
    localStorage.setItem('kaikou.live-interview.draft.v1', JSON.stringify(live));
    const oldReport = { ...report, summary: '已保存的合成旧复盘必须保留。' };
    const saved = mode === 'turn'
      ? [{ id: 'audit-old-turn', time: '2026-11-13T00:00:00Z', draft: { ...turn, question: '', answer: '', turns: [{ question, answer }], report: oldReport } }]
      : [{ time: '2026-11-13T00:00:00Z', draft: { ...live, id: 'audit-old-live', report: oldReport } }];
    const value = broken ? '{"synthetic_broken_history":' : JSON.stringify(saved);
    localStorage.setItem(key, value);
    return value;
  }, { mode, source, question, answer, report, broken, key: historyKey(mode) });
}

for (const mode of ['turn', 'live'] as const) {
  test(`${mode}: 新面试生成复盘不能覆盖无法读取的历史原文`, async ({ page }, testInfo) => {
    const before = await seed(page, mode, true);
    let calls = 0;
    await page.route(mode === 'turn' ? '**/api/interview' : '**/api/realtime/review', route => { calls++; return route.fulfill({ json: report }); });
    await page.reload();
    await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
    // A safe implementation may reject before requesting AI, or display a report
    // as pending; neither path may replace an unreadable history store.
    await Promise.race([
      page.getByText(report.summary, { exact: true }).waitFor(),
      page.getByRole('alert').first().waitFor(),
    ]);
    const after = await page.evaluate(key => localStorage.getItem(key), historyKey(mode));
    await testInfo.attach('synthetic-history-observation', { body: JSON.stringify({ mode, before, after, calls }, null, 2), contentType: 'application/json' });
    expect(after).toBe(before);
    expect(calls).toBeLessThanOrEqual(1);
    await expect(page.getByRole('alert').filter({ hasText: /读取|损坏|格式|未保存|保存失败/ }).first()).toBeVisible();
  });

  test(`${mode}: 新面试复盘写入失败后可只重试保存，不再次调用模型`, async ({ page }, testInfo) => {
    const before = await seed(page, mode);
    let calls = 0;
    await page.route(mode === 'turn' ? '**/api/interview' : '**/api/realtime/review', route => { calls++; return route.fulfill({ json: report }); });
    await page.reload();
    await page.evaluate(key => {
      const original = Storage.prototype.setItem;
      (window as any).__restoreHistorySave = () => { Storage.prototype.setItem = original; };
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('合成测试：历史写入暂时失败', 'QuotaExceededError');
        original.call(this, name, value);
      };
    }, historyKey(mode));
    await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
    await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
    const savedAfterFailure = await page.evaluate(key => localStorage.getItem(key), historyKey(mode));
    const retryCount = await page.getByRole('button', { name: '重试保存复盘', exact: true }).count();
    await testInfo.attach('synthetic-save-failure-observation', { body: JSON.stringify({ mode, savedHistoryUnchanged: savedAfterFailure === before, calls, retryCount }, null, 2), contentType: 'application/json' });
    expect(savedAfterFailure).toBe(before);
    expect(calls).toBe(1);
    await expect(page.getByRole('button', { name: '重试保存复盘', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '生成 AI 面试复盘', exact: true })).toBeVisible();
    // Generating again must not spend another request while this result is pending.
    await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
    expect(calls).toBe(1);
    const pending = await page.evaluate(key => localStorage.getItem(key), draftKey(mode));
    expect(JSON.parse(pending!).pendingReport.id).toBeTruthy();
    page.once('dialog', async dialog => { expect(dialog.message()).toContain('尚未保存到历史'); await dialog.dismiss(); });
    await page.getByRole('button', { name: mode === 'turn' ? '开始新一轮' : '开始新一轮 LIVE', exact: true }).click();
    await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
    // Reload loses the injected failure, but the generated report and stable ID remain.
    page.once('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '重试保存复盘', exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as any).__recordChangeCount = 0;
      window.addEventListener('kaikou-interview-records-changed', () => (window as any).__recordChangeCount++);
    });
    await page.getByRole('button', { name: '重试保存复盘', exact: true }).click();
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]').length, historyKey(mode))).toBe(2);
    expect(await page.evaluate(() => (window as any).__recordChangeCount)).toBe(1);
    expect(calls).toBe(1);
    const summaries = await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]').map((item: any) => item.draft.report.summary), historyKey(mode));
    expect(summaries).toEqual(expect.arrayContaining([report.summary, '已保存的合成旧复盘必须保留。']));
    await expect(page.getByRole('button', { name: '重试保存复盘', exact: true })).toHaveCount(0);
    // Simulate a previous successful history write whose draft cleanup was interrupted.
    await page.evaluate(({ key, pending }) => localStorage.setItem(key, pending!), { key: draftKey(mode), pending });
    await page.reload();
    await page.getByRole('button', { name: '重试保存复盘', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试保存复盘', exact: true })).toHaveCount(0);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key) || '[]').length, historyKey(mode))).toBe(2);
    expect(calls).toBe(1);
  });

  test(`${mode}: 满 20 条时保留报告，管理旧记录后可恢复保存`, async ({ page }) => {
    await seed(page, mode);
    const before = await page.evaluate(({ key, mode }) => {
      const original = JSON.parse(localStorage.getItem(key)!)[0];
      const values = Array.from({ length: 20 }, (_, n) => mode === 'turn'
        ? { ...original, id: `old-turn-${n}` }
        : { ...original, draft: { ...original.draft, id: `old-live-${n}` } });
      const raw = JSON.stringify(values); localStorage.setItem(key, raw); return raw;
    }, { key: historyKey(mode), mode });
    let calls = 0;
    await page.route(mode === 'turn' ? '**/api/interview' : '**/api/realtime/review', route => { calls++; return route.fulfill({ json: report }); });
    await page.reload();
    await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: '20 条' })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), historyKey(mode))).toBe(before);
    await expect(page.getByRole('button', { name: '管理已保存的面试记录', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '导出本轮文字与复盘', exact: true })).toBeVisible();
    // Only explicit removal of an old record frees a slot; save never evicts one.
    await page.evaluate(key => {
      const values = JSON.parse(localStorage.getItem(key)!); values.pop(); localStorage.setItem(key, JSON.stringify(values));
    }, historyKey(mode));
    await page.getByRole('button', { name: '重试保存复盘', exact: true }).click();
    await expect(page.getByRole('button', { name: '重试保存复盘', exact: true })).toHaveCount(0);
    const values = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), historyKey(mode));
    expect(values).toHaveLength(20);
    expect(values[0].draft.report.summary).toBe(report.summary);
    expect(values.filter((item: any) => item.draft.report.summary === '已保存的合成旧复盘必须保留。')).toHaveLength(19);
    expect(calls).toBe(1);
  });

  test(`${mode}: 保存新复盘保留不可识别旧条目及扩展字段`, async ({ page }) => {
    await seed(page, mode);
    const previous = await page.evaluate(key => {
      const values = JSON.parse(localStorage.getItem(key)!);
      values[0].legacyExtension = { preserved: true };
      values[0].draft.legacyDraftExtension = ['keep'];
      values.push({ unrecognizedLegacyEntry: { version: 0, content: '不可丢弃的合成旧数据' } }, null);
      localStorage.setItem(key, JSON.stringify(values)); return values;
    }, historyKey(mode));
    await page.route(mode === 'turn' ? '**/api/interview' : '**/api/realtime/review', route => route.fulfill({ json: report }));
    await page.reload();
    await page.getByRole('button', { name: '生成 AI 面试复盘', exact: true }).click();
    await expect(page.getByText(report.summary, { exact: true })).toBeVisible();
    const after = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), historyKey(mode));
    expect(after.slice(1)).toEqual(previous);
    expect(after[0].draft.pendingReport).toBeUndefined();
    await expect(page.getByRole('button', { name: '重试保存复盘', exact: true })).toHaveCount(0);
  });
}
