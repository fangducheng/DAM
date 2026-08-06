import { HttpStatus } from '@nestjs/common';

import { ApiException } from '../common/errors/api.exception.js';

export function normalizeResourceName(
  value: string,
  field = 'name',
): {
  name: string;
  normalizedName: string;
} {
  const name = value.normalize('NFC').trim();
  if (
    name.length === 0 ||
    name.length > 255 ||
    name === '.' ||
    name === '..' ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || character === '/' || character === '\\';
    })
  ) {
    throw new ApiException(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', '资源名称格式不正确', [
      {
        field,
        code: 'resourceName',
        message: '名称不能包含路径分隔符、控制字符，也不能是 . 或 ..',
      },
    ]);
  }
  return { name, normalizedName: name.normalize('NFKC').toLowerCase() };
}
