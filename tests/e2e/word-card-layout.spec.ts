import { test, expect } from "@playwright/test";

for (const width of [390, 1280, 1600]) {
  test(`random word cards share the left edge with their controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/#/practice/improv");
    await page.getByRole("button", { name: "随机词语", exact: true }).click();
    await page.getByLabel("词语数量").selectOption("3");
    const boxes = await page.locator(".word-card").evaluate((card) => {
      const rect = card.getBoundingClientRect();
      const words = Array.from(card.children, (node) => node.getBoundingClientRect());
      const left = Math.min(...words.map((word) => word.left));
      const right = Math.max(...words.map((word) => word.right));
      const panel = card.closest(".practice-topic-panel")!;
      const leftOf = (selector: string) => {
        const element = panel.querySelector(selector)!;
        const box = element.getBoundingClientRect();
        return box.left;
      };
      return {
        wordLeft: left,
        sectionLefts: [leftOf(".topic-kind"), leftOf(".practice-topic-tags > span"), leftOf(".word-selects"), leftOf(".topic-instruction")],
        wordWidths: words.map((word) => word.width),
        textCentered: Array.from(card.children).every((word) => getComputedStyle(word).textAlign === "center"),
        fits: left >= rect.left && right <= rect.right && card.scrollWidth <= card.clientWidth,
      };
    });
    await page.screenshot({ path: `.reference-analysis/word-prompt-left-${width}.png` });
    for (const left of boxes.sectionLefts) expect(Math.abs(left - boxes.wordLeft)).toBeLessThan(2);
    expect(Math.max(...boxes.wordWidths) - Math.min(...boxes.wordWidths)).toBeLessThan(1);
    expect(boxes.textCentered).toBe(true);
    expect(boxes.fits).toBe(true);
  });
}
