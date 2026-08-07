import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import type { AuthenticatedUser } from '@dam/contracts';

import type { AuthorizationService } from '../authorization/authorization.service.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import { assertLocalIntegrationRunner } from '../testing/integration-test.guard.js';
import { AuditService } from './audit.service.js';
import { NotificationService } from './notification.service.js';
import { SearchService } from './search.service.js';
import { TagService } from './tag.service.js';

const integrationEnabled = process.env['DAM_DISCOVERY_INTEGRATION_TESTS'] === '1';
assertLocalIntegrationRunner(integrationEnabled);
const integration = integrationEnabled ? describe : describe.skip;

integration('tags, search, audit, and notifications', () => {
  const prisma = new PrismaService();
  let deniedNodeId = '';
  const authorization = {
    canEnterSpace: () => Promise.resolve(true),
    assert: () => Promise.resolve({ allowed: true }),
    can: (_actor: AuthenticatedUser, permission: string, scope: { id: string }) =>
      Promise.resolve(permission !== 'node.view' || scope.id !== deniedNodeId),
  } as unknown as AuthorizationService;
  const tags = new TagService(prisma, authorization);
  const search = new SearchService(prisma, authorization);
  const audit = new AuditService(prisma);
  const notifications = new NotificationService(prisma);

  afterAll(() => prisma.$disconnect());

  it('enforces space, node, Tenant, and user boundaries', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
    const tenant = await prisma.tenant.create({
      data: { code: `discovery-${suffix}`, name: 'Discovery Integration' },
    });
    const actorUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `discovery-${suffix}`,
        email: `discovery-${suffix}@example.test`,
        displayName: 'Discovery User',
        status: 'ACTIVE',
      },
    });
    const otherUser = await prisma.user.create({
      data: {
        tenantId: tenant.id,
        loginName: `other-${suffix}`,
        email: `other-${suffix}@example.test`,
        displayName: 'Other User',
        status: 'ACTIVE',
      },
    });
    const actor: AuthenticatedUser = {
      userId: actorUser.id,
      tenantId: tenant.id,
      sessionId: randomUUID(),
      authenticationMethods: ['password', 'totp'],
    };
    const space = await prisma.space.create({
      data: {
        tenantId: tenant.id,
        ownerType: 'TENANT',
        code: `discovery-${suffix}`,
        name: 'Discovery Space',
        createdById: actorUser.id,
      },
    });
    const visible = await createAssetFixture(
      prisma,
      space.id,
      actorUser.id,
      '集团共享合同.pdf',
      'quarterly master agreement',
      suffix,
    );
    const denied = await createAssetFixture(
      prisma,
      space.id,
      actorUser.id,
      '隐藏合同.pdf',
      'quarterly master agreement',
      `${suffix}-denied`,
    );
    deniedNodeId = denied.nodeId;

    const createdTag = await tags.create(
      actor,
      space.id,
      { name: ' 合同 ', color: '#2f6f8f' },
      { requestId: randomUUID() },
    );
    await expect(
      tags.create(actor, space.id, { name: '合同' }, { requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await tags.assign(
      actor,
      visible.assetId,
      { tagIds: [createdTag.id] },
      { requestId: randomUUID() },
    );

    const contentResults = await search.search(actor, space.id, { q: 'quarterly', limit: 50 });
    expect(contentResults.items.map(({ id }) => id)).toEqual([visible.nodeId]);
    const chineseResults = await search.search(actor, space.id, { q: '共享合同', limit: 50 });
    expect(chineseResults.items.map(({ id }) => id)).toEqual([visible.nodeId]);
    const taggedResults = await search.search(actor, space.id, {
      tagIds: [createdTag.id],
      limit: 50,
    });
    expect(taggedResults.items.map(({ id }) => id)).toEqual([visible.nodeId]);

    const ownNotification = await prisma.notification.create({
      data: { userId: actorUser.id, type: 'asset.processing.available', payload: {} },
    });
    const otherNotification = await prisma.notification.create({
      data: { userId: otherUser.id, type: 'asset.processing.available', payload: {} },
    });
    const notificationPage = await notifications.list(actor, { limit: 50 });
    expect(notificationPage.items.map(({ id }) => id)).toContain(ownNotification.id);
    expect(notificationPage.items.map(({ id }) => id)).not.toContain(otherNotification.id);
    await expect(
      notifications.update(actor, otherNotification.id, { status: 'READ' }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });

    await prisma.auditEvent.create({
      data: {
        tenantId: tenant.id,
        actorUserId: actorUser.id,
        action: 'discovery.integration',
        result: 'SUCCEEDED',
      },
    });
    const auditPage = await audit.list(actor, { action: 'discovery.integration', limit: 50 });
    expect(auditPage.items).toHaveLength(1);
    expect(auditPage.items[0]?.actor?.displayName).toBe('Discovery User');
  });
});

async function createAssetFixture(
  prisma: PrismaService,
  spaceId: string,
  userId: string,
  name: string,
  content: string,
  suffix: string,
): Promise<{ nodeId: string; assetId: string }> {
  const node = await prisma.resourceNode.create({
    data: {
      spaceId,
      nodeType: 'ASSET',
      name,
      normalizedName: name.normalize('NFKC').toLocaleLowerCase('zh-CN'),
      createdById: userId,
    },
  });
  const asset = await prisma.asset.create({
    data: { nodeId: node.id, originalFileName: name, mimeType: 'application/pdf' },
  });
  const object = await prisma.storageObject.create({
    data: {
      bucket: 'dam-assets',
      objectKey: `integration/discovery/${suffix}`,
      checksumSha256: '0'.repeat(64),
      sizeBytes: 128n,
    },
  });
  const version = await prisma.assetVersion.create({
    data: {
      assetId: asset.id,
      versionNumber: 1,
      storageObjectId: object.id,
      status: 'AVAILABLE',
      scanStatus: 'CLEAN',
      checksumSha256: object.checksumSha256,
      sizeBytes: object.sizeBytes,
      mimeType: 'application/pdf',
      createdById: userId,
      extraction: { create: { content, parserVersion: 'integration-v1' } },
    },
  });
  await prisma.asset.update({ where: { id: asset.id }, data: { currentVersionId: version.id } });
  return { nodeId: node.id, assetId: asset.id };
}
