import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsHexColor,
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

export class CreateTagDto {
  @IsString()
  @Length(1, 100)
  name!: string;

  @IsOptional()
  @IsHexColor()
  color?: string | null;
}

export class UpdateTagDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  name?: string;

  @IsOptional()
  @IsHexColor()
  color?: string | null;
}

export class AssignAssetTagsDto {
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsUUID(undefined, { each: true })
  tagIds!: string[];
}

export class SearchAssetsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  q?: string;

  @IsOptional()
  @Matches(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*)$/i)
  mimeType?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }): unknown =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(20)
  @IsUUID(undefined, { each: true })
  tagIds?: string[];
}

export class AuditPageQueryDto extends PageQueryDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  action?: string;

  @IsOptional()
  @IsUUID()
  actorUserId?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  resourceType?: string;

  @IsOptional()
  @IsUUID()
  resourceId?: string;

  @IsOptional()
  @IsIn(['SUCCEEDED', 'FAILED', 'DENIED'])
  result?: 'SUCCEEDED' | 'FAILED' | 'DENIED';

  @IsOptional()
  @IsISO8601({ strict: true })
  occurredFrom?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  occurredTo?: string;
}

export class NotificationPageQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(['UNREAD', 'READ', 'ARCHIVED'])
  status?: 'UNREAD' | 'READ' | 'ARCHIVED';
}

export class UpdateNotificationDto {
  @IsIn(['READ', 'ARCHIVED'])
  status!: 'READ' | 'ARCHIVED';
}
