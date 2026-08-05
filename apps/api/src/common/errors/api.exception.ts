import { HttpException, type HttpStatus } from '@nestjs/common';

import type { ApiErrorCode, ApiFieldError } from '@dam/contracts';

export class ApiException extends HttpException {
  constructor(
    statusCode: HttpStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly fieldErrors?: ApiFieldError[],
  ) {
    super(message, statusCode);
  }
}
