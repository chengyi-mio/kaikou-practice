import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const exe=process.argv[2];
assert.ok(exe && path.isAbsolute(exe) && fs.existsSync(exe));
const output=path.resolve('.reference-analysis/interview-journey-desktop-final');
const profile=path.join(output,`profile-${Date.now()}`);
fs.mkdirSync(profile,{recursive:true});
const env={...process.env,KAIKOU_TEST_USER_DATA:profile,KAIKOU_TEST_PORT:'47936',KAIKOU_TEST_HIDE_WINDOW:'1'};
delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:exe,env,timeout:60000});
try {
  const page=await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.getByRole('button',{name:'进入面试工作台'})).toBeVisible();
  await expect(page.getByRole('button',{name:'准备一次真实沟通'})).toBeVisible();
  const capture=async name=>{
    const data=await app.evaluate(async({BrowserWindow})=>(await BrowserWindow.getAllWindows()[0].capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG().toString('base64'));
    fs.writeFileSync(path.join(output,name),Buffer.from(data,'base64'));
  };
  await capture('home.png');
  await page.getByRole('button',{name:'进入面试工作台'}).click();
  await expect(page.getByRole('group',{name:'面试训练重点'})).toBeVisible();
  await page.getByRole('button',{name:'项目深挖',exact:true}).click();
  await page.getByLabel('岗位名称（选填）').fill('合成演示 · 产品经理');
  await page.locator('.interview-columns textarea').nth(0).fill('合成测试资料：我负责过需求分析、流程优化和跨团队项目协作。');
  await page.locator('.interview-columns textarea').nth(1).fill('合成测试岗位：需要能够分析用户需求，推动产品落地，并验证交付结果。');
  await page.locator('.interview-materials').scrollIntoViewIfNeeded();
  await capture('preparation.png');
  await expect(page.getByRole('button',{name:'生成 AI 面试复盘',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'LIVE 实时面试',exact:true}).click();
  await expect(page.getByLabel('LIVE 语音面试现场')).toBeVisible();
  console.log(`PASS: packaged interview workspace, preparation focus, both core entries and LIVE call scene. Synthetic isolated profile only; no model request. Screenshots: ${output}`);
} finally {await app.close();}
