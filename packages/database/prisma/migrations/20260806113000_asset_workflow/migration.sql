ALTER TYPE "ScanStatus" ADD VALUE 'SKIPPED';

ALTER TABLE "resource_nodes"
ADD COLUMN "is_root" BOOLEAN NOT NULL DEFAULT false;

UPDATE "resource_nodes" AS node
SET "is_root" = true
FROM (
  SELECT DISTINCT ON ("space_id") "id"
  FROM "resource_nodes"
  WHERE "parent_id" IS NULL
    AND "node_type" = 'FOLDER'
    AND "status" = 'ACTIVE'
  ORDER BY "space_id", "created_at", "id"
) AS existing_root
WHERE node."id" = existing_root."id";

WITH inserted_roots AS (
  INSERT INTO "resource_nodes" (
    "id",
    "space_id",
    "parent_id",
    "node_type",
    "name",
    "normalized_name",
    "is_root",
    "status",
    "created_by_id",
    "created_at",
    "updated_at"
  )
  SELECT
    uuidv7(),
    space."id",
    NULL,
    'FOLDER',
    space."name",
    '__root__',
    true,
    'ACTIVE',
    space."created_by_id",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
  FROM "spaces" AS space
  WHERE NOT EXISTS (
    SELECT 1
    FROM "resource_nodes" AS root
    WHERE root."space_id" = space."id" AND root."is_root" = true
  )
  RETURNING "id"
)
INSERT INTO "resource_closure" ("ancestor_id", "descendant_id", "depth")
SELECT "id", "id", 0
FROM inserted_roots;

INSERT INTO "resource_closure" ("ancestor_id", "descendant_id", "depth")
SELECT "id", "id", 0
FROM "resource_nodes"
WHERE "is_root" = true
ON CONFLICT ("ancestor_id", "descendant_id") DO NOTHING;

ALTER TABLE "resource_nodes"
ADD CONSTRAINT "resource_nodes_root_shape_check"
CHECK (NOT "is_root" OR ("parent_id" IS NULL AND "node_type" = 'FOLDER'));

CREATE UNIQUE INDEX "resource_nodes_one_root_per_space_key"
ON "resource_nodes" ("space_id")
WHERE "is_root" = true;

CREATE UNIQUE INDEX "resource_nodes_active_sibling_name_key"
ON "resource_nodes" ("space_id", "parent_id", "normalized_name") NULLS NOT DISTINCT
WHERE "status" IN ('ACTIVE', 'QUARANTINED');

CREATE INDEX "resource_nodes_space_id_is_root_idx"
ON "resource_nodes" ("space_id", "is_root");

ALTER TABLE "upload_sessions"
ADD COLUMN "asset_id" UUID;

CREATE TABLE "upload_parts" (
  "upload_session_id" UUID NOT NULL,
  "part_number" INTEGER NOT NULL,
  "etag" VARCHAR(128) NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "upload_parts_pkey" PRIMARY KEY ("upload_session_id", "part_number")
);

ALTER TABLE "upload_sessions"
ADD CONSTRAINT "upload_sessions_asset_id_fkey"
FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "upload_parts"
ADD CONSTRAINT "upload_parts_upload_session_id_fkey"
FOREIGN KEY ("upload_session_id") REFERENCES "upload_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
