import { defineConfig, devices } from '@playwright/test';
import os from 'os';
import path from 'path';

export default defineConfig({
  testDir: './e2e',
  timeout: 120 * 1000,
  expect: {
    timeout: 20 * 1000,
  },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  outputDir: path.join(os.tmpdir(), 'playwright-e2e-results'),
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
