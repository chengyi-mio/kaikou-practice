import { _electron, chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const exe = process.argv[2];
if (!exe || !path.isAbsolute(exe) || !fs.existsSync(exe)) throw Error('Provide an absolute packaged executable path');
const profile = path.join(process.cwd(), '.reference-analysis', `interview-smoke-${Date.now()}`);
fs.mkdirSync(profile, { recursive: true });
const env = { ...process.env, KAIKOU_TEST_USER_DATA: profile, KAIKOU_TEST_PORT: '47933', KAIKOU_TEST_HIDE_WINDOW: '1' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath: exe, env, timeout: 60000 });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: '模拟面试' }).click();
  await expect(page.getByRole('heading', { name: '把面试，先练一遍' })).toBeVisible();
  await expect(page.getByText('不是可打断的实时通话')).toBeVisible();
  await expect(page.getByRole('button', { name: '生成第一道面试题' })).toBeVisible();
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const pdfPage = await browser.newPage();
    await pdfPage.setContent('<html><body>Product manager with five years of experience building enterprise software and coordinating teams.</body></html>');
    const pdf = await pdfPage.pdf();
    await page.locator('.interview-columns input[type="file"]').first().setInputFiles({ name: 'resume.pdf', mimeType: 'application/pdf', buffer: pdf });
    await expect(page.locator('.interview-columns textarea').first()).toHaveValue(/five years of experience/);
  } finally { await browser.close(); }
  console.log('PASS: packaged desktop opens the interview page, reads a PDF, and labels turn-based voice honestly. No live model call was made.');
} finally { if (app) await app.close(); }
