import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createSuiteEnvironment,
  integrationSuites,
  validateIntegrationDatabaseUrl,
  validateIntegrationObjectStorage,
} from './run-local-integration-tests.mjs';

const applicationDatabaseUrl = 'postgresql://dam:password@localhost:5433/dam?schema=public';
const integrationDatabaseUrl =
  'postgresql://dam:password@localhost:5433/dam_integration?schema=public';
const applicationMinioBucket = 'dam-assets';
const integrationMinioBucket = 'dam-assets-integration';
const repositoryRoot = resolve(import.meta.dirname, '..');
const workspaceDirectories = new Map([
  ['@dam/api', 'apps/api'],
  ['@dam/worker', 'apps/worker'],
]);

await test('accepts an isolated loopback integration database', () => {
  assert.equal(
    validateIntegrationDatabaseUrl({
      DATABASE_URL: applicationDatabaseUrl,
      DAM_INTEGRATION_DATABASE_URL: integrationDatabaseUrl,
    }),
    integrationDatabaseUrl,
  );
});

await test('rejects missing, remote, and unsafe integration database targets', () => {
  assert.throws(
    () => validateIntegrationDatabaseUrl({ DATABASE_URL: applicationDatabaseUrl }),
    /DAM_INTEGRATION_DATABASE_URL is required/u,
  );
  assert.throws(
    () =>
      validateIntegrationDatabaseUrl({
        DATABASE_URL: applicationDatabaseUrl,
        DAM_INTEGRATION_DATABASE_URL: 'postgresql://dam:password@db.example.test:5432/dam_test',
      }),
    /must use localhost/u,
  );
  assert.throws(
    () =>
      validateIntegrationDatabaseUrl({
        DATABASE_URL: applicationDatabaseUrl,
        DAM_INTEGRATION_DATABASE_URL: 'postgresql://dam:password@127.0.0.1:5433/dam',
      }),
    /database name must contain/u,
  );
});

await test('rejects the application database even through another loopback alias', () => {
  assert.throws(
    () =>
      validateIntegrationDatabaseUrl({
        DATABASE_URL: 'postgresql://dam:password@localhost:5433/dam_test?schema=public',
        DAM_INTEGRATION_DATABASE_URL:
          'postgresql://other:password@127.0.0.1:5433/dam_test?schema=integration',
      }),
    /database separate from DATABASE_URL/u,
  );
});

await test('accepts isolated loopback object storage', () => {
  assert.equal(
    validateIntegrationObjectStorage({
      MINIO_ENDPOINT: 'http://127.0.0.1:9000',
      MINIO_BUCKET: applicationMinioBucket,
      DAM_INTEGRATION_MINIO_BUCKET: integrationMinioBucket,
    }),
    integrationMinioBucket,
  );
});

await test('rejects remote, missing, unsafe, and shared object storage', () => {
  assert.throws(
    () =>
      validateIntegrationObjectStorage({
        MINIO_ENDPOINT: 'https://minio.example.test',
        DAM_INTEGRATION_MINIO_BUCKET: integrationMinioBucket,
      }),
    /MINIO_ENDPOINT must use localhost/u,
  );
  assert.throws(
    () => validateIntegrationObjectStorage({ MINIO_ENDPOINT: 'http://localhost:9000' }),
    /DAM_INTEGRATION_MINIO_BUCKET is required/u,
  );
  assert.throws(
    () =>
      validateIntegrationObjectStorage({
        MINIO_ENDPOINT: 'http://localhost:9000',
        DAM_INTEGRATION_MINIO_BUCKET: 'dam-assets-isolated',
      }),
    /must contain/u,
  );
  assert.throws(
    () =>
      validateIntegrationObjectStorage({
        MINIO_ENDPOINT: 'http://localhost:9000',
        MINIO_BUCKET: integrationMinioBucket,
        DAM_INTEGRATION_MINIO_BUCKET: integrationMinioBucket,
      }),
    /must be different from MINIO_BUCKET/u,
  );
});

await test('forces the dedicated database, isolates suite flags, and adds the memory limit', () => {
  const environment = createSuiteEnvironment(
    'DAM_IDENTITY_INTEGRATION_TESTS',
    integrationDatabaseUrl,
    integrationMinioBucket,
    {
      DATABASE_URL: applicationDatabaseUrl,
      MINIO_BUCKET: applicationMinioBucket,
      NODE_OPTIONS: '--trace-warnings',
      DAM_TENANT_INTEGRATION_TESTS: '1',
    },
  );

  assert.equal(environment.DATABASE_URL, integrationDatabaseUrl);
  assert.equal(environment.MINIO_BUCKET, integrationMinioBucket);
  assert.equal(environment.DAM_LOCAL_INTEGRATION_RUNNER, '1');
  assert.equal(environment.DAM_IDENTITY_INTEGRATION_TESTS, '1');
  assert.equal(environment.DAM_TENANT_INTEGRATION_TESTS, '0');
  assert.equal(environment.DAM_PROCESSING_INTEGRATION_TESTS, '0');
  assert.equal(environment.NODE_OPTIONS, '--trace-warnings --max-old-space-size=384');
});

await test('keeps the complete integration suite plan in strict runner order', () => {
  assert.deepEqual(
    integrationSuites.map((suite) => suite.name),
    ['Identity', 'Tenant', 'Space', 'Asset', 'Discovery', 'Processing', 'Lifecycle', 'Maintenance'],
  );
});

await test('covers every integration spec and requires the runner guard', async () => {
  const discoveredSpecs = [];
  for (const [workspace, workspaceDirectory] of workspaceDirectories) {
    const sourceDirectory = resolve(repositoryRoot, workspaceDirectory, 'src');
    const files = await readdir(sourceDirectory, { recursive: true });
    for (const file of files) {
      const normalizedFile = file.replaceAll('\\', '/');
      if (normalizedFile.endsWith('.integration.spec.ts')) {
        discoveredSpecs.push(`${workspace}:src/${normalizedFile}`);
      }
    }
  }

  const plannedSpecs = integrationSuites.map((suite) => `${suite.workspace}:${suite.spec}`);
  assert.deepEqual(plannedSpecs.toSorted(), discoveredSpecs.toSorted());

  await Promise.all(
    integrationSuites.map(async (suite) => {
      const workspaceDirectory = workspaceDirectories.get(suite.workspace);
      assert.ok(workspaceDirectory, `Unknown workspace ${suite.workspace}`);
      const source = await readFile(
        resolve(repositoryRoot, workspaceDirectory, suite.spec),
        'utf8',
      );
      assert.match(
        source,
        /assertLocalIntegrationRunner\(integrationEnabled\);/u,
        `${suite.name} must invoke the local integration runner guard`,
      );
    }),
  );
});

await test('preserves a caller-defined old-space limit', () => {
  const environment = createSuiteEnvironment(
    'DAM_LIFECYCLE_INTEGRATION_TESTS',
    integrationDatabaseUrl,
    integrationMinioBucket,
    { NODE_OPTIONS: '--max-old-space-size=512' },
  );

  assert.equal(environment.NODE_OPTIONS, '--max-old-space-size=512');
});
