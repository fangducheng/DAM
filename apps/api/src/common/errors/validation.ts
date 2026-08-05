import { HttpStatus } from '@nestjs/common';
import type { ValidationError } from 'class-validator';

import type { ApiFieldError } from '@dam/contracts';

import { ApiException } from './api.exception.js';

export function validationException(errors: ValidationError[]): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'VALIDATION_FAILED',
    '提交的数据格式不正确',
    flattenValidationErrors(errors),
  );
}

function flattenValidationErrors(errors: ValidationError[], parent = ''): ApiFieldError[] {
  return errors.flatMap((error) => {
    const field = parent.length === 0 ? error.property : `${parent}.${error.property}`;
    const ownErrors = Object.entries(error.constraints ?? {}).map(([code, message]) => ({
      field,
      code,
      message,
    }));

    return [...ownErrors, ...flattenValidationErrors(error.children ?? [], field)];
  });
}
