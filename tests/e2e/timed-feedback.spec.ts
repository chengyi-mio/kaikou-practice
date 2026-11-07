import { test, expect } from "@playwright/test";

test("verified transcript evidence seeks the saved recording and shows timed delivery facts", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("kaikou-practice", 1); request.onsuccess = () => resolve(request.result); });
    const rate = 16000, frames = rate * 4;
    const bytes = new ArrayBuffer(44 + frames * 2), view = new DataView(bytes);
    const fourCC = (offset: number, value: string) => [...value].forEach((character, i) => view.setUint8(offset + i, character.charCodeAt(0)));
    fourCC(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); fourCC(8, "WAVE"); fourCC(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); fourCC(36, "data"); view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i / 20) * 9000), true);
    const transcript = "项目延期了。明天下午同步。";
    const session = {
      id: "timed-evidence", createdAt: "2026-10-08T08:00:00Z", mode: "logic", topic: "解释延期", transcript, duration: 4,
      audio: new Blob([bytes], { type: "audio/wav" }),
      transcriptSegments: [{ start: 0.2, end: 1.8, text: "项目延期了。", startChar: 0, endChar: 6 }, { start: 2.0, end: 3.8, text: "明天下午同步。", startChar: 6, endChar: 13 }],
      transcriptWords: [{ start: 2.2, end: 2.8, text: "明天下午", startChar: 6, endChar: 10 }, { start: 3.0, end: 3.5, text: "同步", startChar: 10, endChar: 12 }],
      feedback: { source: "ai", provider: "agnes", model: "test", ruleVersion: "agnes-coach-2", ruleProfile: "report", profileName: "工作汇报", summary: "说明了下一步。", dimensions: [{ id: "focus", title: "目标与重点", status: "partial", standard: "明确说明变化", text: "内容可更具体。", evidence: ["明天下午同步。"] }], improvements: ["说明影响。"], rewrite: "", metrics: { characters: 11, duration: 4, fillers: 0 } },
    };
    await new Promise<void>((resolve) => { const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").put(session); tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.goto("/#/record/timed-evidence");
  await page.reload();
  await page.getByRole("button", { name: "从 2.2 秒处听原话" }).click();
  await expect(page.locator(".feedback-evidence audio")).toBeVisible();
  await expect.poll(() => page.locator(".feedback-evidence audio").evaluate((element) => (element as HTMLAudioElement).currentTime)).toBeGreaterThan(2.1);
  await expect(page.getByText("识别片段字/分钟")).toBeVisible();
});

test("history plots only compatible Agnes judgments and exposes source evidence", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("kaikou-practice", 1); request.onsuccess = () => resolve(request.result); });
    const make = (id: string, date: string, status: string, evidence: string, model = "same") => ({ id, createdAt: date, mode: "logic", topic: "项目汇报", transcript: evidence, duration: 0, feedback: { source: "ai", provider: "agnes", model, ruleVersion: "agnes-coach-2", ruleProfile: "report", profileName: "工作汇报", summary: "测试", dimensions: [{ id: "focus", title: "切题与重点", status, standard: "直接回应题目", text: "测试", evidence: [evidence] }], improvements: ["继续练"], rewrite: "", metrics: { characters: 8, duration: 0, fillers: 0 } } });
    await new Promise<void>((resolve) => { const tx = db.transaction("sessions", "readwrite"); const store = tx.objectStore("sessions"); store.put(make("trend-1", "2026-10-01T08:00:00Z", "missing", "我说了一些背景。")); store.put(make("trend-2", "2026-10-08T08:00:00Z", "good", "项目会在周五交付。")); store.put(make("trend-other-model", "2026-10-08T09:00:00Z", "good", "换模型的判断。", "other")); tx.oncomplete = () => resolve(); });
    db.close();
  });
  await page.goto("/#/history");
  await page.reload();
  await expect(page.locator(".skill-progress-timeline article")).toHaveCount(2);
  await expect(page.locator(".skill-progress-timeline")).toContainText("未体现");
  await expect(page.locator(".skill-progress-timeline")).toContainText("已做到");
  await page.getByText("逐次查看原话依据").click();
  await expect(page.getByText("项目会在周五交付。", { exact: true }).first()).toBeVisible();
});
