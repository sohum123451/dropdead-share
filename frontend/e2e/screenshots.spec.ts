import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const screenshotDir = path.resolve(__dirname, '../screenshots');

test.beforeAll(() => {
  if (!fs.existsSync(screenshotDir)) {
    fs.mkdirSync(screenshotDir, { recursive: true });
  }
});

const viewports = [
  { name: '1440px', width: 1440, height: 900 },
  { name: '375px', width: 375, height: 667 },
];

test.describe('Visual Screenshots & Accessibility', () => {
  for (const vp of viewports) {
    test(`Capture all requested screens at ${vp.name}`, async ({ page, request }) => {
      test.setTimeout(90000);
      await page.setViewportSize({ width: vp.width, height: vp.height });

      // 1. Upload Empty
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `01-upload-empty-${vp.name}.png`),
        fullPage: true,
      });

      // Verify Axe Accessibility & Contrast
      const axeResults = await new AxeBuilder({ page })
        .withRules(['color-contrast', 'aria-valid-attr', 'button-name', 'label'])
        .analyze();
      expect(axeResults.violations).toEqual([]);

      // 2. Upload Selected
      const testFilePath = path.join(screenshotDir, 'sample-document.pdf');
      fs.writeFileSync(testFilePath, 'Sample PDF test content for UI review');
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.locator('[data-testid="file-browse"]').click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles(testFilePath);
      await expect(page.locator('text=sample-document.pdf')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `02-upload-selected-${vp.name}.png`),
        fullPage: true,
      });

      // 3. Uploading with Progress (hold request open)
      await page.goto('/');
      const fcPromise2 = page.waitForEvent('filechooser');
      await page.locator('[data-testid="file-browse"]').click();
      const fc2 = await fcPromise2;
      await fc2.setFiles(testFilePath);

      // Delay S3 upload to capture the active progress bar state
      let releaseUpload: () => void = () => { };
      const holdUploadPromise = new Promise<void>((resolve) => {
        releaseUpload = resolve;
      });

      await page.route(/(file-share|localhost:9000)/, async (route) => {
        if (route.request().method() === 'PUT') {
          await holdUploadPromise;
          await route.continue();
        } else {
          await route.continue();
        }
      });

      const clickUpload = page.locator('[data-testid="create-link-button"]').click();
      await expect(page.locator('text=Uploading')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `03-uploading-progress-${vp.name}.png`),
        fullPage: true,
      });
      releaseUpload();
      await clickUpload;
      await page.unroute(/(file-share|localhost:9000)/);

      // 4. Upload Error
      await page.goto('/');
      const fcPromiseErr = page.waitForEvent('filechooser');
      await page.locator('[data-testid="file-browse"]').click();
      const fcErr = await fcPromiseErr;
      await fcErr.setFiles(testFilePath);

      await page.route('**/api/uploads/init', async (route) => {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({
            error: {
              code: 'UNKNOWN_ERROR',
              message: 'Storage service temporarily unavailable. Please try again.',
            },
          }),
        });
      });
      await page.locator('[data-testid="create-link-button"]').click();
      await expect(page.locator('[data-testid="upload-error"]')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `04-upload-error-${vp.name}.png`),
        fullPage: true,
      });
      await page.unroute('**/api/uploads/init');

      // 5. Result (without password)
      await page.goto('/');
      const fcPromiseNoPw = page.waitForEvent('filechooser');
      await page.locator('[data-testid="file-browse"]').click();
      const fcNoPw = await fcPromiseNoPw;
      await fcNoPw.setFiles(testFilePath);
      await page.locator('[data-testid="create-link-button"]').click();
      await expect(page.locator('[data-testid="share-ready"]')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `05-result-without-password-${vp.name}.png`),
        fullPage: true,
      });

      const noPwShareUrl = await page.locator('input[readonly]').inputValue();
      const noPwSharePath = new URL(noPwShareUrl).pathname;

      // 6. Result (with password)
      await page.goto('/');
      const fcPromisePw = page.waitForEvent('filechooser');
      await page.locator('[data-testid="file-browse"]').click();
      const fcPw = await fcPromisePw;
      await fcPw.setFiles(testFilePath);
      await page.locator('[data-testid="password-input"]').fill('Confidential123!');
      await page.locator('[data-testid="create-link-button"]').click();
      await expect(page.locator('[data-testid="share-ready"]')).toBeVisible();
      await expect(page.locator('text=Yes')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `06-result-with-password-${vp.name}.png`),
        fullPage: true,
      });

      const pwShareUrl = await page.locator('input[readonly]').inputValue();
      const pwSharePath = new URL(pwShareUrl).pathname;

      // 7. Portal Ready
      await page.goto(noPwSharePath);
      await expect(page.locator('text=sample-document.pdf')).toBeVisible();
      await expect(page.locator('[data-testid="countdown-display"]')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `07-portal-ready-${vp.name}.png`),
        fullPage: true,
      });

      // 8. Password Gate
      await page.goto(pwSharePath);
      await expect(page.locator('text=Password required')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `08-portal-password-gate-${vp.name}.png`),
        fullPage: true,
      });

      // 9. Wrong Password (shows "Incorrect password. N attempts left.")
      await page.locator('[data-testid="gate-password-input"]').fill('WrongPassword!');
      await page.locator('[data-testid="unlock-button"]').click();
      await expect(page.locator('[data-testid="password-error"]')).toContainText('Incorrect password');
      await page.screenshot({
        path: path.join(screenshotDir, `09-portal-wrong-password-${vp.name}.png`),
        fullPage: true,
      });

      // 10. Lockout (429 Rate Limited)
      await page.route('**/api/links/*/verify', async (route) => {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: {
            'Retry-After': '900',
            'RateLimit-Reset': '900',
          },
          body: JSON.stringify({
            error: {
              code: 'RATE_LIMITED',
              message: 'Too many incorrect attempts.',
              retryAfterSeconds: 900,
            },
          }),
        });
      });
      await page.locator('[data-testid="gate-password-input"]').fill('AnotherWrongPw');
      await page.locator('[data-testid="unlock-button"]').click();
      await expect(page.locator('[data-testid="password-error"]')).toContainText('Too many attempts');
      await page.screenshot({
        path: path.join(screenshotDir, `10-portal-lockout-${vp.name}.png`),
        fullPage: true,
      });
      await page.unroute('**/api/links/*/verify');

      // 11. Expired State
      const Database = require('../../backend/node_modules/better-sqlite3');
      const dbPath = path.resolve(__dirname, '../../backend/data/metadata.db');
      const db = new Database(dbPath);
      const tokenNoPw = noPwSharePath.replace('/d/', '');
      const pastTime = new Date(Date.now() - 3600 * 1000).toISOString();
      db.prepare('UPDATE files SET expires_at = ? WHERE token = ?').run(pastTime, tokenNoPw);
      db.close();

      await page.goto(noPwSharePath);
      await expect(page.locator('text=This link has expired')).toBeVisible();
      await expect(page.locator('text=The file is no longer available.')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `11-portal-expired-${vp.name}.png`),
        fullPage: true,
      });

      // 12. Exhausted State
      const exContent = Buffer.from('Single use download payload data');
      const initEx = await request.post('http://localhost:3000/api/uploads/init', {
        data: {
          filename: 'exhaust-check.txt',
          fileSize: exContent.length,
          contentType: 'text/plain',
          expiryValue: 24,
          expiryUnit: 'hours',
          maxDownloads: 1,
        },
      });
      const exData = await initEx.json();
      await fetch(exData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: exContent,
      });
      const finExRes = await request.post(`http://localhost:3000/api/uploads/${exData.uploadId}/finalize`, {
        data: {},
      });
      const { token: exToken } = await finExRes.json();

      // Consume the download
      await request.post(`http://localhost:3000/api/links/${exToken}/download`, { data: {} });

      await page.goto(`/d/${exToken}`);
      await expect(page.locator('text=Download limit reached')).toBeVisible();
      await expect(page.locator('text=This file is no longer available.')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `12-portal-exhausted-${vp.name}.png`),
        fullPage: true,
      });

      // 13. Not Found State
      await page.goto('/d/nonexistent-token-xyz-987');
      await expect(page.locator('text=Link not found')).toBeVisible();
      await expect(page.locator('text=Check the address, or ask the sender for a new link.')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `13-portal-not-found-${vp.name}.png`),
        fullPage: true,
      });

      // 14. Dark Mode for Upload
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.goto('/');
      await expect(page.locator('[data-testid="app-title"]')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `14-dark-mode-upload-${vp.name}.png`),
        fullPage: true,
      });

      // 15. Dark Mode for Portal
      const darkContent = Buffer.from('Dark mode sample file content');
      const initDark = await request.post('http://localhost:3000/api/uploads/init', {
        data: {
          filename: 'dark-mode-file.txt',
          fileSize: darkContent.length,
          contentType: 'text/plain',
          expiryValue: 24,
          expiryUnit: 'hours',
          maxDownloads: 5,
        },
      });
      const darkData = await initDark.json();
      await fetch(darkData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: darkContent,
      });
      const finDarkRes = await request.post(`http://localhost:3000/api/uploads/${darkData.uploadId}/finalize`, {
        data: {},
      });
      const { token: darkToken } = await finDarkRes.json();

      await page.goto(`/d/${darkToken}`);
      await expect(page.locator('text=dark-mode-file.txt')).toBeVisible();
      await page.screenshot({
        path: path.join(screenshotDir, `15-dark-mode-portal-${vp.name}.png`),
        fullPage: true,
      });

      // Reset media emulation
      await page.emulateMedia({ colorScheme: 'light' });

      // Clean up temporary sample file
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath);
      }
    });
  }
});
