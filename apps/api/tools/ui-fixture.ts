import { randomBytes } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { generate } from 'otplib';

import { validateEnvironment } from '@dam/config';
import { PrismaClient } from '@dam/database';

import { PasswordService } from '../src/identity/security/password.service.js';
import { SecurityCryptoService } from '../src/identity/security/security-crypto.service.js';
import { TotpService } from '../src/identity/security/totp.service.js';

process.env['DATABASE_URL'] ??=
  'postgresql://dam:dam_local_password@localhost:5433/dam?schema=public';

const command = process.argv[2];
const value = process.argv[3];
if ((command !== 'create' && command !== 'cleanup') || !value) {
  throw new Error('Usage: pnpm --filter @dam/api fixture:ui -- <create|cleanup> <suffix-or-code>');
}

const environment = validateEnvironment(process.env);
const config = new ConfigService(environment);
const prisma = new PrismaClient();

try {
  if (command === 'create') {
    const suffix = value.replace(/[^a-z0-9-]/gi, '').toLowerCase();
    if (suffix.length === 0) {
      throw new Error('UI fixture suffix must contain letters, numbers, or hyphens');
    }
    const tenantCode = `ui-${suffix}`;
    const loginName = `ui-admin-${suffix}`;
    const email = `${loginName}@example.test`;
    const password = `Ui-${randomBytes(12).toString('base64url')}!`;
    const passwords = new PasswordService(config);
    const crypto = new SecurityCryptoService(config);
    const totp = new TotpService(config);
    const setup = totp.createSetup(email);
    const passwordHash = await passwords.hash(password);
    const platformAdmin = await prisma.role.findUniqueOrThrow({
      where: { code: 'platform_admin' },
    });
    const created = await prisma.$transaction(async (database) => {
      const tenant = await database.tenant.create({
        data: {
          code: tenantCode,
          name: `UI Verification ${suffix}`,
          securityPolicy: { create: {} },
        },
      });
      await database.organization.create({
        data: {
          tenantId: tenant.id,
          code: 'company-a',
          name: '界面验收公司',
        },
      });
      const user = await database.user.create({
        data: {
          tenantId: tenant.id,
          loginName,
          email,
          displayName: '界面验收管理员',
          status: 'ACTIVE',
          credential: { create: { passwordHash } },
          mfaMethods: {
            create: {
              type: 'TOTP',
              label: 'UI verification',
              secretCiphertext: crypto.encryptSecret(setup.secret),
              verifiedAt: new Date(),
            },
          },
        },
      });
      await database.roleBinding.create({
        data: {
          tenantId: tenant.id,
          roleId: platformAdmin.id,
          principalType: 'USER',
          principalId: user.id,
          scopeType: 'TENANT',
          scopeId: tenant.id,
        },
      });
      await database.notification.create({
        data: {
          userId: user.id,
          type: 'asset.processing.available',
          payload: { versionNumber: 1, source: 'ui-verification' },
        },
      });
      await database.auditEvent.create({
        data: {
          tenantId: tenant.id,
          actorUserId: user.id,
          action: 'ui.fixture.create',
          resourceType: 'TENANT',
          resourceId: tenant.id,
          result: 'SUCCEEDED',
        },
      });
      return { tenantId: tenant.id, userId: user.id };
    });
    console.log(
      JSON.stringify({
        ...created,
        tenantCode,
        identifier: loginName,
        password,
        totpSecret: setup.secret,
        mfaCode: await generate({ secret: setup.secret }),
      }),
    );
  } else {
    const tenantCode = value;
    if (!/^ui-[a-z0-9-]+$/.test(tenantCode)) {
      throw new Error('UI fixture cleanup only accepts ui-* tenant codes');
    }
    const tenant = await prisma.tenant.findUnique({
      where: { code: tenantCode },
      select: {
        id: true,
        spaces: {
          select: {
            nodes: {
              select: {
                asset: {
                  select: {
                    versions: {
                      select: { storageObject: { select: { id: true, objectKey: true } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (tenant === null) {
      console.log(JSON.stringify({ tenantCode, removed: false }));
    } else {
      const storageObjects = tenant.spaces.flatMap((space) =>
        space.nodes.flatMap((node) =>
          (node.asset?.versions ?? []).map((version) => version.storageObject),
        ),
      );
      const endpoint = new URL(environment.MINIO_ENDPOINT);
      const minio = new Client({
        endPoint: endpoint.hostname,
        port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === 'https:' ? 443 : 80,
        useSSL: endpoint.protocol === 'https:',
        accessKey: environment.MINIO_ACCESS_KEY,
        secretKey: environment.MINIO_SECRET_KEY,
      });
      await Promise.all(
        storageObjects.map(({ objectKey }) =>
          minio.removeObject(environment.MINIO_BUCKET, objectKey).catch(() => undefined),
        ),
      );
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "audit_events" DISABLE TRIGGER "audit_events_append_only"',
      );
      try {
        await prisma.resourceNode.updateMany({
          where: { space: { tenantId: tenant.id } },
          data: { parentId: null },
        });
        await prisma.space.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.invitation.deleteMany({ where: { tenantId: tenant.id } });
        await prisma.tenant.delete({ where: { id: tenant.id } });
      } finally {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE "audit_events" ENABLE TRIGGER "audit_events_append_only"',
        );
      }
      await prisma.storageObject.deleteMany({
        where: { id: { in: storageObjects.map(({ id }) => id) } },
      });
      console.log(JSON.stringify({ tenantCode, removed: true, objects: storageObjects.length }));
    }
  }
} finally {
  await prisma.$disconnect();
}
