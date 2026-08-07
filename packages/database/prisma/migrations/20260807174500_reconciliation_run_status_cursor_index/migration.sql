DROP INDEX "reconciliation_runs_tenant_status_idx";

CREATE INDEX "reconciliation_runs_tenant_status_id_idx"
ON "storage_reconciliation_runs" ("tenant_id", "status", "id" DESC);
