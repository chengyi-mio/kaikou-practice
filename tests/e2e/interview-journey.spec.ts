import { test, expect } from '@playwright/test';
import fs from 'node:fs';

const source = { role:'产品经理',resume:'我有五年产品工作经验，负责需求分析和跨团队协作，正在从运营转岗产品。',job:'负责用户需求分析、产品方案设计、研发协作与产品效果验证，需要有完整项目经历。',stage:'transition',project:'项目：工单流程优化。我整理历史问题，协调研发拆分上线。' };
const original = '我们上线了工单系统，大家配合得不错，结果应该挺好的。';
const question = '请用一个项目，说明你从运营转岗产品的优势？';
const report = {summary:'有相关项目背景，但需要讲清个人行动和结果证据。', dimensions:[{name:'个人贡献',score:2,evidence:'大家配合得不错',advice:'区分你的职责与团队成果，讲清一个亲自做出的关键决定。'},{name:'岗位匹配',score:3,evidence:'上线了工单系统',advice:'说明项目中的需求分析能力如何迁移到产品岗位。'}],nextStep:'先练一段突出个人贡献的项目回答。'};
const feedback = { source:'ai',provider:'agnes',summary:'这次讲清了个人行动。',dimensions:[{id:'evidence',title:'具体证据',text:'说明了本人整理工单和确定优先级的行动。',status:'good',evidence:['我独立整理了历史工单']}],improvements:['再说明上线后的验证方式。'],rewrite:'',metrics:{characters:55,duration:0,fillers:0} };
async function seed(page: import('@playwright/test').Page, live = false) {
  await page.goto('/#/');
  await page.evaluate(({source,original,question,report,live})=>{
    localStorage.setItem('kaikou.interview.draft.v1',JSON.stringify({...source,question:'',answer:'',turns:[{question,answer:original}],report}));
    if(live){localStorage.setItem('kaikou.interview.mode','live');localStorage.setItem('kaikou.live-interview.draft.v1',JSON.stringify({id:'old-live-round',source,messages:[{id:'q',role:'assistant',text:question,final:true},{id:'a',role:'user',text:original,final:true}],elapsed:35,tokens:200,usage:[],minutes:10,report}));}
  },{source,original,question,report,live});
  await page.goto('/#/interview');
}

test('复盘到补练到独立复测完整闭环，保留旧稿，AI 失败恢复不误用旧回答', async({page})=>{
  await page.setViewportSize({width:1420,height:960});
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/status',r=>r.fulfill({json:{ai:true,asr:false}}));
  let calls=0;
  await page.route('**/api/analyze',r=>{
    const body=r.request().postDataJSON();
    expect(body.transcript).not.toBe(original);
    expect(body.ruleProfile).toBe('interview');
    expect(body.framework).toMatch(/^STAR/);
    expect(body.interviewContext.job).toBe(source.job);
    expect(body.realTask.criteria).toContain('个人贡献');
    calls++;
    return calls===1?r.fulfill({status:503,json:{error:'测试：AI 暂不可用，回答仍保留。'}}):r.fulfill({json:feedback});
  });
  await seed(page);
  const oldDraft=await page.evaluate(()=>localStorage.getItem('kaikou.interview.draft.v1'));
  await page.getByRole('button',{name:'去练这一项 · 个人贡献',exact:true}).click();
  await expect(page.getByRole('heading',{name:'面试专项补练 · 个人贡献'})).toBeVisible();
  await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'换一题',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'也可以用文字练习'}).click();
  await expect(page.getByLabel('我的表达',{exact:true})).toHaveValue('');
  await page.getByLabel('我的表达',{exact:true}).fill('我独立整理了历史工单，确认高频问题并确定优先级，随后协调研发分阶段上线。');
  await page.getByRole('button',{name:'生成 AI 点评',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'AI 暂不可用'})).toBeVisible();
  await expect(page.getByLabel('我的表达',{exact:true})).toHaveValue(/我独立整理/);
  await page.getByRole('button',{name:'重试 AI 点评',exact:true}).click();
  await expect(page.getByRole('heading',{name:'练完这一点，回到面试中试一试'})).toBeVisible();
  await page.getByText('对比面试原话与这次回答',{exact:true}).click();
  await expect(page.locator('.journey-comparison')).toContainText(original);
  await page.getByRole('button',{name:'同题独立复测',exact:true}).click();
  await expect(page.getByRole('heading',{name:'原题复测 · 个人贡献'})).toBeVisible();
  await expect(page.getByText('回看面试原话与岗位要求',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'也可以用文字练习'}).click();
  await expect(page.getByLabel('我的表达',{exact:true})).toHaveValue('');
  await page.getByLabel('我的表达',{exact:true}).fill('我负责工单项目的需求分析。我独立整理了历史工单并验证问题频率，确定分阶段上线方案。');
  await page.getByRole('button',{name:'生成 AI 点评',exact:true}).click();
  await page.getByRole('button',{name:'回到面试工作台',exact:true}).click();
  await page.getByRole('button',{name:'面试记录与补练',exact:true}).click();
  await page.locator('.record-disclosure > summary').filter({hasText:'面试后的专项训练'}).click();
  await expect(page.locator('.journey-task')).toContainText('已保存 2 次训练 · 1 次复测');
  expect(await page.evaluate(()=>localStorage.getItem('kaikou.interview.draft.v1'))).toBe(oldDraft);
  await page.reload();
  await page.locator('.record-disclosure > summary').filter({hasText:'面试后的专项训练'}).click();
  await expect(page.locator('.journey-task')).toContainText('已保存 2 次训练');
  fs.mkdirSync('.impeccable/review',{recursive:true});
  await page.screenshot({path:'.impeccable/review/interview-desktop.png'});
  await page.locator('.journey-task').scrollIntoViewIfNeeded();
  await expect(page.locator('.journey-task')).toBeInViewport();
  await page.locator('.interview-training-history').scrollIntoViewIfNeeded();
  await page.screenshot({path:'.impeccable/review/interview-training-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.locator('.journey-task').scrollIntoViewIfNeeded();
  await expect(page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'练习记录'})).toHaveAttribute('aria-current','page');
  await page.screenshot({path:'.impeccable/review/interview-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  page.once('dialog',d=>d.accept());
  await page.getByRole('button',{name:'移除任务',exact:true}).click();
  await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'练习记录'}).click();
  await page.locator('.history-card').first().click();
  await page.getByRole('button',{name:'同题独立复测',exact:true}).click();
  await expect(page.getByRole('heading',{name:question,exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'原题复测 · 个人贡献'})).toBeVisible();
  await expect(page.locator('body')).not.toContainText(report.dimensions[0].advice);
  await expect(page.getByText('可以这样组织',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'也可以用文字练习'}).click();
  await expect(page.getByLabel('我的表达',{exact:true})).toHaveValue('');
  await expect(page.locator('body')).not.toContainText(report.dimensions[0].advice);
  expect(await page.evaluate(()=>localStorage.getItem('kaikou.interview.draft.v1'))).toBe(oldDraft);
});

