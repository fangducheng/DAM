import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

/**
 * @typedef {{
 *   status: string;
 *   purgeRequestedAt: string | null;
 *   [key: string]: unknown;
 * }} RecycleDeletionBatch
 * @typedef {{
 *   id: string;
 *   name: string;
 *   status: string;
 *   lockVersion: number;
 *   deletionBatch: RecycleDeletionBatch;
 *   [key: string]: unknown;
 * }} RecycleNode
 * @typedef {{ items: RecycleNode[]; [key: string]: unknown }} RecyclePage
 * @typedef {{ status: string; purgeRequestedAt: string }} PurgeResponse
 */

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
/** @type {Array<{ status: number; url: string }>} */
const expectedFailedResponses = [];
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
  if ((await tagDialog.getByRole('checkbox', { name: /验收标签/ }).count()) === 0) {
    await tagDialog.getByPlaceholder('新标签名称').fill('验收标签');
    await tagDialog.getByRole('button', { name: '新建', exact: true }).click();
  }
  await tagDialog.getByRole('checkbox', { name: /验收标签/ }).check();
  await tagDialog.getByRole('button', { name: '保存标签' }).click();
  await tagDialog.waitFor({ state: 'detached' });

  await page.getByPlaceholder('搜索文件名或文档内容').fill(uploadFixtureName.slice(0, 18));
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('button', { name: uploadFixtureName }).waitFor();
  const desktopSearch = join(outputDirectory, 'asset-search-desktop.png');
  await page.screenshot({ path: desktopSearch, fullPage: true });
  const desktopSearchOverflow = await hasPageOverflow(page);

  const searchedAssetRow = page.getByRole('button', { name: uploadFixtureName }).locator('..');
  await searchedAssetRow.getByTitle('移入回收站').click();
  await page.getByRole('dialog').getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  const recycleResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === 'GET' &&
      url.pathname.includes('/api/v1/spaces/') &&
      url.pathname.endsWith('/recycle-bin')
    );
  });
  await page.getByRole('tab', { name: '回收站' }).click();
  /** @type {unknown} */
  const recyclePageBody = await recycleResponsePromise.then((response) => response.json());
  if (!isRecyclePage(recyclePageBody)) throw new Error('Recycle API returned an invalid payload');
  const recyclePage = recyclePageBody;
  await waitForView(page);
  await page.getByText(/剩余 30 天/).waitFor();
  const desktopRecycleBin = join(outputDirectory, 'recycle-bin-desktop.png');
  await page.screenshot({ path: desktopRecycleBin, fullPage: true });
  const desktopRecycleBinOverflow = await hasPageOverflow(page);
  const recycledRow = page
    .locator('.recycle-table .asset-row:not(.asset-row-header)')
    .filter({ has: page.getByText(uploadFixtureName, { exact: true }) })
    .first();
  const recycledNode = recyclePage.items.find((item) => item.name === uploadFixtureName);
  if (recycledNode === undefined)
    throw new Error('Uploaded asset was absent from recycle API data');

  let purgeRequests = 0;
  /** @type {PurgeResponse | null} */
  let purgeResponseBody = null;
  /** @type {RecyclePage | null} */
  let stableRecyclePage = null;
  const recycleRoutePattern = '**/api/v1/spaces/*/recycle-bin?*';
  const purgeRoutePattern = `**/api/v1/resource-nodes/${recycledNode.id}/purge`;
  /** @param {import('playwright-core').Route} route */
  const recycleRouteHandler = async (route) => {
    if (stableRecyclePage === null) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(stableRecyclePage),
    });
  };
  /** @param {import('playwright-core').Route} route */
  const purgeRouteHandler = async (route) => {
    purgeRequests += 1;
    const response = await route.fetch();
    const body = await response.text();
    /** @type {unknown} */
    const responseBody = JSON.parse(body);
    if (!isPurgeResponse(responseBody)) throw new Error('Permanent delete API payload was invalid');
    purgeResponseBody = responseBody;
    if (response.ok() && purgeResponseBody.status === 'PURGE_REQUESTED') {
      stableRecyclePage = {
        ...recyclePage,
        items: recyclePage.items.map((item) =>
          item.id === recycledNode.id
            ? {
                ...item,
                status: 'PURGING',
                lockVersion: item.lockVersion + 1,
                deletionBatch: {
                  ...item.deletionBatch,
                  status: 'PURGE_REQUESTED',
                  purgeRequestedAt: purgeResponseBody.purgeRequestedAt,
                },
              }
            : item,
        ),
      };
    }
    await route.fulfill({ response, body });
  };
  await page.route(recycleRoutePattern, recycleRouteHandler);
  await page.route(purgeRoutePattern, purgeRouteHandler);

  await recycledRow.getByTitle('永久删除').click();
  const purgeDialog = page.getByRole('dialog');
  const purgeButton = purgeDialog.getByRole('button', { name: '永久删除', exact: true });
  if (!(await purgeButton.isDisabled())) throw new Error('Permanent delete was enabled too early');
  await purgeDialog.getByLabel(/输入/).fill(uploadFixtureName);
  if (await purgeButton.isDisabled()) throw new Error('Permanent delete did not accept exact name');
  const desktopPurgeConfirmation = join(outputDirectory, 'purge-confirmation-desktop.png');
  await page.screenshot({ path: desktopPurgeConfirmation, fullPage: true });
  await purgeButton.click();
  await purgeDialog.waitFor({ state: 'detached' });
  await waitForView(page);
  if (purgeRequests !== 1) throw new Error('Permanent delete request was not sent exactly once');
  if (purgeResponseBody?.status !== 'PURGE_REQUESTED') {
    throw new Error('Permanent delete API did not return PURGE_REQUESTED');
  }
  const purgeWaitingRow = recycledRow;
  await purgeWaitingRow.getByText('等待永久删除', { exact: true }).first().waitFor();
  if ((await purgeWaitingRow.getByRole('button', { name: '恢复', exact: true }).count()) !== 0) {
    throw new Error('Restore remained available after permanent delete was requested');
  }
  if ((await purgeWaitingRow.getByTitle('永久删除').count()) !== 0) {
    throw new Error('Permanent delete remained available after the request was submitted');
  }
  await page.getByTitle('刷新').click();
  await waitForView(page);
  await recycledRow.getByText('等待永久删除', { exact: true }).first().waitFor();
  const desktopPurgeWaiting = join(outputDirectory, 'purge-waiting-desktop.png');
  await page.screenshot({ path: desktopPurgeWaiting, fullPage: true });

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

  await page.getByRole('link', { name: '维护任务' }).click();
  await page.waitForURL('**/maintenance');
  await waitForView(page);
  const desktopMaintenance = join(outputDirectory, 'maintenance-desktop.png');
  await page.screenshot({ path: desktopMaintenance, fullPage: true });
  const desktopMaintenanceOverflow = await hasPageOverflow(page);
  await verifyLoadFailureRecovery(page, expectedFailedResponses, {
    routePattern: '**/api/v1/maintenance/summary',
    message: '维护任务暂时无法加载，请检查网络后重试',
    trigger: () => page.reload({ waitUntil: 'domcontentloaded' }),
  });
  const desktopMaintenanceRetry = await verifyMaintenanceInteractions(page, outputDirectory);
  await verifyMaintenanceVisibility(page, baseUrl);

  await page.getByRole('link', { name: '资产库' }).click();
  await page.waitForURL('**/assets');
  await waitForView(page);
  await verifyLoadFailureRecovery(page, expectedFailedResponses, {
    routePattern: '**/api/v1/spaces/*/nodes?*',
    message: '资产列表暂时无法加载，请检查网络后重试',
    trigger: () => page.getByRole('tab', { name: '文件' }).click(),
  });
  await verifyLoadFailureRecovery(page, expectedFailedResponses, {
    routePattern: recycleRoutePattern,
    message: '回收站暂时无法加载，请检查网络后重试',
    trigger: () => page.getByRole('tab', { name: '回收站' }).click(),
  });
  await page.getByRole('tab', { name: '文件' }).click();
  await waitForView(page);
  while ((await page.getByTitle('关闭消息').count()) > 0) {
    await page.getByTitle('关闭消息').first().click();
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  await page.getByRole('tab', { name: '回收站' }).click();
  await waitForView(page);
  await page.getByText(uploadFixtureName, { exact: true }).waitFor();
  await page.getByText('等待永久删除', { exact: true }).first().waitFor();
  const mobileRecycleBin = join(outputDirectory, 'recycle-bin-mobile.png');
  await page.screenshot({ path: mobileRecycleBin, fullPage: true });
  const mobileRecycleBinOverflow = await hasPageOverflow(page);
  await page.unroute(recycleRoutePattern, recycleRouteHandler);
  await page.unroute(purgeRoutePattern, purgeRouteHandler);
  await page.getByRole('tab', { name: '文件' }).click();
  await waitForView(page);
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

  await page.getByRole('link', { name: '维护任务' }).click();
  await page.waitForURL('**/maintenance');
  await waitForView(page);
  const mobileMaintenance = join(outputDirectory, 'maintenance-mobile.png');
  await page.screenshot({ path: mobileMaintenance, fullPage: true });
  const mobileMaintenanceOverflow = await hasPageOverflow(page);

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
      desktopRecycleBin,
      desktopPurgeConfirmation,
      desktopPurgeWaiting,
      desktopNotifications,
      desktopAudit,
      desktopMaintenance,
      desktopMaintenanceRetry,
      mobileRecycleBin,
      mobileAssets,
      mobileNotifications,
      mobileAudit,
      mobileMaintenance,
      mobilePermissions,
    },
    overflow: {
      desktopStatus: desktopStatusOverflow,
      desktopOrganizations: desktopOrganizationsOverflow,
      desktopSpaces: desktopSpacesOverflow,
      desktopAssets: desktopAssetsOverflow,
      desktopSearch: desktopSearchOverflow,
      desktopRecycleBin: desktopRecycleBinOverflow,
      desktopNotifications: desktopNotificationsOverflow,
      desktopAudit: desktopAuditOverflow,
      desktopMaintenance: desktopMaintenanceOverflow,
      mobileRecycleBin: mobileRecycleBinOverflow,
      mobileAssets: mobileAssetsOverflow,
      mobileNotifications: mobileNotificationsOverflow,
      mobileAudit: mobileAuditOverflow,
      mobileMaintenance: mobileMaintenanceOverflow,
      mobilePermissions: mobilePermissionsOverflow,
    },
    consoleErrors,
    unexpectedResponses: withoutExpectedResponses(failedResponses, expectedFailedResponses).filter(
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

/** @param {unknown} value @returns {value is RecyclePage} */
function isRecyclePage(value) {
  return isRecord(value) && Array.isArray(value.items) && value.items.every(isRecycleNode);
}

/** @param {unknown} value @returns {value is RecycleNode} */
function isRecycleNode(value) {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.status === 'string' &&
    typeof value.lockVersion === 'number' &&
    isRecycleDeletionBatch(value.deletionBatch)
  );
}

