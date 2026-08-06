import { mkdir, unlink, writeFile } from 'node:fs/promises';
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
const uploadFixtureName = `asset-upload-verification-${Date.now().toString(36)}.pdf`;
const uploadFixture = join(outputDirectory, uploadFixtureName);
await writeFile(uploadFixture, Buffer.alloc(9 * 1024 * 1024, 0x41));

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

  await page.getByRole('link', { name: '资产库' }).click();
  await page.waitForURL('**/assets');
  await waitForView(page);
  if (!(await page.getByRole('button', { name: /验收资料/ }).isVisible())) {
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.getByLabel('文件夹名称').fill('验收资料');
    await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  }
  await page.getByRole('button', { name: /验收资料/ }).click();
  await waitForView(page);
  await page.locator('input[type="file"]').setInputFiles(uploadFixture);
  await page.getByRole('button', { name: uploadFixtureName }).waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  const desktopAssets = join(outputDirectory, 'assets-desktop.png');
  await page.screenshot({ path: desktopAssets, fullPage: true });
  const desktopAssetsOverflow = await hasPageOverflow(page);
  await page
    .getByRole('button', { name: uploadFixtureName })
    .locator('..')
    .getByTitle('版本历史')
    .click();
  await page.getByRole('dialog').waitFor({ state: 'visible' });
  await page.getByRole('dialog').getByText('V1', { exact: true }).waitFor();
  const desktopVersions = join(outputDirectory, 'asset-versions-desktop.png');
  await page.screenshot({ path: desktopVersions, fullPage: true });
  await page.getByRole('dialog').getByTitle('关闭').click();

  const assetRow = page.getByRole('button', { name: uploadFixtureName }).locator('..');
  await assetRow.getByTitle('资产标签').click();
  const tagDialog = page.getByRole('dialog');
  await tagDialog.getByPlaceholder('新标签名称').fill('验收标签');
  await tagDialog.getByRole('button', { name: '新建', exact: true }).click();
  await tagDialog.getByRole('checkbox', { name: /验收标签/ }).check();
  await tagDialog.getByRole('button', { name: '保存标签' }).click();
  await tagDialog.waitFor({ state: 'detached' });

  await page.getByPlaceholder('搜索文件名或文档内容').fill(uploadFixtureName.slice(0, 18));
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: uploadFixtureName }).waitFor();
  const desktopSearch = join(outputDirectory, 'asset-search-desktop.png');
  await page.screenshot({ path: desktopSearch, fullPage: true });
  const desktopSearchOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '通知', exact: true }).click();
  await page.waitForURL('**/notifications');
  await waitForView(page);
  const desktopNotifications = join(outputDirectory, 'notifications-desktop.png');
  await page.screenshot({ path: desktopNotifications, fullPage: true });
  const desktopNotificationsOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '审计日志' }).click();
  await page.waitForURL('**/audit');
  await waitForView(page);
  const desktopAudit = join(outputDirectory, 'audit-desktop.png');
  await page.screenshot({ path: desktopAudit, fullPage: true });
  const desktopAuditOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '资产库' }).click();
  await page.waitForURL('**/assets');
  await waitForView(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const mobileAssets = join(outputDirectory, 'assets-mobile.png');
  await page.screenshot({ path: mobileAssets, fullPage: true });
  const mobileAssetsOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '通知', exact: true }).click();
  await page.waitForURL('**/notifications');
  await waitForView(page);
  const mobileNotifications = join(outputDirectory, 'notifications-mobile.png');
  await page.screenshot({ path: mobileNotifications, fullPage: true });
  const mobileNotificationsOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '审计日志' }).click();
  await page.waitForURL('**/audit');
  await waitForView(page);
  const mobileAudit = join(outputDirectory, 'audit-mobile.png');
  await page.screenshot({ path: mobileAudit, fullPage: true });
  const mobileAuditOverflow = await hasPageOverflow(page);

  await page.getByRole('link', { name: '目录权限' }).click();
  await page.waitForURL('**/permissions');
  const mobilePermissions = join(outputDirectory, 'permissions-mobile.png');
  await page.screenshot({ path: mobilePermissions, fullPage: true });
  const mobilePermissionsOverflow = await hasPageOverflow(page);

  const result = {
    screenshots: {
      desktopStatus,
      desktopOrganizations,
      desktopSpaces,
      desktopAssets,
      desktopVersions,
      desktopSearch,
      desktopNotifications,
      desktopAudit,
      mobileAssets,
      mobileNotifications,
      mobileAudit,
      mobilePermissions,
    },
    overflow: {
      desktopStatus: desktopStatusOverflow,
      desktopOrganizations: desktopOrganizationsOverflow,
      desktopSpaces: desktopSpacesOverflow,
      desktopAssets: desktopAssetsOverflow,
      desktopSearch: desktopSearchOverflow,
      desktopNotifications: desktopNotificationsOverflow,
      desktopAudit: desktopAuditOverflow,
      mobileAssets: mobileAssetsOverflow,
      mobileNotifications: mobileNotificationsOverflow,
      mobileAudit: mobileAuditOverflow,
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
  await unlink(uploadFixture).catch(() => undefined);
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
