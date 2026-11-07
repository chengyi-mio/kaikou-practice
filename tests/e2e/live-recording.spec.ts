import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { nativePeer, prepare } from './helpers/live-peer';

async function syntheticMicrophone(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext(), tone = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      tone.frequency.value = 440; gain.gain.value = 0.1;
      tone.connect(gain).connect(destination); tone.start(); await context.resume();
      (window as any).__recordingMic = { context, tone };
      return destination.stream;
    };
  });
}
async function begin(page: import('@playwright/test').Page) {
  await page.getByRole('button',{name:'开始 LIVE 面试',exact:true}).click();
  await expect(page.getByText('正在录制双方声音',{exact:true})).toBeVisible();
  await expect(page.locator('.live-current-question')).toContainText('请介绍');
}
async function readRecords(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open('kaikou-live-recordings',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    return await new Promise<any[]>(resolve=>{const r=db.transaction('recordings').objectStore('recordings').getAll();r.onsuccess=()=>{db.close();resolve(r.result);};});
  });
}

test('双方声音保存、回放下载、跨页面与重载、复盘关联及只删除音频',async({page})=>{
  await syntheticMicrophone(page);await nativePeer(page);await prepare(page);await begin(page);
  await page.waitForTimeout(2400);
  await page.evaluate(()=>(window as any).__emit([{type:'input_audio_buffer.speech_started',item_id:'a'},{type:'conversation.item.input_audio_transcription.completed',item_id:'a',transcript:'我负责需求分析和项目交付。'}]));
  await page.getByRole('button',{name:'结束 / 暂停通话',exact:true}).click();
  const row=page.locator('.live-recording-row');await expect(row).toHaveCount(1);await expect(row).toContainText('已保存到本机');
  const records=await readRecords(page);expect(records).toHaveLength(1);expect(records[0].duration).toBeGreaterThan(2);expect(records[0].bytes).toBeGreaterThan(1000);
  const spectrum=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('kaikou-live-recordings',1);r.onsuccess=()=>resolve(r.result);});
    const chunks=await new Promise<any[]>(resolve=>{const r=db.transaction('chunks').objectStore('chunks').getAll();r.onsuccess=()=>resolve(r.result);});db.close();
    const context=new AudioContext();const audio=await context.decodeAudioData(await new Blob(chunks.map(c=>c.blob),{type:'audio/webm'}).arrayBuffer());
    const samples=audio.getChannelData(0), start=Math.floor(audio.sampleRate*0.7), size=Math.min(48000,samples.length-start);
    const magnitude=(f:number)=>{let re=0,im=0;for(let i=0;i<size;i++){const angle=2*Math.PI*f*i/audio.sampleRate;re+=samples[start+i]*Math.cos(angle);im+=samples[start+i]*Math.sin(angle);}return Math.hypot(re,im)/size;};
    const result={mic:magnitude(440),remote:magnitude(220),noise:magnitude(731),seconds:audio.duration};await context.close();return result;
  });
  expect(spectrum.mic).toBeGreaterThan(0.01);expect(spectrum.remote).toBeGreaterThan(0.01);expect(spectrum.mic).toBeGreaterThan(spectrum.noise*10);
  await row.getByRole('button',{name:'回放录音',exact:true}).click();await expect(row.locator('audio')).toHaveAttribute('src',/^blob:/);
  await expect.poll(()=>row.locator('audio').evaluate((a:HTMLAudioElement)=>Number.isFinite(a.duration)&&a.duration>2)).toBe(true);
  await row.locator('audio').evaluate((a:HTMLAudioElement)=>{a.currentTime=1;});await expect.poll(()=>row.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(.9);
  await row.locator('audio').evaluate((a:HTMLAudioElement)=>a.play());await expect.poll(()=>row.locator('audio').evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(0);
  await row.locator('audio').evaluate((a:HTMLAudioElement)=>a.pause());
  const downloaded=page.waitForEvent('download');await row.getByRole('button',{name:'下载录音',exact:true}).click();const file=await downloaded;
  expect(file.suggestedFilename()).toMatch(/^LIVE-产品经理-.*\.webm$/);expect(fs.statSync((await file.path())!).size).toBeGreaterThanOrEqual(records[0].bytes);
  await page.route('**/api/realtime/review',r=>r.fulfill({json:{summary:'这是录音关联测试复盘。',dimensions:[{name:'结构',score:3,evidence:'我负责需求分析',advice:'补充结果。'}],nextStep:'再次回听。'}}));
  await page.getByRole('button',{name:'生成 AI 面试复盘',exact:true}).click();await expect(page.getByText('这是录音关联测试复盘。')).toBeVisible();
  // Finishing a review must not resume a previously paused recording.
  await page.waitForTimeout(100);
  expect(await row.locator('audio').evaluate((a:HTMLAudioElement)=>a.paused)).toBe(true);
  await page.reload();await expect(page.locator('.live-recording-row')).toHaveCount(1);await expect(page.getByRole('button',{name:'查看对应复盘'})).toBeVisible();
  await page.getByRole('button',{name:'回放录音',exact:true}).click();await expect(page.locator('.live-recording-row audio')).toBeVisible();
  await page.setViewportSize({width:1420,height:1000});await page.locator('.live-recordings').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:'.impeccable/review/recording-desktop.png'});
  await page.setViewportSize({width:1080,height:720});await page.locator('.live-recordings').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:'.impeccable/review/recording-compact.png'});
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'开始新一轮 LIVE',exact:true}).click();
  await page.locator('.live-recording-history summary').click();await expect(page.locator('.live-recording-row')).toHaveCount(1);
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'查看对应复盘'}).click();await expect(page.getByText('这是录音关联测试复盘。')).toBeVisible();
  page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'删除录音',exact:true}).click();await expect(page.locator('.live-recording-row')).toHaveCount(0);
  await expect(page.getByText('这是录音关联测试复盘。')).toBeVisible();await expect(page.getByLabel(/第 \d+ 条回答文字/)).toHaveValue('我负责需求分析和项目交付。');
  expect(await readRecords(page)).toHaveLength(0);
});

