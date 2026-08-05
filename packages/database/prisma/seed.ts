import { PrismaClient, type Prisma } from '@prisma/client';

import {
  permissionCodes,
  systemRoleCodes,
  systemRolePermissions,
  type PermissionCode,
  type SystemRoleCode,
} from '@dam/contracts';

const prisma = new PrismaClient();

const permissionNames: Record<PermissionCode, string> = {
  'platform.manage': 'Manage platform',
  'audit.read': 'Read audit events',
  'tenant.manage': 'Manage tenant',
  'organization.manage': 'Manage organization',
  'organization.users.manage': 'Manage organization users',
  'space.create': 'Create spaces',
  'space.manage': 'Manage space',
  'space.members.manage': 'Manage space members',
  'node.view': 'View resource',
  'node.preview': 'Preview asset',
  'node.download': 'Download asset',
  'node.create': 'Create resource',
  'node.update': 'Update resource',
  'node.delete': 'Delete resource',
  'node.permissions.manage': 'Manage resource permissions',
};

const roleNames: Record<SystemRoleCode, string> = {
  platform_admin: 'Platform administrator',
  platform_auditor: 'Platform auditor',
  organization_admin: 'Organization administrator',
  organization_member: 'Organization member',
  space_manager: 'Space manager',
  editor: 'Editor',
  contributor: 'Contributor',
  viewer: 'Viewer',
  restricted: 'Restricted member',
};

async function seedPermissions(database: Prisma.TransactionClient): Promise<void> {
  for (const code of permissionCodes) {
    await database.permission.upsert({
      where: { code },
      update: { name: permissionNames[code] },
      create: { code, name: permissionNames[code] },
    });
  }
}

async function seedRoles(database: Prisma.TransactionClient): Promise<void> {
  for (const code of systemRoleCodes) {
    const role = await database.role.upsert({
      where: { code },
      update: { name: roleNames[code], isSystem: true },
      create: { code, name: roleNames[code], isSystem: true },
    });
    const desiredCodes = [...systemRolePermissions[code]];
    const permissions = await database.permission.findMany({
      where: { code: { in: desiredCodes } },
      select: { id: true },
    });

    await database.rolePermission.deleteMany({
      where: {
        roleId: role.id,
        ...(permissions.length > 0
          ? { permissionId: { notIn: permissions.map(({ id }) => id) } }
          : {}),
      },
    });
    await database.rolePermission.createMany({
      data: permissions.map(({ id }) => ({ roleId: role.id, permissionId: id })),
      skipDuplicates: true,
    });
  }
}

async function main(): Promise<void> {
  await prisma.$transaction(async (database) => {
    await seedPermissions(database);
    await seedRoles(database);
  });
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
