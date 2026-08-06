import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const baseUrl = process.env.UI_BASE_URL ?? 'http://127.0.0.1:5173';
const tenantCode = required('UI_TENANT_CODE');
const identifier = required('UI_IDENTIFIER');
const password = required('UI_PASSWORD');
const mfaCode = required('UI_MFA_CODE');
const executablePath =
  process.env.UI_BROWSER_PATH ??
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const outputDirectory = join(tmpdir(), 'dam-ui-verification');
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
/** @type {string[]} */
const consoleErrors = [];
/** @type {Array<{ status: number; url: string }>} */
const failedResponses = [];
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
    consoleErrors.push(message.text());
  }
});
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('response', (response) => {
  if (response.status() >= 400) {
    failedResponses.push({ status: response.status(), url: response.url() });
  }
});

try {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[name="tenantCode"]').fill(tenantCode);
  await page.locator('input[name="identifier"]').fill(identifier);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL('**/mfa');
  await page.locator('input[autocomplete="one-time-code"]').fill(mfaCode);
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await page.waitForURL('**/status');
  await page.waitForLoadState('networkidle');

  const desktopStatus = join(outputDirectory, 'status-desktop.png');
  await page.screenshot({ path: desktopStatus, fullPage: true });
  const desktopStatusOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '组织与成员' }).click();
  await page.waitForURL('**/organizations');
  await waitForView(page);
  const desktopOrganizations = join(outputDirectory, 'organizations-desktop.png');
  await page.screenshot({ path: desktopOrganizations, fullPage: true });
  const desktopOrganizationsOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '业务空间' }).click();
  await page.waitForURL('**/spaces');
  await waitForView(page);
  if (await page.getByText('暂无空间').isVisible()) {
    await page.getByRole('button', { name: '新建空间' }).click();
    const suffix = Date.now().toString(36);
    await page.getByLabel('空间代码').fill(`ui-shared-${suffix}`);
    await page.getByLabel('空间名称').fill('界面验证共享空间');
    await page.getByLabel('配额（GB）').fill('5');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await waitForView(page);
  }
  const desktopSpaces = join(outputDirectory, 'spaces-desktop.png');
  await page.screenshot({ path: desktopSpaces, fullPage: true });
  const desktopSpacesOverflow = await hasPageOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const mobileSpaces = join(outputDirectory, 'spaces-mobile.png');
  await page.screenshot({ path: mobileSpaces, fullPage: true });
  const mobileSpacesOverflow = await hasPageOverflow(page);

  await page.getByTitle('目录权限').click();
  await page.waitForURL('**/permissions');
  const mobilePermissions = join(outputDirectory, 'permissions-mobile.png');
  await page.screenshot({ path: mobilePermissions, fullPage: true });
  const mobilePermissionsOverflow = await hasPageOverflow(page);

  const result = {
    screenshots: {
      desktopStatus,
      desktopOrganizations,
      desktopSpaces,
      mobileSpaces,
      mobilePermissions,
    },
    overflow: {
      desktopStatus: desktopStatusOverflow,
      desktopOrganizations: desktopOrganizationsOverflow,
      desktopSpaces: desktopSpacesOverflow,
      mobileSpaces: mobileSpacesOverflow,
      mobilePermissions: mobilePermissionsOverflow,
    },
    consoleErrors,
    unexpectedResponses: failedResponses.filter(
      ({ status, url }) =>
        !(status === 401 && url.endsWith('/api/v1/identity/refresh')) &&
        !(status === 404 && url.endsWith('/favicon.ico')),
    ),
  };
  console.log(JSON.stringify(result, null, 2));
  if (
    Object.values(result.overflow).some(Boolean) ||
    consoleErrors.length > 0 ||
    result.unexpectedResponses.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await context.close();
  await browser.close();
}

/**
 * @param {string} name
 * @returns {string}
 */
function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** @param {import('playwright-core').Page} page */
function hasPageOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
}

/** @param {import('playwright-core').Page} page */
async function waitForView(page) {
  await page.waitForFunction(() => document.querySelector('.loading-state') === null);
  await page.waitForTimeout(100);
}
