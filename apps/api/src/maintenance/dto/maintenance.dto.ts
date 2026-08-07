import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';

export class MaintenanceJobPageQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsIn(['PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED'])
  status?: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'DEAD' | 'CANCELLED';

  @IsOptional()
  @IsIn([
    'EXPIRE_UPLOAD_SESSION',
    'RETENTION_WARNING',
    'PURGE_DELETION_BATCH',
    'DELETE_STORAGE_OBJECT',
    'PRUNE_NOTIFICATIONS',
    'PRUNE_COMPLETED_JOBS',
    'RECONCILE_STORAGE_STEP',
  ])
  jobType?:
    | 'EXPIRE_UPLOAD_SESSION'
    | 'RETENTION_WARNING'
    | 'PURGE_DELETION_BATCH'
    | 'DELETE_STORAGE_OBJECT'
    | 'PRUNE_NOTIFICATIONS'
    | 'PRUNE_COMPLETED_JOBS'
    | 'RECONCILE_STORAGE_STEP';

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class CreateStorageReconciliationRunDto {
  @IsOptional()
  @IsUUID()
  sourceRunId?: string;
}

export class StorageReconciliationRunPageQueryDto {
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @IsOptional()
  @IsIn(['QUEUED', 'RUNNING', 'RETRYING', 'SUCCEEDED', 'FAILED'])
  status?: 'QUEUED' | 'RUNNING' | 'RETRYING' | 'SUCCEEDED' | 'FAILED';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class StorageReconciliationIssuePageQueryDto {
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  cursor?: string;

  @IsOptional()
  @IsIn(['DATABASE_OBJECT_MISSING', 'STORAGE_OBJECT_UNKNOWN'])
  issueType?: 'DATABASE_OBJECT_MISSING' | 'STORAGE_OBJECT_UNKNOWN';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}
