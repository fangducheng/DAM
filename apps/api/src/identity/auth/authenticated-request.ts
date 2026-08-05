import type { FastifyRequest } from 'fastify';

import type { AuthenticatedUser } from '@dam/contracts';

export interface AuthenticatedRequest extends FastifyRequest {
  authenticatedUser?: AuthenticatedUser;
}
