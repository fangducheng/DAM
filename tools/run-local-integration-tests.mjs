import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), '..');
const rootEnvPath = resolve(repositoryRoot, '.env');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const localDatabaseHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const integrationSuites = [
  {
    name: 'Identity',
    workspace: '@dam/api',
    spec: 'src/identity/identity.integration.spec.ts',
    enableVariable: 'DAM_IDENTITY_INTEGRATION_TESTS',
  },
  {
    name: 'Tenant',
    workspace: '@dam/api',
    spec: 'src/tenant/tenant-management.integration.spec.ts',
    enableVariable: 'DAM_TENANT_INTEGRATION_TESTS',
  },
  {
    name: 'Space',
    workspace: '@dam/api',
    spec: 'src/space/space-authorization.integration.spec.ts',
    enableVariable: 'DAM_SPACE_INTEGRATION_TESTS',
  },
  {
    name: 'Asset',
    workspace: '@dam/api',
    spec: 'src/resource/asset-workflow.integration.spec.ts',
    enableVariable: 'DAM_ASSET_INTEGRATION_TESTS',
  },
  {
    name: 'Discovery',
    workspace: '@dam/api',
    spec: 'src/discovery/discovery.integration.spec.ts',
    enableVariable: 'DAM_DISCOVERY_INTEGRATION_TESTS',
  },
  {
    name: 'Processing',
    workspace: '@dam/worker',
    spec: 'src/processing/processing.integration.spec.ts',
    enableVariable: 'DAM_PROCESSING_INTEGRATION_TESTS',
  },
  {
    name: 'Lifecycle',
    workspace: '@dam/worker',
    spec: 'src/maintenance/lifecycle.integration.spec.ts',
    enableVariable: 'DAM_LIFECYCLE_INTEGRATION_TESTS',
  },
  {
    name: 'Maintenance',
    workspace: '@dam/api',
    spec: 'src/maintenance/storage-reconciliation.integration.spec.ts',
    enableVariable: 'DAM_MAINTENANCE_INTEGRATION_TESTS',
  },
];

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  main();
}