test('窗口异常退出后，已经逐段写入的录音仍能下载回放',async({page,context})=>{
  await syntheticMicrophone(page);await nativePeer(page);await prepare(page);await begin(page);
  await expect.poll(async()=>(await readRecords(page))[0]?.bytes||0).toBeGreaterThan(1000);
  // Bypass beforeunload to simulate renderer loss: no React cleanup/final chunk.
  await page.close({runBeforeUnload:false});
  const recovered=await context.newPage();await recovered.goto('/#/interview');
  await expect(recovered.locator('.live-recording-row')).toHaveCount(1);await expect(recovered.locator('.live-recording-row')).toContainText('中断保留');
  await recovered.getByRole('button',{name:'回放录音',exact:true}).click();
  const audio=recovered.locator('.live-recording-row audio');
  await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>Number.isFinite(a.duration)&&a.duration>0)).toBe(true);
  await audio.evaluate((a:HTMLAudioElement)=>a.play());await expect.poll(()=>audio.evaluate((a:HTMLAudioElement)=>a.currentTime)).toBeGreaterThan(0);
});

test('断线保存当前录音，重连分段，离开页面后仍可恢复',async({page})=>{
  await syntheticMicrophone(page);await nativePeer(page);await prepare(page);await begin(page);await page.waitForTimeout(1200);
  await page.evaluate(()=>(window as any).__channel.close());await expect(page.getByRole('alert')).toContainText('通道已关闭');
  await expect(page.locator('.live-recording-row')).toHaveCount(1);await expect(page.locator('.live-recording-row')).toContainText('中断保留');
  await page.getByRole('button',{name:'重新连接 / 继续本轮',exact:true}).click();await expect(page.getByText('正在录制双方声音',{exact:true})).toBeVisible();await page.waitForTimeout(1200);
  page.once('dialog',d=>d.accept());await page.getByRole('link',{name:'今日练习',exact:true}).first().click();
  await expect.poll(async()=> (await readRecords(page)).filter(r=>r.bytes>0).length).toBe(2);
  await page.goto('/#/interview');await expect(page.locator('.live-recording-row')).toHaveCount(2);
  const records=await readRecords(page);expect(new Set(records.map(r=>r.roundId)).size).toBe(1);expect(new Set(records.map(r=>r.id)).size).toBe(2);
});

test('写入失败保留临时音频，可下载及重试，不假报已保存',async({page})=>{
  await syntheticMicrophone(page);await nativePeer(page);await prepare(page);await begin(page);
  await page.evaluate(()=>{const original=IDBObjectStore.prototype.put;(window as any).__restorePut=()=>{IDBObjectStore.prototype.put=original;};IDBObjectStore.prototype.put=function(...args:Parameters<typeof original>){if(this.transaction.db.name==='kaikou-live-recordings')throw new DOMException('isolated quota failure','QuotaExceededError');return original.apply(this,args);};});
  await page.waitForTimeout(1300);await page.getByRole('button',{name:'结束 / 暂停通话',exact:true}).click();
  await expect(page.getByRole('button',{name:'重试保存录音',exact:true})).toBeVisible();await expect(page.locator('.live-recordings')).toContainText('尚未完整保存');
  await expect(page.locator('.live-recording-row')).toHaveCount(0);
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'下载临时录音',exact:true}).click();expect(fs.statSync((await(await downloaded).path())!).size).toBeGreaterThan(1000);
  await page.evaluate(()=>(window as any).__restorePut());await page.getByRole('button',{name:'重试保存录音',exact:true}).click();await expect(page.locator('.live-recording-row')).toHaveCount(1);await expect(page.locator('.live-recording-row')).toContainText('已保存到本机');
  await page.reload();await expect(page.locator('.live-recording-row')).toHaveCount(1);
});

test('麦克风静音与打断面试官会同步停止录下对应声音',async({page})=>{
  await syntheticMicrophone(page);await nativePeer(page);await prepare(page);await begin(page);await page.waitForTimeout(1200);
  await page.getByRole('button',{name:'麦克风静音',exact:true}).click();await page.getByRole('button',{name:'打断面试官',exact:true}).click();await page.waitForTimeout(1200);
  await page.getByRole('button',{name:'结束 / 暂停通话',exact:true}).click();await expect(page.locator('.live-recording-row')).toHaveCount(1);
  const energy=await page.evaluate(async()=>{
    const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('kaikou-live-recordings',1);r.onsuccess=()=>resolve(r.result);});
    const chunks=await new Promise<any[]>(resolve=>{const r=db.transaction('chunks').objectStore('chunks').getAll();r.onsuccess=()=>resolve(r.result);});db.close();
    const ctx=new AudioContext(), buffer=await ctx.decodeAudioData(await new Blob(chunks.map(c=>c.blob),{type:'audio/webm'}).arrayBuffer());const a=buffer.getChannelData(0);
    const rms=(from:number,to:number)=>{const slice=a.slice(Math.floor(from*buffer.sampleRate),Math.floor(to*buffer.sampleRate));return Math.sqrt(slice.reduce((n,v)=>n+v*v,0)/slice.length);};const result={early:rms(.3,.8),late:rms(buffer.duration-.7,buffer.duration-.2)};await ctx.close();return result;
  });
  expect(energy.early).toBeGreaterThan(.01);expect(energy.late).toBeLessThan(energy.early*.1);
});