test('独立复测录音时不提示上一版建议，基础反馈仍独立可用',async({page})=>{
  await page.route('**/api/status',r=>r.fulfill({json:{ai:false,asr:true}}));
  await page.route('**/api/transcribe',r=>r.fulfill({json:{text:'我独立梳理需求并验证结果，再向团队说明了取舍。'}}));
  await page.route('**/api/analyze',r=>{expect(r.request().headers()['x-kaikou-require-ai']).toBe('0');return r.fulfill({json:{...feedback,source:'basic',provider:undefined}});});
  await seed(page);
  await page.getByRole('button',{name:'去练这一项 · 个人贡献',exact:true}).click();
  const task=await page.evaluate(()=>JSON.parse(localStorage.getItem('kaikou.interview.training.v1')!)[0]);
  await page.goto(`/#/practice/logic?interviewTask=${task.id}&framework=STAR&retest=1`);
  await expect(page.locator('body')).not.toContainText(report.dimensions[0].advice);
  await page.getByRole('button',{name:'开始表达',exact:true}).click();
  await expect(page.locator('.practice-recording-panel')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(report.dimensions[0].advice);
  await expect(page.getByRole('button',{name:/结束表达|结束录音/})).toBeVisible({timeout:10000});
  await page.getByRole('button',{name:/结束表达|结束录音/}).click();
  await expect(page.getByLabel('我的表达',{exact:true})).toHaveValue(/我独立梳理需求/);
  await expect(page.locator('body')).not.toContainText(report.dimensions[0].advice);
  await expect(page.getByRole('button',{name:'生成 AI 点评',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'查看基础反馈',exact:true}).click();
  await expect(page.locator('.interview-return')).toContainText('当前是基础反馈');
});

test('LIVE 旧复盘也能补练，原通话文字不改动，存储失败时不离开',async({page})=>{
  await page.route('**/api/realtime/status',r=>r.fulfill({json:{configured:false}}));
  await seed(page,true);
  const before=await page.evaluate(()=>localStorage.getItem('kaikou.live-interview.draft.v1'));
  await page.evaluate(()=>{const native=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='kaikou.interview.training.v1')throw Error('simulated disk full');native.call(this,k,v);};});
  await page.getByRole('button',{name:'去练这一项 · 个人贡献',exact:true}).click();
  await expect(page.locator('.interview-next [role=alert]')).toContainText('未保存');
  await expect(page).toHaveURL(/interview$/);
  await page.reload();
  await page.getByRole('button',{name:'去练这一项 · 个人贡献',exact:true}).click();
  await expect(page.getByRole('heading',{name:'面试专项补练 · 个人贡献'})).toBeVisible();
  expect(await page.evaluate(()=>localStorage.getItem('kaikou.live-interview.draft.v1'))).toBe(before);
});

test('项目素材持久化并明确用于本轮，追问携带目标与真实项目但不自动带入回答',async({page})=>{
  let request:any;
  await page.route('**/api/interview',r=>{request=r.request().postDataJSON();return r.fulfill({json:{question}});});
  await page.goto('/#/interview');
  await page.getByRole('button',{name:'跳槽 / 转岗',exact:true}).click();
  await page.locator('.interview-columns textarea').nth(0).fill(source.resume);
  await page.locator('.interview-columns textarea').nth(1).fill(source.job);
  await page.getByText('项目素材库 · 准备能讲清楚的真实经历（选填）',{exact:true}).click();
  await page.getByLabel('项目名称',{exact:true}).fill('工单系统优化');
  await page.getByLabel('我亲自做的事',{exact:true}).fill('我独立整理工单、验证需求并协调开发。');
  await page.getByRole('button',{name:'保存项目素材',exact:true}).click();
  await page.getByRole('button',{name:'用于本轮面试',exact:true}).click();
  await page.reload();
  await page.locator('.interview-materials > summary').click();
  await page.getByText('项目素材库 · 准备能讲清楚的真实经历（选填）',{exact:true}).click();
  await expect(page.locator('.project-selected')).toContainText('工单系统优化');
  await page.getByRole('button',{name:'生成第一道面试题',exact:true}).click();
  expect(request.stage).toBe('transition');expect(request.project).toContain('我独立整理工单');expect(request.history).toEqual([]);
  await expect(page.getByLabel(/我的回答/)).toHaveValue('');
  await page.locator('.interview-materials > summary').click();
  await expect(page.getByRole('button',{name:'用于本轮面试',exact:true})).toBeDisabled();
});
