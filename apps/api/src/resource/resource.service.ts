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
  RecyclePageQueryDto,
  UpdateNodeDto,
} from './dto/resource.dto.js';
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
    await this.prisma.$transaction(async (database) => {
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
      const descendants = await database.resourceClosure.findMany({
        where: { ancestorId: nodeId, depth: { gt: 0 } },
        select: { descendantId: true },
      });
      await database.resourceNode.updateMany({
        where: {
          id: { in: descendants.map(({ descendantId }) => descendantId) },
          status: { in: [...visibleStatuses] },
        },
        data: { status: 'DELETED', deletedAt, deletionBatchId, lockVersion: { increment: 1 } },
      });
      await database.auditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'resource.trash',
          resourceType: 'NODE',
          resourceId: nodeId,
          result: 'SUCCEEDED',
          ...this.auditMetadata(metadata),
          details: { deletionBatchId, name: node.name },
        },
      });
    });
  }

  async recycleBin(actor: AuthenticatedUser, spaceId: string, query: RecyclePageQueryDto) {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw this.notFound();
    }
    const candidates = await this.prisma.resourceNode.findMany({
      where: {
        spaceId,
        status: 'DELETED',
        deletionBatchId: { not: null },
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
        isRoot: false,
      },
      select: { ...this.nodeSelection(), parent: { select: { id: true, status: true } } },
    });
    if (node === null || node.deletionBatchId === null || node.parent?.status !== 'ACTIVE') {
      throw this.conflict('原目录不可用，暂时无法恢复该资源');
    }
    await this.authorization.assert(actor, 'node.delete', { type: 'NODE', id: nodeId }, metadata);

    try {
      const restored = await this.prisma.$transaction(async (database) => {
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
        await database.auditEvent.create({
          data: {
            tenantId: actor.tenantId,
            actorUserId: actor.userId,
            action: 'resource.restore',
            resourceType: 'NODE',
            resourceId: nodeId,
            result: 'SUCCEEDED',
            ...this.auditMetadata(metadata),
            details: { name: node.name },
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
    T extends { asset: null | { currentVersion: null | { sizeBytes: bigint } } },
  >(node: T) {
    return {
      ...node,
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
