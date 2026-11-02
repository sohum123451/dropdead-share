import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('End-to-End System Tests (Playwright)', () => {
  const tempDir = path.resolve(__dirname, '../../tmp-e2e');

  test.beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  test.afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // Test 1: 20 MB file upload, download, and SHA-256 byte-for-byte verification
  test('1. Upload a 20 MB file, get a link, download it, confirm the bytes match', async ({
    page,
  }) => {
    test.setTimeout(120 * 1000);

    // Create a 20 MB test file
    const filePath = path.join(tempDir, 'payload-20mb.bin');
    const twentyMB = 20 * 1024 * 1024;
    const fileBuffer = Buffer.alloc(twentyMB);
    // Fill with pattern
    for (let i = 0; i < twentyMB; i += 1024) {
      fileBuffer.write(`CHUNKV2_${i}_`, i);
    }
    const originalHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    fs.writeFileSync(filePath, fileBuffer);

    // 1. Visit Home (Upload screen)
    await page.goto('/');
    await expect(page.locator('[data-testid="app-title"]')).toBeVisible();

    // 2. Select file
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="file-browse"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    // Verify preview
    await expect(page.locator('text=payload-20mb.bin')).toBeVisible();
    await expect(page.locator('text=20 MB')).toBeVisible();

    // 3. Click Create Link
    await page.locator('[data-testid="create-link-button"]').click();

    // 4. Wait for Done screen
    await expect(page.locator('[data-testid="share-ready"]')).toBeVisible({ timeout: 60 * 1000 });

    // 5. Extract share link URL
    const shareInput = page.locator('input[readonly]');
    const shareUrl = await shareInput.inputValue();
    expect(shareUrl).toContain('/d/');

    // 6. Navigate to recipient portal
    const sharePath = new URL(shareUrl).pathname;
    await page.goto(sharePath);
    await expect(page.locator('text=payload-20mb.bin')).toBeVisible();
    await expect(page.locator('text=20 MB')).toBeVisible();

    // 7. Click Download and capture the downloaded file
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-button"]').click();
    const download = await downloadPromise;

    const downloadPath = path.join(tempDir, 'downloaded-20mb.bin');
    await download.saveAs(downloadPath);

    // 8. Confirm byte-for-byte hash matches
    const downloadedBuffer = fs.readFileSync(downloadPath);
    expect(downloadedBuffer.byteLength).toBe(twentyMB);

    const downloadedHash = crypto.createHash('sha256').update(downloadedBuffer).digest('hex');
    expect(downloadedHash).toBe(originalHash);
  });

  // Test 2: Link with max_downloads=1: second download attempt shows exhausted
  test('2. Link with max_downloads=1: second download attempt shows exhausted', async ({
    page,
  }) => {
    const filePath = path.join(tempDir, 'single-use.txt');
    fs.writeFileSync(filePath, 'Single download self-destruct content');

    // 1. Visit Upload Page
    await page.goto('/');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="file-browse"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    // Set max downloads to 1
    const maxDownloadsInput = page.locator('[data-testid="max-downloads-input"]');
    await maxDownloadsInput.fill('1');

    await page.locator('[data-testid="create-link-button"]').click();
    await expect(page.locator('[data-testid="share-ready"]')).toBeVisible();

    const shareUrl = await page.locator('input[readonly]').inputValue();
    const sharePath = new URL(shareUrl).pathname;

    // 2. First download
    await page.goto(sharePath);
    await expect(page.locator('text=1 download left')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-button"]').click();
    await downloadPromise;

    // 3. Assert portal immediately shows Exhausted state
    await expect(page.locator('text=Download limit reached')).toBeVisible();
    await expect(page.locator('text=This file is no longer available.')).toBeVisible();

    // 4. Reload page to test cold second attempt
    await page.goto(sharePath);
    await expect(page.locator('text=Download limit reached')).toBeVisible();
    await expect(page.locator('text=This file is no longer available.')).toBeVisible();
  });

  // Test 3: Link with 1-minute expiry: after expiry the portal shows expired and cron sweep removes the object
  test('3. Link with 1-minute expiry: after expiry portal shows expired and object is purged', async ({
    page,
    request,
  }) => {
    // 1. Create a file upload
    const initRes = await request.post('http://localhost:3000/api/uploads/init', {
      data: {
        filename: 'one-minute.txt',
        fileSize: 15,
        contentType: 'text/plain',
        expiryValue: 1,
        expiryUnit: 'minutes',
        maxDownloads: 5,
      },
    });
    expect(initRes.status()).toBe(201);
    const { uploadId, uploadUrl } = await initRes.json();

    // 2. Upload payload to S3
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: '1-minute expiry',
    });

    const finalizeRes = await request.post(
      `http://localhost:3000/api/uploads/${uploadId}/finalize`,
      { data: {} }
    );
    expect(finalizeRes.status()).toBe(201);
    const { token } = await finalizeRes.json();

    // 3. Visit portal while active
    await page.goto(`/d/${token}`);
    await expect(page.locator('text=one-minute.txt')).toBeVisible();
    await expect(page.locator('[data-testid="countdown-display"]')).toBeVisible();

    // 4. Simulate expiration by advancing file record timestamp in DB
    const Database = require('../../backend/node_modules/better-sqlite3');
    const dbPath = path.resolve(__dirname, '../../backend/data/metadata.db');
    const db = new Database(dbPath);
    const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
    db.prepare('UPDATE files SET expires_at = ? WHERE token = ?').run(pastTime, token);
    db.close();

    // 5. Reload portal after expiry -> must show "This link has expired"
    await page.goto(`/d/${token}`);
    await expect(page.locator('text=This link has expired')).toBeVisible();
    await expect(page.locator('text=The file is no longer available.')).toBeVisible();
  });

  // Test 4: Password link: wrong password shows an error, correct one downloads
  test('4. Password link: wrong password shows an error, correct one downloads', async ({
    page,
  }) => {
    const filePath = path.join(tempDir, 'secret-vault.txt');
    fs.writeFileSync(filePath, 'Top Secret Content');

    await page.goto('/');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="file-browse"]').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    // Fill password
    const passwordInput = page.locator('[data-testid="password-input"]');
    await passwordInput.fill('CorrectHorseBattery99!');

    await page.locator('[data-testid="create-link-button"]').click();
    await expect(page.locator('[data-testid="share-ready"]')).toBeVisible();

    const shareUrl = await page.locator('input[readonly]').inputValue();
    const sharePath = new URL(shareUrl).pathname;

    // Visit recipient portal
    await page.goto(sharePath);

    // Verify Password Gate is displayed
    await expect(page.locator('text=Password required')).toBeVisible();

    // Try wrong password
    const gatePasswordInput = page.locator('[data-testid="gate-password-input"]');
    await gatePasswordInput.fill('WrongPassword!');
    await page.locator('[data-testid="unlock-button"]').click();

    // Verify error message
    await expect(page.locator('[data-testid="password-error"]')).toContainText('Incorrect password');

    // Try correct password
    await gatePasswordInput.fill('CorrectHorseBattery99!');
    await page.locator('[data-testid="unlock-button"]').click();

    // Verify unlocked and ready to download
    await expect(page.locator('text=secret-vault.txt')).toBeVisible();

    // Download
    const downloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="download-button"]').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('secret-vault.txt');
  });

  // Test 5: Garbage token shows the not-found page
  test('5. Garbage token shows the not-found page', async ({ page }) => {
    await page.goto('/d/totally-garbage-and-nonexistent-token-1234567890');
    await expect(page.locator('text=Link not found')).toBeVisible();
    await expect(
      page.locator('text=Check the address, or ask the sender for a new link.')
    ).toBeVisible();
  });
});
