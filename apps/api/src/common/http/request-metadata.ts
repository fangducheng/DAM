import type { FastifyRequest } from 'fastify';

import type { AuthorizationRequestMetadata } from '../../authorization/authorization.types.js';

export function requestMetadata(request: FastifyRequest): AuthorizationRequestMetadata {
  const userAgent = request.headers['user-agent'];
  return {
    ipAddress: request.ip,
    requestId: String(request.id),
    ...(userAgent === undefined ? {} : { userAgent }),
  };
}
