import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import type { AuthorizationRequestMetadata } from '../authorization/authorization.types.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type {
  CreateFolderDto,
  NodePageQueryDto,
  NodeVersionDto,
  PurgeNodeDto,
  RecyclePageQueryDto,
  UpdateNodeDto,
} from './dto/resource.dto.js';
import {
  cancelDeletionMaintenance,
  recycleRetentionDays,
  scheduleDeletionMaintenance,
} from '../maintenance/maintenance-scheduling.js';
import { normalizeResourceName } from './resource-name.js';

const visibleStatuses: Array<'ACTIVE' | 'QUARANTINED'> = ['ACTIVE', 'QUARANTINED'];
const nodeSelection = Prisma.validator<Prisma.ResourceNodeSelect>()({
  id: true,
  spaceId: true,
  parentId: true,
  nodeType: true,
  name: true,
  isRoot: true,
  status: true,
  deletedAt: true,
  deletionBatchId: true,
  deletionBatch: {
    select: {
      id: true,
      rootNodeId: true,
      status: true,
      deletedAt: true,
      purgeAt: true,
      purgeRequestedAt: true,
      itemCount: true,
      sourceBytes: true,
      releasedBytes: true,
      errorMessage: true,
    },
  },
  lockVersion: true,
  createdAt: true,
  updatedAt: true,
  createdBy: { select: { id: true, displayName: true } },
  asset: {
    select: {
      id: true,
      originalFileName: true,
      mimeType: true,
      category: true,
      metadata: true,
      currentVersion: {
        select: {
          id: true,
          versionNumber: true,
          status: true,
          scanStatus: true,
          sizeBytes: true,
          createdAt: true,
        },
      },
      _count: { select: { versions: true } },
    },
  },
  _count: {
    select: {
      children: { where: { status: { in: ['ACTIVE', 'QUARANTINED'] }, isRoot: false } },
    },
  },
});

@Injectable()
export class ResourceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async list(actor: AuthenticatedUser, spaceId: string, query: NodePageQueryDto) {
    const { root, parent } = await this.resolveParent(actor, spaceId, query.parentId);
    if (parent.id !== root.id) {
      await this.authorization.assert(actor, 'node.view', { type: 'NODE', id: parent.id });
    }

    const candidates = await this.prisma.resourceNode.findMany({
      where: {
        spaceId,
        parentId: parent.id,
        isRoot: false,
        status: { in: [...visibleStatuses] },
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: this.nodeSelection(),
    });
    const page = candidates.slice(0, query.limit);
    const decisions = await Promise.all(
      page.map((node) => this.authorization.can(actor, 'node.view', { type: 'NODE', id: node.id })),
    );
    const breadcrumb = await this.breadcrumb(parent.id, root.id);
    return {
      parent: parent.id === root.id ? null : { id: parent.id, name: parent.name },
      rootNodeId: root.id,
      breadcrumb,
      items: page.filter((_, index) => decisions[index]).map((node) => this.serializeNode(node)),
      nextCursor:
        candidates.length > query.limit && page.length > 0 ? page[page.length - 1]!.id : null,
    };
  }

  async get(actor: AuthenticatedUser, nodeId: string) {
    await this.authorization.assert(actor, 'node.view', { type: 'NODE', id: nodeId });
    const node = await this.prisma.resourceNode.findFirst({
      where: {
        id: nodeId,
        space: { tenantId: actor.tenantId },
        status: { in: [...visibleStatuses] },
      },
      select: this.nodeSelection(),
    });
    if (node === null || node.isRoot) {
      throw this.notFound();
    }
    return this.serializeNode(node);
  }

