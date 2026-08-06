import { Transform } from 'class-transformer';
import {
  IsInt,
  IsMimeType,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class NodePageQueryDto {
  @IsOptional()
  @IsUUID()
  parentId?: string;

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

export class RecyclePageQueryDto {
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

export class CreateFolderDto {
  @IsString()
  @Length(1, 255)
  name!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateNodeDto {
  @IsOptional()
  @IsString()
  @Length(1, 255)
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  lockVersion!: number;
}

export class NodeVersionDto {
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  lockVersion!: number;
}

export class CreateUploadSessionDto {
  @IsOptional()
  @IsUUID()
  targetFolderId?: string;

  @IsOptional()
  @IsUUID()
  assetId?: string;

  @IsString()
  @Length(1, 255)
  fileName!: string;

  @IsString()
  @Matches(/^\d+$/)
  sizeBytes!: string;

  @IsMimeType()
  @Length(1, 255)
  mimeType!: string;

  @IsOptional()
  @Matches(/^[a-fA-F0-9]{64}$/)
  checksumSha256?: string;
}

export class RecordUploadPartDto {
  @IsString()
  @Length(32, 130)
  @Matches(/^"?[a-fA-F0-9]{32}(?:-\d+)?"?$/)
  etag!: string;

  @IsString()
  @Matches(/^\d+$/)
  sizeBytes!: string;
}

export class SetCurrentVersionDto {
  @IsUUID()
  versionId!: string;
}
