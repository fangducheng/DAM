-- Shared groups are soft-disabled so polymorphic authorization references do
-- not become orphaned when a group is retired.
ALTER TABLE "groups"
ADD COLUMN "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE';

DROP INDEX "groups_tenant_id_type_idx";
CREATE INDEX "groups_tenant_id_status_type_idx"
ON "groups"("tenant_id", "status", "type");
