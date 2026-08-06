ALTER TABLE "tags"
ADD COLUMN "normalized_name" VARCHAR(100);

UPDATE "tags"
SET "normalized_name" = lower(btrim("name"));

ALTER TABLE "tags"
ALTER COLUMN "normalized_name" SET NOT NULL;

DROP INDEX "tags_space_id_name_key";

CREATE UNIQUE INDEX "tags_space_id_normalized_name_key"
ON "tags" ("space_id", "normalized_name");

ALTER TABLE "processing_jobs"
ADD COLUMN "locked_by" VARCHAR(120),
ADD COLUMN "lease_expires_at" TIMESTAMPTZ(3),
ADD COLUMN "completed_at" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "processing_jobs_asset_version_id_job_type_key"
ON "processing_jobs" ("asset_version_id", "job_type");

CREATE INDEX "processing_jobs_status_lease_expires_at_idx"
ON "processing_jobs" ("status", "lease_expires_at");

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "resource_nodes_normalized_name_trgm_idx"
ON "resource_nodes" USING GIN ("normalized_name" gin_trgm_ops);
