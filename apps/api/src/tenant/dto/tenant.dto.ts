import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class PageQueryDto {
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

export class UpdateTenantSecurityPolicyDto {
  @IsOptional()
  @IsBoolean()
  requireAdminMfa?: boolean;

  @IsOptional()
  @IsBoolean()
  requireMemberMfa?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  accessTokenTtlMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  refreshTokenTtlDays?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(20)
  maxPasswordAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  passwordLockMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(20)
  maxMfaAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  mfaLockMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(168)
  invitationTtlHours?: number;
}

export class CreateOrganizationDto {
  @IsString()
  @Length(2, 64)
  @Matches(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/)
  code!: string;

  @IsString()
  @Length(2, 200)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentOrganizationId?: string;
}

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @Length(2, 200)
  name?: string;

  @IsOptional()
  @IsUUID()
  parentOrganizationId?: string | null;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

export class UpsertOrganizationMembershipDto {
  @IsIn(['organization_admin', 'organization_member'])
  roleCode!: 'organization_admin' | 'organization_member';

  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string | null;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}

export class CreateGroupDto {
  @IsString()
  @Length(2, 160)
  name!: string;

  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @IsOptional()
  @IsIn(['DEPARTMENT', 'PROJECT', 'CUSTOM'])
  type?: 'DEPARTMENT' | 'PROJECT' | 'CUSTOM';
}

export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @Length(2, 160)
  name?: string;

  @IsOptional()
  @IsIn(['DEPARTMENT', 'PROJECT', 'CUSTOM'])
  type?: 'DEPARTMENT' | 'PROJECT' | 'CUSTOM';

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';
}