  async createFolder(
    actor: AuthenticatedUser,
    spaceId: string,
    input: CreateFolderDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const { parent } = await this.resolveParent(actor, spaceId, input.parentId);
    await this.authorization.assert(
      actor,
      'node.create',
      { type: 'NODE', id: parent.id },
      metadata,
    );
    const normalized = normalizeResourceName(input.name);

    try {
      const node = await this.prisma.$transaction(async (database) => {
        const created = await database.resourceNode.create({
          data: {
            spaceId,
            parentId: parent.id,
            nodeType: 'FOLDER',
            ...normalized,
            createdById: actor.userId,
          },
          select: this.nodeSelection(),
        });
        const ancestors = await database.resourceClosure.findMany({
          where: { descendantId: parent.id },
          select: { ancestorId: true, depth: true },
        });
        await database.resourceClosure.createMany({
          data: [
            { ancestorId: created.id, descendantId: created.id, depth: 0 },
            ...ancestors.map(({ ancestorId, depth }) => ({
              ancestorId,
              descendantId: created.id,
              depth: depth + 1,
            })),
          ],
        });
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'resource.folder.create',
            resourceType: 'NODE',
            resourceId: created.id,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            afterData: { name: created.name, parentId: created.parentId, spaceId },
          },
        });
        return created;
      });
      return this.serializeNode(node);
    } catch (error) {
      this.rethrowConflict(error, '当前目录下已存在同名资源');
    }
  }

  async update(
    actor: AuthenticatedUser,
    nodeId: string,
    input: UpdateNodeDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const before = await this.activeNode(actor.tenantId, nodeId);
    if (before.isRoot) {
      throw this.notFound();
    }
    await this.authorization.assert(actor, 'node.update', { type: 'NODE', id: nodeId }, metadata);
    const normalized = input.name === undefined ? undefined : normalizeResourceName(input.name);
    const nextParentId = input.parentId ?? before.parentId;
    if (nextParentId === null) {
      throw this.conflict('资源必须位于空间根目录或某个文件夹中');
    }
    const parent = await this.activeFolder(actor.tenantId, before.spaceId, nextParentId);
    if (parent.id !== before.parentId) {
      await this.authorization.assert(
        actor,
        'node.create',
        { type: 'NODE', id: parent.id },
        metadata,
      );
    }
    if (
      before.nodeType === 'FOLDER' &&
      (await this.prisma.resourceClosure.findUnique({
        where: {
          ancestorId_descendantId: { ancestorId: nodeId, descendantId: parent.id },
        },
        select: { depth: true },
      })) !== null
    ) {
      throw this.conflict('文件夹不能移动到自身或其子目录中');
    }

    try {
      const updated = await this.prisma.$transaction(
        async (database) => {
          const changed = await database.resourceNode.updateMany({
            where: {
              id: nodeId,
              lockVersion: input.lockVersion,
              isRoot: false,
              status: { in: [...visibleStatuses] },
            },
            data: {
              ...(normalized ?? {}),
              parentId: parent.id,
              lockVersion: { increment: 1 },
            },
          });
          if (changed.count !== 1) {
            throw this.conflict('资源已被其他用户修改，请刷新后重试');
          }
          if (parent.id !== before.parentId) {
            await this.moveClosure(database, nodeId, parent.id);
          }
          const after = await database.resourceNode.findUniqueOrThrow({
            where: { id: nodeId },
            select: this.nodeSelection(),
          });
          await database.auditEvent.create({
            data: {
              tenantId: actor.tenantId,
              actorUserId: actor.userId,
              action: 'resource.update',
              resourceType: 'NODE',
              resourceId: nodeId,
              result: 'SUCCEEDED',
              ...this.auditMetadata(metadata),
              beforeData: { name: before.name, parentId: before.parentId },
              afterData: { name: after.name, parentId: after.parentId },
            },
          });
          return after;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return this.serializeNode(updated);
    } catch (error) {
      this.rethrowConflict(error, '当前目录下已存在同名资源');
    }
  }

  async trash(
    actor: AuthenticatedUser,
    nodeId: string,
    input: NodeVersionDto,
    metadata: AuthorizationRequestMetadata,
  ): Promise<void> {
    const node = await this.activeNode(actor.tenantId, nodeId);
    if (node.isRoot) {
      throw this.notFound();
    }
    await this.authorization.assert(actor, 'node.delete', { type: 'NODE', id: nodeId }, metadata);
    const deletionBatchId = randomUUID();
    const deletedAt = new Date();
    const purgeAt = new Date(deletedAt.getTime() + recycleRetentionDays * 24 * 60 * 60 * 1_000);
    await this.prisma.$transaction(
      async (database) => {
        const closure = await database.resourceClosure.findMany({
          where: { ancestorId: nodeId },
          select: {
            descendant: { select: { id: true, status: true, deletionBatchId: true } },
          },
        });
        const subtree = closure.map(({ descendant }) => descendant);
        if (subtree.some(({ status }) => status === 'PURGING')) {
          throw this.conflict('子目录正在永久删除，请稍后刷新后重试');
        }
        const nestedBatchIds = [
          ...new Set(
            subtree
              .map(({ deletionBatchId: batchId }) => batchId)
              .filter((batchId): batchId is string => batchId !== null),
          ),
        ];
        const nestedBatches = await database.deletionBatch.findMany({
          where: { id: { in: nestedBatchIds } },
          select: { id: true, status: true },
        });
        if (nestedBatches.some(({ status }) => !['RETAINED', 'FAILED'].includes(status))) {
          throw this.conflict('子目录已进入永久删除流程，请稍后刷新后重试');
        }
        const subtreeIds = subtree.map(({ id }) => id);
        const sourceBytes = await database.assetVersion.aggregate({
          where: { asset: { nodeId: { in: subtreeIds } } },
          _sum: { sizeBytes: true },
        });
        const batch = await database.deletionBatch.create({
          data: {
            id: deletionBatchId,
            tenantId: actor.tenantId,
            spaceId: node.spaceId,
            rootNodeId: nodeId,
            rootName: node.name,
            rootType: node.nodeType,
            deletedById: actor.userId,
            deletedAt,
            purgeAt,
            itemCount: subtree.length,
            sourceBytes: sourceBytes._sum.sizeBytes ?? 0n,
          },
        });
        const changed = await database.resourceNode.updateMany({
          where: {
            id: nodeId,
            lockVersion: input.lockVersion,
            status: { in: [...visibleStatuses] },
          },
          data: {
            status: 'DELETED',
            deletedAt,
            deletionBatchId,
            lockVersion: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw this.conflict('资源已被其他用户修改，请刷新后重试');
        }
        await database.resourceNode.updateMany({
          where: {
            id: { in: subtreeIds.filter((id) => id !== nodeId) },
            status: { in: ['ACTIVE', 'QUARANTINED', 'DELETED'] },
          },
          data: { status: 'DELETED', deletedAt, deletionBatchId, lockVersion: { increment: 1 } },
        });
        if (nestedBatchIds.length > 0) {
          await database.deletionBatch.updateMany({
            where: { id: { in: nestedBatchIds } },
            data: { status: 'SUPERSEDED', errorMessage: null },
          });
          await cancelDeletionMaintenance(database, nestedBatchIds);
        }
        await scheduleDeletionMaintenance(database, batch);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'resource.trash',
            resourceType: 'NODE',
            resourceId: nodeId,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            details: {
              deletionBatchId,
              name: node.name,
              purgeAt: purgeAt.toISOString(),
              itemCount: subtree.length,
              sourceBytes: (sourceBytes._sum.sizeBytes ?? 0n).toString(),
            },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async recycleBin(actor: AuthenticatedUser, spaceId: string, query: RecyclePageQueryDto) {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw this.notFound();
    }
    const candidates = await this.prisma.resourceNode.findMany({
      where: {
        spaceId,
        status: { in: ['DELETED', 'PURGING'] },
        deletionBatchId: { not: null },
        deletionBatch: {
          status: { in: ['RETAINED', 'PURGE_REQUESTED', 'PURGING', 'FAILED'] },
        },
        isRoot: false,
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
      ...(query.cursor === undefined ? {} : { cursor: { id: query.cursor }, skip: 1 }),
      select: {
        ...this.nodeSelection(),
        parent: { select: { deletionBatchId: true } },
      },
    });
    const roots = candidates.filter(
      (node) => node.parent?.deletionBatchId !== node.deletionBatchId,
    );
    const decisions = await Promise.all(
      roots.map((node) =>
        this.authorization.can(actor, 'node.delete', { type: 'NODE', id: node.id }),
      ),
    );
    return {
      items: roots.filter((_, index) => decisions[index]).map((node) => this.serializeNode(node)),
      nextCursor:
        candidates.length > query.limit && candidates.length > 0
          ? candidates[Math.min(query.limit, candidates.length) - 1]!.id
          : null,
    };
  }

  async restore(
    actor: AuthenticatedUser,
    nodeId: string,
    input: NodeVersionDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const node = await this.prisma.resourceNode.findFirst({
      where: {
        id: nodeId,
        space: { tenantId: actor.tenantId },
        status: 'DELETED',
        deletionBatchId: { not: null },
        deletionBatch: { status: 'RETAINED' },
        isRoot: false,
      },
      select: { ...this.nodeSelection(), parent: { select: { id: true, status: true } } },
    });
    if (
      node === null ||
      node.deletionBatchId === null ||
      node.deletionBatch === null ||
      node.deletionBatch.rootNodeId !== nodeId ||
      node.parent?.status !== 'ACTIVE'
    ) {
      throw this.conflict('原目录不可用，暂时无法恢复该资源');
    }
    await this.authorization.assert(actor, 'node.delete', { type: 'NODE', id: nodeId }, metadata);

    try {
      const restored = await this.prisma.$transaction(async (database) => {
        const locked = await database.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT "status"::text AS "status"
          FROM "deletion_batches"
          WHERE "id" = ${node.deletionBatchId!}::uuid
          FOR UPDATE
        `);
        if (locked[0]?.status !== 'RETAINED') {
          throw this.conflict('该资源已进入永久删除流程，无法恢复');
        }
        const batch = await database.resourceNode.findMany({
          where: { deletionBatchId: node.deletionBatchId! },
          select: {
            id: true,
            nodeType: true,
            asset: { select: { currentVersion: { select: { status: true } } } },
          },
        });
        const availableIds = batch
          .filter(
            (item) =>
              item.nodeType === 'FOLDER' || item.asset?.currentVersion?.status === 'AVAILABLE',
          )
          .map(({ id }) => id);
        const quarantinedIds = batch
          .filter((item) => !availableIds.includes(item.id))
          .map(({ id }) => id);
        const nextRootStatus = availableIds.includes(nodeId) ? 'ACTIVE' : 'QUARANTINED';
        const changed = await database.resourceNode.updateMany({
          where: { id: nodeId, lockVersion: input.lockVersion, status: 'DELETED' },
          data: {
            status: nextRootStatus,
            deletedAt: null,
            deletionBatchId: null,
            lockVersion: { increment: 1 },
          },
        });
        if (changed.count !== 1) {
          throw this.conflict('资源已被其他用户修改，请刷新后重试');
        }
        await database.resourceNode.updateMany({
          where: { id: { in: availableIds.filter((id) => id !== nodeId) } },
          data: {
            status: 'ACTIVE',
            deletedAt: null,
            deletionBatchId: null,
            lockVersion: { increment: 1 },
          },
        });
        await database.resourceNode.updateMany({
          where: { id: { in: quarantinedIds.filter((id) => id !== nodeId) } },
          data: {
            status: 'QUARANTINED',
            deletedAt: null,
            deletionBatchId: null,
            lockVersion: { increment: 1 },
          },
        });
        await database.deletionBatch.update({
          where: { id: node.deletionBatchId! },
          data: { status: 'RESTORED', restoredAt: new Date(), errorMessage: null },
        });
        await cancelDeletionMaintenance(database, [node.deletionBatchId!]);
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'resource.restore',
            resourceType: 'NODE',
            resourceId: nodeId,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            details: { name: node.name, deletionBatchId: node.deletionBatchId },
          },
        });
        return database.resourceNode.findUniqueOrThrow({
          where: { id: nodeId },
          select: this.nodeSelection(),
        });
      });
      return this.serializeNode(restored);
    } catch (error) {
      this.rethrowConflict(error, '原目录中已存在同名资源，请先处理名称冲突');
    }
  }

  async requestPurge(
    actor: AuthenticatedUser,
    nodeId: string,
    input: PurgeNodeDto,
    metadata: AuthorizationRequestMetadata,
  ) {
    const node = await this.prisma.resourceNode.findFirst({
      where: {
        id: nodeId,
        space: { tenantId: actor.tenantId },
        status: { in: ['DELETED', 'PURGING'] },
        deletionBatchId: { not: null },
        isRoot: false,
      },
      select: this.nodeSelection(),
    });
    if (
      node === null ||
      node.deletionBatchId === null ||
      node.deletionBatch === null ||
      node.deletionBatch.rootNodeId !== nodeId
    ) {
      throw this.notFound();
    }
    const deletionBatch = node.deletionBatch;
    await this.authorization.assert(actor, 'node.delete', { type: 'NODE', id: nodeId }, metadata);
    if (input.confirmationName !== node.name) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VALIDATION_FAILED',
        '确认名称与资源名称不一致',
        [
          {
            field: 'confirmationName',
            code: 'MISMATCH',
            message: '请输入完整且完全一致的资源名称',
          },
        ],
      );
    }
    const requestedAt = new Date();
    await this.prisma.$transaction(
      async (database) => {
        const locked = await database.$queryRaw<Array<{ status: string }>>(Prisma.sql`
          SELECT "status"::text AS "status"
          FROM "deletion_batches"
          WHERE "id" = ${node.deletionBatchId!}::uuid
          FOR UPDATE
        `);
        if (locked[0]?.status !== 'RETAINED') {
          throw this.conflict('该资源已进入永久删除流程，请勿重复提交');
        }
        const changed = await database.resourceNode.updateMany({
          where: {
            id: nodeId,
            deletionBatchId: node.deletionBatchId,
            status: 'DELETED',
            lockVersion: input.lockVersion,
          },
          data: { status: 'PURGING', lockVersion: { increment: 1 } },
        });
        if (changed.count !== 1) {
          throw this.conflict('资源已被其他用户修改，请刷新后重试');
        }
        await database.resourceNode.updateMany({
          where: {
            deletionBatchId: node.deletionBatchId,
            id: { not: nodeId },
            status: 'DELETED',
          },
          data: { status: 'PURGING', lockVersion: { increment: 1 } },
        });
        await database.deletionBatch.update({
          where: { id: node.deletionBatchId! },
          data: { status: 'PURGE_REQUESTED', purgeRequestedAt: requestedAt, errorMessage: null },
        });
        await scheduleDeletionMaintenance(database, {
          id: deletionBatch.id,
          tenantId: actor.tenantId,
          spaceId: node.spaceId,
          purgeAt: deletionBatch.purgeAt,
        });
        await database.maintenanceJob.updateMany({
          where: {
            targetId: node.deletionBatchId,
            jobType: 'RETENTION_WARNING',
            status: 'PENDING',
          },
          data: { status: 'CANCELLED', completedAt: requestedAt },
        });
        await database.maintenanceJob.updateMany({
          where: { targetId: node.deletionBatchId, jobType: 'PURGE_DELETION_BATCH' },
          data: {
            status: 'PENDING',
            attempts: 0,
            availableAt: requestedAt,
            completedAt: null,
            lockedAt: null,
            lockedBy: null,
            leaseExpiresAt: null,
            errorMessage: null,
          },
        });
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'resource.purge.requested',
            resourceType: 'DELETION_BATCH',
            resourceId: node.deletionBatchId,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            details: { rootNodeId: nodeId, name: node.name },
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return { status: 'PURGE_REQUESTED' as const, purgeRequestedAt: requestedAt };
  }

  private async resolveParent(actor: AuthenticatedUser, spaceId: string, parentId?: string) {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw this.notFound();
    }
    const root = await this.prisma.resourceNode.findFirst({
      where: { spaceId, isRoot: true, status: 'ACTIVE', space: { tenantId: actor.tenantId } },
      select: { id: true, name: true, spaceId: true },
    });
    if (root === null) {
      throw this.notFound();
    }
    const parent =
      parentId === undefined || parentId === root.id
        ? root
        : await this.activeFolder(actor.tenantId, spaceId, parentId);
    return { root, parent };
  }

  private async activeFolder(tenantId: string, spaceId: string, nodeId: string) {
    const node = await this.prisma.resourceNode.findFirst({
      where: {
        id: nodeId,
        spaceId,
        nodeType: 'FOLDER',
        status: 'ACTIVE',
        space: { tenantId },
      },
      select: { id: true, name: true, spaceId: true },
    });
    if (node === null) {
      throw this.notFound();
    }
    return node;
  }

  private async activeNode(tenantId: string, nodeId: string) {
    const node = await this.prisma.resourceNode.findFirst({
      where: {
        id: nodeId,
        space: { tenantId },
        status: { in: [...visibleStatuses] },
      },
      select: {
        id: true,
        spaceId: true,
        parentId: true,
        nodeType: true,
        name: true,
        normalizedName: true,
        isRoot: true,
        lockVersion: true,
      },
    });
    if (node === null) {
      throw this.notFound();
    }
    return node;
  }

  private async breadcrumb(parentId: string, rootId: string) {
    const ancestors = await this.prisma.resourceClosure.findMany({
      where: { descendantId: parentId, ancestorId: { not: rootId } },
      orderBy: { depth: 'desc' },
      select: { ancestor: { select: { id: true, name: true } } },
    });
    return ancestors.map(({ ancestor }) => ancestor);
  }

  private async moveClosure(
    database: Prisma.TransactionClient,
    nodeId: string,
    newParentId: string,
  ): Promise<void> {
    const [subtree, ancestors] = await Promise.all([
      database.resourceClosure.findMany({
        where: { ancestorId: nodeId },
        select: { descendantId: true, depth: true },
      }),
      database.resourceClosure.findMany({
        where: { descendantId: newParentId },
        select: { ancestorId: true, depth: true },
      }),
    ]);
    const subtreeIds = subtree.map(({ descendantId }) => descendantId);
    await database.resourceClosure.deleteMany({
      where: {
        descendantId: { in: subtreeIds },
        ancestorId: { notIn: subtreeIds },
      },
    });
    await database.resourceClosure.createMany({
      data: ancestors.flatMap((ancestor) =>
        subtree.map((descendant) => ({
          ancestorId: ancestor.ancestorId,
          descendantId: descendant.descendantId,
          depth: ancestor.depth + descendant.depth + 1,
        })),
      ),
    });
  }

  private nodeSelection() {
    return nodeSelection;
  }

  private serializeNode<
    T extends {
      asset: null | { currentVersion: null | { sizeBytes: bigint } };
      deletionBatch: null | { sourceBytes: bigint; releasedBytes: bigint };
    },
  >(node: T) {
    return {
      ...node,
      deletionBatch:
        node.deletionBatch === null
          ? null
          : {
              ...node.deletionBatch,
              sourceBytes: node.deletionBatch.sourceBytes.toString(),
              releasedBytes: node.deletionBatch.releasedBytes.toString(),
            },
      asset:
        node.asset === null
          ? null
          : {
              ...node.asset,
              currentVersion:
                node.asset.currentVersion === null
                  ? null
                  : {
                      ...node.asset.currentVersion,
                      sizeBytes: node.asset.currentVersion.sizeBytes.toString(),
                    },
            },
    };
  }

  private auditMetadata(metadata: AuthorizationRequestMetadata) {
    return {
      ipAddress: metadata.ipAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      requestId: metadata.requestId ?? null,
    };
  }

  private rethrowConflict(error: unknown, message: string): never {
    if (error instanceof ApiException) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw this.conflict(message);
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
      throw this.conflict('资源已被其他用户修改，请刷新后重试');
    }
    throw error;
  }

  private conflict(message: string): ApiException {
    return new ApiException(HttpStatus.CONFLICT, 'VERSION_CONFLICT', message);
  }

  private notFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
  }
}