function main() {
  if (!existsSync(rootEnvPath)) {
    console.error(`Missing local environment file: ${rootEnvPath}`);
    process.exitCode = 1;
    return;
  }

  process.loadEnvFile(rootEnvPath);

  let integrationDatabaseUrl;
  let integrationMinioBucket;
  try {
    integrationDatabaseUrl = validateIntegrationDatabaseUrl(process.env);
    integrationMinioBucket = validateIntegrationObjectStorage(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  console.log('\n=== Shared package build ===');
  const buildResult = spawnPnpm(['build:packages'], createMemoryLimitedEnvironment(process.env));
  if (stopAfterFailure(buildResult, 'shared package build')) {
    return;
  }

  runIntegrationSuites(integrationDatabaseUrl, integrationMinioBucket);
}

/**
 * @param {string} integrationDatabaseUrl
 * @param {string} integrationMinioBucket
 */
function runIntegrationSuites(integrationDatabaseUrl, integrationMinioBucket) {
  for (const suite of integrationSuites) {
    console.log(`\n=== ${suite.name} integration ===`);

    const args = [
      '--filter',
      suite.workspace,
      'exec',
      'vitest',
      'run',
      suite.spec,
      '--maxWorkers=1',
      '--no-file-parallelism',
    ];
    const env = createSuiteEnvironment(
      suite.enableVariable,
      integrationDatabaseUrl,
      integrationMinioBucket,
      process.env,
    );
    const result = spawnPnpm(args, env);

    if (stopAfterFailure(result, `${suite.name} integration tests`)) {
      return;
    }
  }

  console.log('\nAll local integration suites passed.');
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {string}
 */
export function validateIntegrationDatabaseUrl(environment) {
  const integrationDatabaseUrl = environment.DAM_INTEGRATION_DATABASE_URL?.trim();
  if (!integrationDatabaseUrl) {
    throw new Error('DAM_INTEGRATION_DATABASE_URL is required for local integration tests.');
  }

  const integrationTarget = parseDatabaseTarget(
    integrationDatabaseUrl,
    'DAM_INTEGRATION_DATABASE_URL',
  );
  if (!localDatabaseHosts.has(integrationTarget.url.hostname)) {
    throw new Error('DAM_INTEGRATION_DATABASE_URL must use localhost, 127.0.0.1, or ::1.');
  }
  if (!/(?:test|integration)/iu.test(integrationTarget.databaseName)) {
    throw new Error(
      'DAM_INTEGRATION_DATABASE_URL database name must contain "test" or "integration".',
    );
  }

  const applicationDatabaseUrl = environment.DATABASE_URL?.trim();
  if (applicationDatabaseUrl) {
    const applicationTarget = parseDatabaseTarget(applicationDatabaseUrl, 'DATABASE_URL');
    if (sameDatabaseTarget(integrationTarget, applicationTarget)) {
      throw new Error(
        'DAM_INTEGRATION_DATABASE_URL must target a database separate from DATABASE_URL.',
      );
    }
  }

  return integrationDatabaseUrl;
}

/**
 * @param {NodeJS.ProcessEnv} environment
 * @returns {string}
 */
export function validateIntegrationObjectStorage(environment) {
  const minioEndpoint = environment.MINIO_ENDPOINT?.trim();
  if (!minioEndpoint) {
    throw new Error('MINIO_ENDPOINT is required for local integration tests.');
  }

  let endpoint;
  try {
    endpoint = new URL(minioEndpoint);
  } catch {
    throw new Error('MINIO_ENDPOINT must be a valid URL.');
  }
  if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') {
    throw new Error('MINIO_ENDPOINT must use the http or https protocol.');
  }
  if (!localDatabaseHosts.has(endpoint.hostname)) {
    throw new Error('MINIO_ENDPOINT must use localhost, 127.0.0.1, or ::1.');
  }

  const integrationBucket = environment.DAM_INTEGRATION_MINIO_BUCKET?.trim();
  if (!integrationBucket) {
    throw new Error('DAM_INTEGRATION_MINIO_BUCKET is required for local integration tests.');
  }
  if (!/(?:test|integration)/iu.test(integrationBucket)) {
    throw new Error('DAM_INTEGRATION_MINIO_BUCKET must contain "test" or "integration".');
  }

  const applicationBucket = environment.MINIO_BUCKET?.trim() || 'dam-assets';
  if (integrationBucket === applicationBucket) {
    throw new Error('DAM_INTEGRATION_MINIO_BUCKET must be different from MINIO_BUCKET.');
  }

  return integrationBucket;
}

/**
 * @param {string} enableVariable
 * @param {string} integrationDatabaseUrl
 * @param {string} integrationMinioBucket
 * @param {NodeJS.ProcessEnv} sourceEnvironment
 * @returns {NodeJS.ProcessEnv}
 */
export function createSuiteEnvironment(
  enableVariable,
  integrationDatabaseUrl,
  integrationMinioBucket,
  sourceEnvironment,
) {
  const env = createMemoryLimitedEnvironment(sourceEnvironment);
  env.DATABASE_URL = integrationDatabaseUrl;
  env.MINIO_BUCKET = integrationMinioBucket;

  for (const suite of integrationSuites) {
    env[suite.enableVariable] = '0';
  }
  env[enableVariable] = '1';

  return env;
}

/**
 * @param {NodeJS.ProcessEnv} sourceEnvironment
 * @returns {NodeJS.ProcessEnv}
 */
function createMemoryLimitedEnvironment(sourceEnvironment) {
  const env = { ...sourceEnvironment };
  env.DAM_LOCAL_INTEGRATION_RUNNER = '1';
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? '';
  const hasOldSpaceLimit = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/u.test(nodeOptions);

  if (!hasOldSpaceLimit) {
    env.NODE_OPTIONS = [nodeOptions, '--max-old-space-size=384'].filter(Boolean).join(' ');
  }

  return env;
}

/**
 * @param {string} value
 * @param {string} variableName
 */
function parseDatabaseTarget(value, variableName) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL URL.`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`${variableName} must use the postgres or postgresql protocol.`);
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error(`${variableName} contains an invalid encoded database name.`);
  }
  if (!databaseName) {
    throw new Error(`${variableName} must include a database name.`);
  }

  return { url, databaseName };
}

/**
 * @param {{ url: URL; databaseName: string }} left
 * @param {{ url: URL; databaseName: string }} right
 */
function sameDatabaseTarget(left, right) {
  return (
    normalizeDatabaseHost(left.url.hostname) === normalizeDatabaseHost(right.url.hostname) &&
    (left.url.port || '5432') === (right.url.port || '5432') &&
    left.databaseName === right.databaseName
  );
}

/** @param {string} hostname */
function normalizeDatabaseHost(hostname) {
  return localDatabaseHosts.has(hostname) ? 'loopback' : hostname;
}

/**
 * @param {import('node:child_process').SpawnSyncReturns<Buffer>} result
 * @param {string} commandName
 */
function stopAfterFailure(result, commandName) {
  if (result.error) {
    console.error(`Unable to start ${commandName}:`, result.error);
    process.exitCode = 1;
    return true;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return true;
  }

  return false;
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
function spawnPnpm(args, env) {
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', pnpmCommand, ...args], {
      cwd: repositoryRoot,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
  }

  return spawnSync(pnpmCommand, args, {
    cwd: repositoryRoot,
    env,
    stdio: 'inherit',
  });
}
