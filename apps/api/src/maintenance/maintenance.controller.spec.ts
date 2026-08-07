import { type CanActivate, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedUser, PermissionCode } from '@dam/contracts';

import { AuthorizationGuard } from '../authorization/authorization.guard.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { AccessTokenGuard } from '../identity/auth/access-token.guard.js';
import type { AuthenticatedRequest } from '../identity/auth/authenticated-request.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceService } from './maintenance.service.js';
import { StorageReconciliationService } from './storage-reconciliation.service.js';

const actor: AuthenticatedUser = {
  userId: '00000000-0000-7000-8000-000000000001',
  tenantId: '00000000-0000-7000-8000-000000000002',
  sessionId: '00000000-0000-7000-8000-000000000003',
  authenticationMethods: ['password'],
};

class TestAccessTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.authenticatedUser = actor;
    return true;
  }
}

describe('MaintenanceController reconciliation authorization', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('allows maintenance.read history but denies run creation without maintenance.manage', async () => {
    const assertPermission = vi.fn(
      (_authenticatedUser: AuthenticatedUser, permission: PermissionCode) => {
        if (permission === 'maintenance.manage') {
          throw new ForbiddenException('maintenance.manage is required');
        }
      },
    );
    const reconciliation = {
      createRun: vi.fn(),
      listRuns: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      getRun: vi.fn(),
      listIssues: vi.fn(),
    };
    const authorizationGuard = new AuthorizationGuard(new Reflector(), {
      assert: assertPermission,
    } as unknown as AuthorizationService);
    Reflect.defineMetadata(
      'design:paramtypes',
      [MaintenanceService, StorageReconciliationService],
      MaintenanceController,
    );
    const module = await Test.createTestingModule({
      controllers: [MaintenanceController],
      providers: [
        Reflector,
        AuthorizationGuard,
        { provide: AuthorizationService, useValue: { assert: assertPermission } },
        { provide: MaintenanceService, useValue: {} },
        { provide: StorageReconciliationService, useValue: reconciliation },
      ],
    })
      .overrideGuard(AccessTokenGuard)
      .useClass(TestAccessTokenGuard)
      .overrideGuard(AuthorizationGuard)
      .useValue(authorizationGuard)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const history = await app.inject({
      method: 'GET',
      url: '/maintenance/storage-reconciliation/runs',
    });
    expect(history.statusCode).toBe(200);
    expect(reconciliation.listRuns).toHaveBeenCalledOnce();
    expect(assertPermission).toHaveBeenCalledWith(
      actor,
      'maintenance.read',
      { type: 'TENANT', id: actor.tenantId },
      expect.any(Object),
    );

    const create = await app.inject({
      method: 'POST',
      url: '/maintenance/storage-reconciliation/runs',
      payload: {},
    });
    expect(create.statusCode).toBe(403);
    expect(reconciliation.createRun).not.toHaveBeenCalled();
    expect(assertPermission).toHaveBeenLastCalledWith(
      actor,
      'maintenance.manage',
      { type: 'TENANT', id: actor.tenantId },
      expect.any(Object),
    );
  });
});
