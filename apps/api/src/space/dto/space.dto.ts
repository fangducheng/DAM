import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

import { permissionCodes, type PermissionCode } from '@dam/contracts';

const nodePermissionCodes = permissionCodes.filter((code) => code.startsWith('node.'));

export class SpacePageQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class SpaceMemberPageQueryDto {
  @IsOptional()
  @Matches(/^(USER|GROUP|ORGANIZATION):[0-9a-fA-F-]{36}$/)
  cursor?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class CreateSpaceDto {
  @IsString()
  @Length(2, 80)
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/)
  code!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsIn(['TENANT', 'ORGANIZATION'])
  ownerType!: 'TENANT' | 'ORGANIZATION';

  @IsOptional()
  @IsUUID()
  ownerOrganizationId?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  quotaBytes = '0';
}

export class UpdateSpaceDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d+$/)
  quotaBytes?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

export class SpaceMemberParamsDto {
  @IsIn(['USER', 'GROUP', 'ORGANIZATION'])
  principalType!: 'USER' | 'GROUP' | 'ORGANIZATION';

  @IsUUID()
  principalId!: string;
}

export class SpaceMemberRouteParamsDto extends SpaceMemberParamsDto {
  @IsUUID()
  spaceId!: string;
}

export class UpsertSpaceMemberDto {
  @IsIn(['space_manager', 'editor', 'contributor', 'viewer', 'restricted'])
  roleCode!: 'space_manager' | 'editor' | 'contributor' | 'viewer' | 'restricted';
}

export class AclListQueryDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  includeInherited = true;
}

export class UpsertResourceAclDto {
  @IsIn(['USER', 'GROUP', 'ORGANIZATION'])
  principalType!: 'USER' | 'GROUP' | 'ORGANIZATION';

  @IsUUID()
  principalId!: string;

  @IsIn(nodePermissionCodes)
  permissionCode!: PermissionCode;

  @IsIn(['ALLOW', 'DENY'])
  effect!: 'ALLOW' | 'DENY';

  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string | null;
}

export class PermissionParamsDto {
  @IsIn(nodePermissionCodes)
  permissionCode!: PermissionCode;
}

export class PermissionRouteParamsDto extends PermissionParamsDto {
  @IsUUID()
  nodeId!: string;
}
