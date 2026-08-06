ALTER TABLE "resource_nodes"
ADD COLUMN "deletion_batch_id" UUID;

CREATE INDEX "resource_nodes_deletion_batch_id_idx"
ON "resource_nodes" ("deletion_batch_id");
