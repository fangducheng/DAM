ALTER TYPE "MaintenanceJobType" ADD VALUE 'RECONCILE_STORAGE_STEP';

CREATE TYPE "StorageReconciliationStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'RETRYING',
  'SUCCEEDED',
  'FAILED'
);

CREATE TYPE "StorageReconciliationPhase" AS ENUM (
  'DATABASE_SCAN',
  'STORAGE_SCAN',
  'FINALIZING',
  'COMPLETE'
);

CREATE TYPE "StorageReconciliationIssueType" AS ENUM (
  'DATABASE_OBJECT_MISSING',
  'STORAGE_OBJECT_UNKNOWN'
);

CREATE TABLE "storage_reconciliation_runs" (
  "id" UUID NOT NULL DEFAULT uuidv7(),
  "tenant_id" UUID NOT NULL,
  "requested_by_id" UUID,
  "source_run_id" UUID,
  "status" "StorageReconciliationStatus" NOT NULL DEFAULT 'QUEUED',
  "phase" "StorageReconciliationPhase" NOT NULL DEFAULT 'DATABASE_SCAN',
  "checkpoint_version" INTEGER NOT NULL DEFAULT 0,
  "database_cursor" UUID,
  "storage_cursor" VARCHAR(1024),
  "cutoff_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "database_objects" INTEGER NOT NULL DEFAULT 0,
  "storage_objects" INTEGER NOT NULL DEFAULT 0,
  "missing_objects" INTEGER NOT NULL DEFAULT 0,
  "unknown_objects" INTEGER NOT NULL DEFAULT 0,
  "last_checkpoint_at" TIMESTAMPTZ(3),
  "started_at" TIMESTAMPTZ(3),
  "completed_at" TIMESTAMPTZ(3),
  "error_code" VARCHAR(80),
  "error_message" VARCHAR(2000),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "storage_reconciliation_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "storage_reconciliation_issues" (
  "run_id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "issue_key" CHAR(64) NOT NULL,
  "issue_type" "StorageReconciliationIssueType" NOT NULL,
  "storage_object_id" UUID,
  "object_fingerprint" CHAR(64),
  "expected_size_bytes" BIGINT,
  "observed_size_bytes" BIGINT,
  "database_created_at" TIMESTAMPTZ(3),
  "last_modified_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reconciliation_issues_pkey" PRIMARY KEY ("run_id", "issue_key"),
  CONSTRAINT "reconciliation_issues_shape_check" CHECK (
    (
      "issue_type" = 'DATABASE_OBJECT_MISSING'
      AND "storage_object_id" IS NOT NULL
      AND "object_fingerprint" IS NULL
      AND "expected_size_bytes" IS NOT NULL
      AND "observed_size_bytes" IS NULL
      AND "database_created_at" IS NOT NULL
      AND "last_modified_at" IS NULL
    )
    OR
    (
      "issue_type" = 'STORAGE_OBJECT_UNKNOWN'
      AND "storage_object_id" IS NULL
      AND "object_fingerprint" IS NOT NULL
      AND "expected_size_bytes" IS NULL
      AND "observed_size_bytes" IS NOT NULL
      AND "database_created_at" IS NULL
      AND "last_modified_at" IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX "reconciliation_runs_id_tenant_key"
ON "storage_reconciliation_runs" ("id", "tenant_id");

CREATE INDEX "reconciliation_runs_tenant_id_idx"
ON "storage_reconciliation_runs" ("tenant_id", "id" DESC);

CREATE INDEX "reconciliation_runs_tenant_status_idx"
ON "storage_reconciliation_runs" ("tenant_id", "status", "updated_at");

CREATE UNIQUE INDEX "reconciliation_runs_one_active_per_tenant"
ON "storage_reconciliation_runs" ("tenant_id")
WHERE "status" IN ('QUEUED', 'RUNNING', 'RETRYING');

CREATE INDEX "reconciliation_issues_tenant_run_idx"
ON "storage_reconciliation_issues" ("tenant_id", "run_id", "issue_type", "issue_key");

ALTER TABLE "storage_reconciliation_runs"
ADD CONSTRAINT "storage_reconciliation_runs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
ADD CONSTRAINT "storage_reconciliation_runs_requested_by_id_fkey"
FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
ADD CONSTRAINT "storage_reconciliation_runs_source_run_id_fkey"
FOREIGN KEY ("source_run_id") REFERENCES "storage_reconciliation_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "storage_reconciliation_issues"
ADD CONSTRAINT "storage_reconciliation_issues_run_tenant_fkey"
FOREIGN KEY ("run_id", "tenant_id")
REFERENCES "storage_reconciliation_runs"("id", "tenant_id")
ON DELETE CASCADE ON UPDATE CASCADE;
