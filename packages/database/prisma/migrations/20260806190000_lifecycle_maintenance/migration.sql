ALTER TYPE "JobStatus" ADD VALUE 'CANCELLED';

CREATE TYPE "DeletionBatchStatus" AS ENUM (
  'RETAINED',
  'PURGE_REQUESTED',
  'PURGING',
  'PURGED',
  'FAILED',
  'RESTORED',
  'SUPERSEDED'
);

CREATE TYPE "MaintenanceJobType" AS ENUM (
  'EXPIRE_UPLOAD_SESSION',
  'RETENTION_WARNING',
  'PURGE_DELETION_BATCH',
  'DELETE_STORAGE_OBJECT',
  'PRUNE_NOTIFICATIONS',
  'PRUNE_COMPLETED_JOBS'
);

CREATE TABLE "deletion_batches" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "tenant_id" UUID NOT NULL,
  "space_id" UUID NOT NULL,
  "root_node_id" UUID NOT NULL,
  "root_name" VARCHAR(255) NOT NULL,
  "root_type" "NodeType" NOT NULL,
  "deleted_by_id" UUID,
  "deleted_at" TIMESTAMPTZ(3) NOT NULL,
  "purge_at" TIMESTAMPTZ(3) NOT NULL,
  "purge_requested_at" TIMESTAMPTZ(3),
  "purged_at" TIMESTAMPTZ(3),
  "restored_at" TIMESTAMPTZ(3),
  "item_count" INTEGER NOT NULL,
  "source_bytes" BIGINT NOT NULL DEFAULT 0,
  "released_bytes" BIGINT NOT NULL DEFAULT 0,
  "status" "DeletionBatchStatus" NOT NULL DEFAULT 'RETAINED',
  "error_message" VARCHAR(2000),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "deletion_batches_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "maintenance_jobs" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "tenant_id" UUID,
  "space_id" UUID,
  "job_type" "MaintenanceJobType" NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "target_id" UUID,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 8,
  "available_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMPTZ(3),
  "locked_by" VARCHAR(120),
  "lease_expires_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "error_message" VARCHAR(2000),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "maintenance_jobs_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notifications"
ADD COLUMN "archived_at" TIMESTAMPTZ(3);

WITH batch_roots AS (
  SELECT DISTINCT ON (node."deletion_batch_id")
    node."deletion_batch_id" AS "batch_id",
    node."space_id",
    node."id" AS "root_node_id",
    node."name" AS "root_name",
    node."node_type" AS "root_type",
    node."deleted_at"
  FROM "resource_nodes" AS node
  LEFT JOIN "resource_nodes" AS parent ON parent."id" = node."parent_id"
  WHERE node."deletion_batch_id" IS NOT NULL
    AND (parent."deletion_batch_id" IS DISTINCT FROM node."deletion_batch_id")
  ORDER BY node."deletion_batch_id", node."id"
),
batch_totals AS (
  SELECT
    node."deletion_batch_id" AS "batch_id",
    COUNT(DISTINCT node."id")::INTEGER AS "item_count",
    COALESCE(SUM(version."size_bytes"), 0)::BIGINT AS "source_bytes"
  FROM "resource_nodes" AS node
  LEFT JOIN "assets" AS asset ON asset."node_id" = node."id"
  LEFT JOIN "asset_versions" AS version ON version."asset_id" = asset."id"
  WHERE node."deletion_batch_id" IS NOT NULL
  GROUP BY node."deletion_batch_id"
)
INSERT INTO "deletion_batches" (
  "id",
  "tenant_id",
  "space_id",
  "root_node_id",
  "root_name",
  "root_type",
  "deleted_at",
  "purge_at",
  "item_count",
  "source_bytes"
)
SELECT
  root."batch_id",
  space."tenant_id",
  root."space_id",
  root."root_node_id",
  root."root_name",
  root."root_type",
  COALESCE(root."deleted_at", CURRENT_TIMESTAMP),
  COALESCE(root."deleted_at", CURRENT_TIMESTAMP) + INTERVAL '30 days',
  totals."item_count",
  totals."source_bytes"
FROM batch_roots AS root
JOIN batch_totals AS totals ON totals."batch_id" = root."batch_id"
JOIN "spaces" AS space ON space."id" = root."space_id";

DROP INDEX "resource_nodes_deletion_batch_id_idx";

CREATE UNIQUE INDEX "maintenance_jobs_idempotency_key_key"
ON "maintenance_jobs" ("idempotency_key");

CREATE INDEX "deletion_batches_tenant_id_status_purge_at_idx"
ON "deletion_batches" ("tenant_id", "status", "purge_at");

CREATE INDEX "deletion_batches_space_id_status_deleted_at_idx"
ON "deletion_batches" ("space_id", "status", "deleted_at");

CREATE INDEX "deletion_batches_root_node_id_idx"
ON "deletion_batches" ("root_node_id");

CREATE INDEX "resource_nodes_deletion_batch_id_idx"
ON "resource_nodes" ("deletion_batch_id");

CREATE INDEX "maintenance_jobs_status_available_at_idx"
ON "maintenance_jobs" ("status", "available_at");

CREATE INDEX "maintenance_jobs_status_lease_expires_at_idx"
ON "maintenance_jobs" ("status", "lease_expires_at");

CREATE INDEX "maintenance_jobs_tenant_id_status_updated_at_idx"
ON "maintenance_jobs" ("tenant_id", "status", "updated_at");

CREATE INDEX "maintenance_jobs_space_id_status_idx"
ON "maintenance_jobs" ("space_id", "status");

ALTER TABLE "deletion_batches"
ADD CONSTRAINT "deletion_batches_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "deletion_batches_space_id_fkey"
FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "deletion_batches_deleted_by_id_fkey"
FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "resource_nodes"
ADD CONSTRAINT "resource_nodes_deletion_batch_id_fkey"
FOREIGN KEY ("deletion_batch_id") REFERENCES "deletion_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "maintenance_jobs"
ADD CONSTRAINT "maintenance_jobs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "maintenance_jobs_space_id_fkey"
FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "upload_sessions"
DROP CONSTRAINT "upload_sessions_target_node_id_fkey",
ADD CONSTRAINT "upload_sessions_target_node_id_fkey"
FOREIGN KEY ("target_node_id") REFERENCES "resource_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE,
DROP CONSTRAINT "upload_sessions_asset_id_fkey",
ADD CONSTRAINT "upload_sessions_asset_id_fkey"
FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
