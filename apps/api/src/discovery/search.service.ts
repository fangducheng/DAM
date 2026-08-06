import { HttpStatus, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '@dam/contracts';
import { Prisma } from '@dam/database';

import { AuthorizationService } from '../authorization/authorization.service.js';
import { ApiException } from '../common/errors/api.exception.js';
import { PrismaService } from '../infrastructure/prisma.service.js';
import type { SearchAssetsQueryDto } from './dto/discovery.dto.js';

interface SearchCandidate {
  nodeId: string;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: AuthorizationService,
  ) {}

  async search(actor: AuthenticatedUser, spaceId: string, query: SearchAssetsQueryDto) {
    if (!(await this.authorization.canEnterSpace(actor, spaceId))) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'RESOURCE_NOT_FOUND', '资源不存在或你无权查看');
    }
    const candidateLimit = Math.min(query.limit * 4, 200);
    const conditions: Prisma.Sql[] = [
      Prisma.sql`node."space_id" = ${spaceId}::uuid`,
      Prisma.sql`node."status" = 'ACTIVE'`,
      Prisma.sql`version."status" = 'AVAILABLE'`,
      Prisma.sql`version."scan_status" IN ('CLEAN', 'SKIPPED')`,
    ];
    if (query.cursor !== undefined) {
      conditions.push(Prisma.sql`node."id" < ${query.cursor}::uuid`);
    }
    if (query.mimeType !== undefined) {
      conditions.push(
        query.mimeType.endsWith('/*')
          ? Prisma.sql`asset."mime_type" LIKE ${`${query.mimeType.slice(0, -1)}%`}`
          : Prisma.sql`asset."mime_type" = ${query.mimeType}`,
      );
    }
    if (query.q !== undefined) {
      const term = query.q.normalize('NFKC').trim();
      const normalized = term.toLocaleLowerCase('zh-CN');
      const escaped = normalized.replace(/[\\%_]/g, '\\$&');
      conditions.push(Prisma.sql`(
        node."normalized_name" ILIKE ${`%${escaped}%`} ESCAPE '\\'
        OR node."normalized_name" % ${normalized}
        OR extraction."search_vector" @@ websearch_to_tsquery('simple', ${term})
      )`);
    }
    if (query.tagIds !== undefined && query.tagIds.length > 0) {
      const tagIds = Prisma.join(query.tagIds.map((tagId) => Prisma.sql`${tagId}::uuid`));
      conditions.push(Prisma.sql`asset."id" IN (
        SELECT tagged."asset_id"
        FROM "asset_tags" AS tagged
        WHERE tagged."tag_id" IN (${tagIds})
        GROUP BY tagged."asset_id"
        HAVING count(DISTINCT tagged."tag_id") = ${query.tagIds.length}
      )`);
    }

    const candidates = await this.prisma.$queryRaw<SearchCandidate[]>(Prisma.sql`
      SELECT node."id" AS "nodeId"
      FROM "resource_nodes" AS node
      INNER JOIN "assets" AS asset ON asset."node_id" = node."id"
      INNER JOIN "asset_versions" AS version ON version."id" = asset."current_version_id"
      LEFT JOIN "content_extractions" AS extraction
        ON extraction."asset_version_id" = version."id"
      WHERE ${Prisma.join(conditions, ' AND ')}
      ORDER BY node."id" DESC
      LIMIT ${candidateLimit + 1}
    `);

    const allowedIds: string[] = [];
    let lastEvaluatedIndex = -1;
    for (let index = 0; index < Math.min(candidates.length, candidateLimit); index += 1) {
      const candidate = candidates[index]!;
      lastEvaluatedIndex = index;
      if (
        await this.authorization.can(actor, 'node.view', { type: 'NODE', id: candidate.nodeId })
      ) {
        allowedIds.push(candidate.nodeId);
        if (allowedIds.length === query.limit) {
          break;
        }
      }
    }
    const nodes = await this.prisma.resourceNode.findMany({
      where: { id: { in: allowedIds } },
      select: {
        id: true,
        spaceId: true,
        parentId: true,
        nodeType: true,
        name: true,
        status: true,
        deletedAt: true,
        lockVersion: true,
        createdAt: true,
        updatedAt: true,
        createdBy: { select: { id: true, displayName: true } },
        _count: { select: { children: true } },
        asset: {
          select: {
            id: true,
            originalFileName: true,
            mimeType: true,
            category: true,
            _count: { select: { versions: true } },
            tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
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
          },
        },
      },
    });
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const items = allowedIds.flatMap((id) => {
      const node = byId.get(id);
      if (node === undefined || node.asset === null) return [];
      return [
        {
          ...node,
          asset: {
            ...node.asset,
            tags: node.asset.tags.map(({ tag }) => tag),
            currentVersion:
              node.asset.currentVersion === null
                ? null
                : {
                    ...node.asset.currentVersion,
                    sizeBytes: node.asset.currentVersion.sizeBytes.toString(),
                  },
          },
        },
      ];
    });
    const hasMore =
      lastEvaluatedIndex >= 0 &&
      (lastEvaluatedIndex + 1 < candidates.length || candidates.length > candidateLimit);
    return {
      items,
      nextCursor: hasMore ? candidates[lastEvaluatedIndex]!.nodeId : null,
    };
  }
}