/** @param {unknown} value @returns {value is RecycleDeletionBatch} */
function isRecycleDeletionBatch(value) {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    (typeof value.purgeRequestedAt === 'string' || value.purgeRequestedAt === null)
  );
}

/** @param {unknown} value @returns {value is PurgeResponse} */
function isPurgeResponse(value) {
  return (
    isRecord(value) &&
    typeof value.status === 'string' &&
    typeof value.purgeRequestedAt === 'string'
  );
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
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

/**
 * @param {import('playwright-core').Page} page
 * @param {Array<{ status: number; url: string }>} expectedFailures
 * @param {{ routePattern: string; message: string; trigger: () => Promise<unknown> }} options
 */
async function verifyLoadFailureRecovery(page, expectedFailures, options) {
  let requests = 0;
  /** @param {import('playwright-core').Route} route */
  const routeHandler = async (route) => {
    requests += 1;
    if (requests === 1) {
      const url = route.request().url();
      expectedFailures.push({ status: 503, url });
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 'INTERNAL_ERROR',
          message: '界面验收模拟加载失败',
          requestId: 'ui-expected-load-failure',
        }),
      });
      return;
    }
    await route.fallback();
  };
  await page.route(options.routePattern, routeHandler);

  try {
    await options.trigger();
    const errorState = page.locator('.error-state[role="alert"]');
    await errorState.getByText(options.message, { exact: true }).waitFor();
    await errorState.getByRole('button', { name: '重新加载', exact: true }).click();
    await waitForView(page);
    await errorState.waitFor({ state: 'detached' });
    if (requests < 2) throw new Error(`Reload was not requested for ${options.routePattern}`);
  } finally {
    await page.unroute(options.routePattern, routeHandler);
  }
}

