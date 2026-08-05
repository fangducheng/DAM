import { ArgumentsHost, Catch, HttpException, Logger, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ApiErrorCode, ApiErrorResponse } from '@dam/contracts';

import { ApiException } from './api.exception.js';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const requestId = String(request.id);
    const statusCode = exception instanceof HttpException ? exception.getStatus() : 500;
    const code = this.code(exception, statusCode);
    const message = this.message(exception, statusCode);
    const response: ApiErrorResponse = {
      statusCode,
      code,
      message,
      requestId,
      timestamp: new Date().toISOString(),
      ...(exception instanceof ApiException && exception.fieldErrors !== undefined
        ? { fieldErrors: exception.fieldErrors }
        : {}),
    };

    if (statusCode >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      this.logger.error(`Unhandled request failure (${requestId})`, stack);
    }

    void reply.status(statusCode).send(response);
  }

  private code(exception: unknown, statusCode: number): ApiErrorCode {
    if (exception instanceof ApiException) {
      return exception.code;
    }

    if (statusCode === 400) {
      return 'VALIDATION_FAILED';
    }
    if (statusCode === 401) {
      return 'AUTHENTICATION_FAILED';
    }
    if (statusCode === 403) {
      return 'ACCESS_DENIED';
    }
    if (statusCode === 404) {
      return 'RESOURCE_NOT_FOUND';
    }
    if (statusCode === 429) {
      return 'TOO_MANY_ATTEMPTS';
    }

    return 'INTERNAL_ERROR';
  }

  private message(exception: unknown, statusCode: number): string {
    if (exception instanceof ApiException) {
      return exception.message;
    }
    if (statusCode >= 500) {
      return '服务暂时不可用，请稍后重试';
    }
    if (exception instanceof HttpException && typeof exception.message === 'string') {
      return exception.message;
    }

    return '请求处理失败';
  }
}
