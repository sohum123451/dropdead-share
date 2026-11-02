import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('DropDead Vercel Production UI & Flow', () => {
  const prodBase = 'https://dropdead-share.vercel.app';
  const testFile = path.resolve(__dirname, '../../test-prod-upload.txt');

  test.beforeAll(() => {
    fs.writeFileSync(testFile, 'DropDead Production Browser Verification File Content: ' + Date.now());
  });

  test.afterAll(() => {
    try {
      fs.unlinkSync(testFile);
    } catch {}
  });

  test('Full UI flow on production: upload, get share link, open link, verify password, and download', async ({ page }) => {
    test.setTimeout(90 * 1000);

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));
    page.on('requestfailed', req => console.log('REQ FAILED:', req.url(), req.failure()?.errorText));

    // 1. Visit Upload Page
    await page.goto(prodBase);
    await expect(page.locator('[data-testid="app-title"]')).toHaveText('Share files');
    await expect(page.locator('[data-testid="file-dropzone"]')).toBeVisible();

    // 2. Configure password & limits
    await page.locator('[data-testid="password-input"]').fill('SecretPass999!');

    // 3. Upload file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="file-browse"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(testFile);

    // 4. Click Create Link
    await expect(page.locator('[data-testid="create-link-button"]')).toBeEnabled();
    await page.locator('[data-testid="create-link-button"]').click();

    // 5. Result page assertions
    await expect(page.locator('[data-testid="share-ready"]')).toHaveText('Link created', { timeout: 30000 });
    const shareInput = page.locator('[data-testid="share-url-input"]');
    await expect(shareInput).toBeVisible();
    const shareUrl = await shareInput.inputValue();
    expect(shareUrl).toContain('/d/');
    console.log('Production Share URL created from browser:', shareUrl);

    // 6. Navigate directly to recipient portal using shareUrl
    await page.goto(shareUrl);

    // 7. Recipient portal password gate
    await expect(page.locator('[data-testid="gate-password-input"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="unlock-button"]')).toBeVisible();

    // 8. Test wrong password
    await page.locator('[data-testid="gate-password-input"]').fill('wrong-pw');
    await page.locator('[data-testid="unlock-button"]').click();
    await expect(page.locator('[data-testid="password-error"]')).toBeVisible({ timeout: 10000 });

    // 9. Enter correct password
    await page.locator('[data-testid="gate-password-input"]').fill('SecretPass999!');
    await page.locator('[data-testid="unlock-button"]').click();

    // 10. Portal ready state & Download button
    await expect(page.locator('[data-testid="download-button"]')).toBeVisible({ timeout: 15000 });

    // 11. Trigger download
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-button"]').click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^test-prod-upload.*\.txt$/);
    const downloadPath = path.resolve(__dirname, '../../downloaded-test.txt');
    await download.saveAs(downloadPath);

    const originalContent = fs.readFileSync(testFile, 'utf8');
    const downloadedContent = fs.readFileSync(downloadPath, 'utf8');
    expect(downloadedContent).toBe(originalContent);
    console.log('Downloaded file matches original perfectly!');

    try {
      fs.unlinkSync(downloadPath);
    } catch {}
  });
});