/**
 * @param {Array<{ status: number; url: string }>} actual
 * @param {Array<{ status: number; url: string }>} expected
 */
function withoutExpectedResponses(actual, expected) {
  /** @type {Map<string, number>} */
  const remaining = new Map();
  for (const response of expected) {
    const key = `${response.status}:${response.url}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  return actual.filter((response) => {
    const key = `${response.status}:${response.url}`;
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

/**
 * Verifies maintenance filtering and retry UI without relying on a failed job in local data.
 * @param {import('playwright-core').Page} page
 * @param {string} outputDirectory
 */
async function verifyMaintenanceInteractions(page, outputDirectory) {
  const routePattern = '**/api/v1/maintenance/**';
  const jobId = '00000000-0000-4000-8000-000000000001';
  const now = new Date().toISOString();
  let filteredRequestObserved = false;
  let retryRequests = 0;

  await page.route(routePattern, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/maintenance/summary')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          jobs: { DEAD: retryRequests === 0 ? 1 : 0 },
          deletionBatches: {},
          nextDueAt: null,
        }),
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/maintenance/jobs')) {
      const status = url.searchParams.get('status');
      const jobType = url.searchParams.get('jobType');
      filteredRequestObserved ||= status === 'DEAD' && jobType === 'PURGE_DELETION_BATCH';
      const matchesFilters =
        (status === null || status === 'DEAD') &&
        (jobType === null || jobType === 'PURGE_DELETION_BATCH');
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items:
            retryRequests === 0 && matchesFilters
              ? [
                  {
                    id: jobId,
                    spaceId: null,
                    jobType: 'PURGE_DELETION_BATCH',
                    status: 'DEAD',
                    attempts: 5,
                    maxAttempts: 5,
                    availableAt: now,
                    leaseExpiresAt: null,
                    completedAt: now,
                    errorMessage: '界面验收模拟失败',
                    createdAt: now,
                    updatedAt: now,
                  },
                ]
              : [],
          nextCursor: null,
        }),
      });
      return;
    }
    if (request.method() === 'POST' && url.pathname.endsWith(`/maintenance/jobs/${jobId}/retry`)) {
      retryRequests += 1;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ id: jobId, status: 'PENDING' }),
      });
      return;
    }
    await route.continue();
  });

  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForView(page);
    await page.getByLabel('状态').selectOption('DEAD');
    await page.getByLabel('任务类型').selectOption('PURGE_DELETION_BATCH');
    await page.getByRole('button', { name: '筛选', exact: true }).click();
    await waitForView(page);
    if (!filteredRequestObserved) throw new Error('Maintenance filters were not sent to the API');

    await page.getByRole('button', { name: '重试', exact: true }).click();
    const retryDialog = page.getByRole('dialog');
    await retryDialog.getByText('永久删除资源', { exact: true }).waitFor();
    const screenshot = join(outputDirectory, 'maintenance-retry-desktop.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    await retryDialog.getByRole('button', { name: '确认重试', exact: true }).click();
    await retryDialog.waitFor({ state: 'detached' });
    await waitForView(page);
    if (retryRequests !== 1) throw new Error('Maintenance retry request was not sent exactly once');
    return screenshot;
  } finally {
    await page.unroute(routePattern);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForView(page);
  }
}

/**
 * @param {import('playwright-core').Page} page
 * @param {string} baseUrl
 */
async function verifyMaintenanceVisibility(page, baseUrl) {
  const capabilitiesRoutePattern = '**/api/v1/identity/capabilities';
  const maintenanceRoutePattern = '**/api/v1/maintenance/**';
  const jobId = '00000000-0000-4000-8000-000000000002';
  const now = new Date().toISOString();
  let permissions = ['maintenance.read'];
  /** @param {import('playwright-core').Route} route */
  const capabilitiesRouteHandler = (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ authorizationVersion: 'ui-maintenance-visibility', permissions }),
    });
  /** @param {import('playwright-core').Route} route */
  const maintenanceRouteHandler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname.endsWith('/maintenance/summary')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ jobs: { DEAD: 1 }, deletionBatches: {}, nextDueAt: null }),
      });
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/maintenance/jobs')) {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: jobId,
              spaceId: null,
              jobType: 'PURGE_DELETION_BATCH',
              status: 'DEAD',
              attempts: 5,
              maxAttempts: 5,
              availableAt: now,
              leaseExpiresAt: null,
              completedAt: now,
              errorMessage: '界面验收只读任务',
              createdAt: now,
              updatedAt: now,
            },
          ],
          nextCursor: null,
        }),
      });
      return;
    }
    await route.fallback();
  };
  await page.route(capabilitiesRoutePattern, capabilitiesRouteHandler);
  await page.route(maintenanceRoutePattern, maintenanceRouteHandler);

  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/maintenance');
    await waitForView(page);
    await page.getByText('界面验收只读任务', { exact: true }).waitFor();
    if ((await page.getByRole('link', { name: '维护任务' }).count()) !== 1) {
      throw new Error('Maintenance navigation was hidden with maintenance.read');
    }
    if ((await page.getByRole('button', { name: '重试', exact: true }).count()) !== 0) {
      throw new Error('Maintenance retry was visible without maintenance.manage');
    }

    permissions = [];
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/status');
    if ((await page.getByRole('link', { name: '维护任务' }).count()) !== 0) {
      throw new Error('Maintenance navigation remained visible without maintenance.read');
    }
    await page.goto(`${baseUrl}/maintenance`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/status');
  } finally {
    await page.unroute(maintenanceRoutePattern, maintenanceRouteHandler);
    await page.unroute(capabilitiesRoutePattern, capabilitiesRouteHandler);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForView(page);
  }
}
