import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class LoginDto {
  @IsString()
  @Matches(/^[a-z0-9][a-z0-9_-]{1,63}$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  tenantCode!: string;

  @IsString()
  @MaxLength(320)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  identifier!: string;

  @IsString()
  @MaxLength(128)
  password!: string;
}

export class CompleteMfaDto {
  @IsString()
  @MinLength(20)
  challengeToken!: string;

  @IsString()
  @Length(6, 32)
  code!: string;
}

export enum InvitationDtoType {
  TenantAdmin = 'TENANT_ADMIN',
  OrganizationMember = 'ORGANIZATION_MEMBER',
}

export class CreateInvitationDto {
  @IsEnum(InvitationDtoType)
  type!: InvitationDtoType;

  @ValidateIf((input: CreateInvitationDto) => input.type === InvitationDtoType.OrganizationMember)
  @IsUUID()
  @IsOptional()
  organizationId?: string;

  @IsEmail()
  @MaxLength(320)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email!: string;

  @IsString()
  @Matches(/^[a-z0-9][a-z0-9._-]{1,99}$/)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  loginName!: string;

  @IsString()
  @Length(1, 160)
  displayName!: string;

  @IsIn(['platform_admin', 'organization_admin', 'organization_member'])
  initialRoleCode!: string;
}

export class AcceptInvitationDto {
  @IsString()
  @MinLength(20)
  token!: string;

  @IsString()
  @Length(12, 128)
  password!: string;
}

export class ConfirmInvitationMfaDto {
  @IsString()
  @MinLength(20)
  token!: string;

  @IsString()
  @Matches(/^\d{6}$/)
  code!: string;
}
