import { _electron, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [oldExe, newExe] = process.argv.slice(2);
assert.ok(oldExe && newExe, 'Provide old and new desktop executable paths');
for (const exe of [oldExe, newExe]) assert.ok(path.isAbsolute(exe) && fs.existsSync(exe), 'Executable must exist at an absolute path');
const userData = path.join(process.cwd(), '.reference-analysis', `upgrade-${Date.now()}`);
fs.mkdirSync(userData, {recursive:true});
const env = {...process.env, KAIKOU_TEST_USER_DATA:userData, KAIKOU_TEST_PORT:'47932', KAIKOU_TEST_HIDE_WINDOW:'1'};
delete env.ELECTRON_RUN_AS_NODE;
let app;
const launch = executablePath => _electron.launch({executablePath, env, timeout:60000});
try {
  app = await launch(oldExe);
  let page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const saved = await page.evaluate(() => window.desktopApp.saveServiceSettings({baseUrl:'https://example.com/v1',model:'upgrade-test-model',apiKey:'synthetic-upgrade-test-key'}));
  assert.equal(saved.success, true);
  await page.goto('http://127.0.0.1:47932/#/practice/improv');
  await page.getByRole('button',{name:'也可以用文字练习'}).click();
  await page.getByLabel('我的表达',{exact:true}).fill('这是一条跨版本升级测试记录，不是用户的真实练习。');
  await page.getByRole('button',{name:'仅保存练习',exact:true}).click();
  await expect(page.locator('.history-card')).toHaveCount(1);
  await page.evaluate(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('kaikou-practice',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('sessions','readwrite');const store=tx.objectStore('sessions');const request=store.getAll();request.onsuccess=()=>{store.put({...request.result[0],audio:new Blob(['synthetic-upgrade-audio'],{type:'audio/webm'})});};tx.oncomplete=resolve;tx.onabort=tx.onerror=reject;});db.close();
  });
  const before = fs.readFileSync(path.join(userData,'ai-service.json'));
  await app.close(); app = undefined;
  app = await launch(newExe);
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  assert.deepEqual(fs.readFileSync(path.join(userData,'ai-service.json')),before,'Upgrade must not replace the encrypted configuration');
  const state = await page.evaluate(async () => ({config:await window.desktopApp.getServiceSettings(),status:await (await fetch('/api/status')).json()}));
  assert.equal(state.config.success,true);
  assert.equal(state.config.value.hasKey,true);
  assert.equal(state.config.value.model,'upgrade-test-model');
  assert.equal(state.status.ai,true);
  const preservedAudio=await page.evaluate(async()=>{
    const db=await new Promise(resolve=>{const r=indexedDB.open('kaikou-practice',1);r.onsuccess=()=>resolve(r.result);});
    const record=await new Promise(resolve=>{const r=db.transaction('sessions').objectStore('sessions').getAll();r.onsuccess=()=>resolve(r.result[0]);});db.close();return record.audio.text();
  });
  assert.equal(preservedAudio,'synthetic-upgrade-audio');
  await page.goto('http://127.0.0.1:47932/#/history');
  await expect(page.locator('.history-card')).toHaveCount(1);
  await page.locator('.history-card').click();
  await expect(page.getByRole('button',{name:'生成 AI 点评',exact:true})).toBeVisible();
  await expect(page.locator('#saved-transcript')).toHaveValue('这是一条跨版本升级测试记录，不是用户的真实练习。');
  await page.goto('http://127.0.0.1:47932/#/practice/improv');
  await page.getByRole('button',{name:'也可以用文字练习'}).click();
  await expect(page.getByRole('button',{name:'生成 AI 点评',exact:true})).toBeVisible();
  console.log('PASS: cross-version upgrade preserves encrypted configuration, practice history and audio bytes, and AI entry in both practice and history. No model request sent.');
} finally { if(app) await app.close(); }
