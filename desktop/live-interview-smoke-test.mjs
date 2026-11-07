import { _electron, expect } from "@playwright/test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const exe = process.argv[2];
assert.ok(exe && path.isAbsolute(exe) && fs.existsSync(exe), "Provide an absolute packaged executable path");
const profile = path.join(process.cwd(), ".reference-analysis", `live-desktop-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const env = { ...process.env, KAIKOU_TEST_USER_DATA: profile, KAIKOU_TEST_PORT: "47935", KAIKOU_TEST_HIDE_WINDOW: "1" };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const launch = () => _electron.launch({ executablePath: exe, env, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"], timeout: 60000 });
async function capture(file) {
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const shot = await BrowserWindow.getAllWindows()[0].capturePage(undefined, { stayHidden: true, stayAwake: true });
    return shot.toPNG().toString("base64");
  });
  assert.ok(png.length > 1000, "Desktop capture must contain pixels");
  fs.writeFileSync(file, Buffer.from(png, "base64"));
}
try {
  app = await launch();
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width: 1420, height: 1000 });
  const original = await page.evaluate(() => window.desktopApp.saveServiceSettings({ baseUrl: "https://example.com/v1", model: "test-review", apiKey: "synthetic-review-secret" }));
  assert.equal(original.success, true);
  const reviewFile = path.join(profile, "ai-service.json");
  const reviewBytes = fs.readFileSync(reviewFile);
  await page.goto("http://127.0.0.1:47935/#/interview");
  await page.getByRole("button", { name: "LIVE 实时面试", exact: true }).click();
  await page.locator(".live-settings summary").click();
  await page.getByLabel("百炼业务空间 ID").fill("synthetic-workspace");
  await page.getByLabel("实时语音 API Key", { exact: true }).fill("synthetic-live-secret");
  await page.getByLabel("控制台显示的剩余免费 tokens").fill("1000000");
  await page.getByLabel("免费额度到期时间").fill("2030-01-01T00:00");
  await page.locator(".live-trial-check input[type=checkbox]").check();
  await page.getByRole("button", { name: "保存 LIVE 配置", exact: true }).click();
  await expect(page.getByText("密钥已保存，不回填显示。", { exact: false })).toBeVisible();
  assert.deepEqual(fs.readFileSync(reviewFile), reviewBytes);
  assert.ok(!fs.readFileSync(path.join(profile, "live-service.json"), "utf8").includes("synthetic-live-secret"));
  await page.locator(".live-panel").scrollIntoViewIfNeeded();
  await capture(path.join(profile, "live-desktop-config.png"));
  await app.close(); app = undefined;
  app = await launch(); page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const restored = await page.evaluate(async () => ({ live: await window.desktopApp.getRealtimeSettings(), review: await window.desktopApp.getServiceSettings() }));
  assert.equal(restored.live.value.hasKey, true); assert.equal(restored.review.value.hasKey, true);
  assert.equal(restored.live.value.workspace, "synthetic-workspace");
  assert.ok(!JSON.stringify(restored).includes("synthetic-live-secret"));
  const blankSave = await page.evaluate(() => window.desktopApp.saveRealtimeSettings({ region: "cn-beijing", workspace: "synthetic-workspace", model: "qwen3.8-omni-flash-realtime", apiKey: "" }));
  assert.equal(blankSave.value.hasKey, true);
  // Provider exchange is intercepted; no request or résumé goes to a real AI service.
  await page.route("**/api/realtime/session", async (route) => {
    const offer = route.request().postDataJSON();
    const sdp = await page.evaluate(async (offer) => {
      const pc = new RTCPeerConnection({ iceServers: [] }); window.__testProvider = pc;
      pc.ondatachannel = (event) => {
        const dc = event.channel;
        const emit = (v) => dc.send(JSON.stringify({ ...v, event_id: crypto.randomUUID() }));
        dc.onopen = () => emit({ type: "session.created" });
        dc.onmessage = (message) => {
          const e = JSON.parse(message.data);
          if (e.type === "session.update") emit({ type: "session.updated" });
          if (e.type === "response.create") {
            emit({ type: "response.created" });
            emit({ type: "response.audio_transcript.done", item_id: "test-q", transcript: "测试面试官：请介绍一次项目经历？" });
            emit({ type: "input_audio_buffer.speech_started", item_id: "test-a" });
            emit({ type: "conversation.item.input_audio_transcription.completed", item_id: "test-a", transcript: "隔离测试回答：我负责需求分析和项目协调。" });
          }
        };
      };
      await pc.setRemoteDescription({ type: "offer", sdp: offer.sdp });
      await pc.setLocalDescription(await pc.createAnswer());
      if (pc.iceGatheringState !== "complete") await new Promise((resolve) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); }; });
      return pc.localDescription.sdp;
    }, offer);
    await route.fulfill({ json: { sdp, session: { modalities: ["text", "audio"], instructions: "isolated desktop test" } } });
  });
  await page.goto("http://127.0.0.1:47935/#/interview");
  await page.getByRole("button", { name: "LIVE 实时面试", exact: true }).click();
  await page.locator(".interview-columns textarea").nth(0).fill("虚构测试简历：我负责需求分析、项目管理和跨团队沟通协作。");
  await page.locator(".interview-columns textarea").nth(1).fill("虚构测试岗位：需要产品规划、项目交付和团队协调沟通能力。");
  await page.locator(".live-panel > .live-consent input").check();
  await page.getByRole("button", { name: "开始 LIVE 面试", exact: true }).click();
  await expect(page.getByText("隔离测试回答：我负责需求分析和项目协调。", { exact: true })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(1300);
  await page.getByRole("button", { name: "结束 / 暂停通话", exact: true }).click();
  await expect(page.locator('.live-recording-row')).toHaveCount(1);
  await expect(page.locator('.live-recording-row')).toContainText('已保存到本机');
  await expect(page.getByRole("button", { name: "生成 AI 面试复盘", exact: true })).toBeEnabled();
  await page.locator(".live-transcript").scrollIntoViewIfNeeded();
  await capture(path.join(profile, "live-desktop-dialogue-test-peer.png"));
  await app.close();app=undefined;
  app=await launch();page=await app.firstWindow();await page.waitForLoadState('domcontentloaded');
  await page.goto('http://127.0.0.1:47935/#/interview');
  await expect(page.locator('.live-recording-row')).toHaveCount(1);
  await page.getByRole('button',{name:'回放录音',exact:true}).click();
  await expect.poll(()=>page.locator('.live-recording-row audio').evaluate(a=>Number.isFinite(a.duration)&&a.duration>1)).toBe(true);
  await page.locator('.live-recording-row audio').evaluate(a=>a.play());
  await expect.poll(()=>page.locator('.live-recording-row audio').evaluate(a=>a.currentTime)).toBeGreaterThan(0);
  await page.locator('.live-recording-row audio').evaluate(a=>a.pause());
  await page.locator('.live-recordings').scrollIntoViewIfNeeded();await capture(path.join(profile,'live-recording-after-restart.png'));
  assert.deepEqual(fs.readFileSync(reviewFile),reviewBytes);
  console.log(`PASS: packaged WebRTC, captions, review entry, LIVE recording persists across process restart and plays with finite duration, OS encrypted LIVE key restart/blank reuse, original review key unchanged. Test provider only, no real AI call. Screenshots: ${profile}`);
} finally { if (app) await app.close(); }
