-- CreateEnum
CREATE TYPE "SpaceOwnerType" AS ENUM ('TENANT', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "InvitationType" AS ENUM ('TENANT_ADMIN', 'ORGANIZATION_MEMBER');

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_fkey";

-- DropIndex
DROP INDEX "groups_organization_id_name_key";

-- DropIndex
DROP INDEX "organizations_code_key";

-- DropIndex
DROP INDEX "roles_organization_id_code_key";

-- DropIndex
DROP INDEX "spaces_code_key";

-- DropIndex
DROP INDEX "users_email_key";

-- DropIndex
DROP INDEX "users_login_name_key";

-- DropIndex
DROP INDEX "users_organization_id_status_idx";

-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "auth_sessions" ADD COLUMN     "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "mfa_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "replaced_by_id" UUID,
ADD COLUMN     "revoked_reason" VARCHAR(120),
ADD COLUMN     "token_family_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "tenant_id" UUID NOT NULL,
ALTER COLUMN "organization_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "parent_organization_id" UUID,
ADD COLUMN     "tenant_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "resource_acl_entries" ADD COLUMN     "tenant_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "role_bindings" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "roles" ADD COLUMN     "tenant_id" UUID;

-- AlterTable
ALTER TABLE "spaces" ADD COLUMN     "owner_type" "SpaceOwnerType" NOT NULL,
ADD COLUMN     "tenant_id" UUID NOT NULL,
ALTER COLUMN "owner_organization_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "organization_id",
ADD COLUMN     "tenant_id" UUID NOT NULL;

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorization_version" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_security_policies" (
    "tenant_id" UUID NOT NULL,
    "require_admin_mfa" BOOLEAN NOT NULL DEFAULT true,
    "require_member_mfa" BOOLEAN NOT NULL DEFAULT false,
    "access_token_ttl_minutes" INTEGER NOT NULL DEFAULT 15,
    "refresh_token_ttl_days" INTEGER NOT NULL DEFAULT 30,
    "max_password_attempts" INTEGER NOT NULL DEFAULT 5,
    "password_lock_minutes" INTEGER NOT NULL DEFAULT 15,
    "max_mfa_attempts" INTEGER NOT NULL DEFAULT 5,
    "mfa_lock_minutes" INTEGER NOT NULL DEFAULT 15,
    "invitation_ttl_hours" INTEGER NOT NULL DEFAULT 24,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_security_policies_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(160),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "status" "RecordStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("organization_id","user_id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "mfa_method_id" UUID NOT NULL,
    "code_hash" VARCHAR(255) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "tenant_id" UUID NOT NULL,
    "organization_id" UUID,
    "initial_role_id" UUID,
    "invited_by_id" UUID NOT NULL,
    "accepted_by_user_id" UUID,
    "type" "InvitationType" NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "login_name" VARCHAR(100),
    "display_name" VARCHAR(160),
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_code_key" ON "tenants"("code");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_status_idx" ON "organization_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_mfa_method_id_used_at_idx" ON "mfa_recovery_codes"("mfa_method_id", "used_at");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_tenant_id_email_expires_at_idx" ON "invitations"("tenant_id", "email", "expires_at");

-- CreateIndex
CREATE INDEX "invitations_organization_id_expires_at_idx" ON "invitations"("organization_id", "expires_at");

-- CreateIndex
CREATE INDEX "audit_events_tenant_id_occurred_at_idx" ON "audit_events"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_replaced_by_id_key" ON "auth_sessions"("replaced_by_id");

-- CreateIndex
CREATE INDEX "auth_sessions_token_family_id_revoked_at_idx" ON "auth_sessions"("token_family_id", "revoked_at");

-- CreateIndex
CREATE INDEX "groups_tenant_id_type_idx" ON "groups"("tenant_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "groups_tenant_id_organization_id_name_key" ON "groups"("tenant_id", "organization_id", "name");

-- CreateIndex
CREATE INDEX "organizations_tenant_id_status_idx" ON "organizations"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "organizations_parent_organization_id_idx" ON "organizations"("parent_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_tenant_id_code_key" ON "organizations"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "resource_acl_entries_tenant_id_resource_node_id_idx" ON "resource_acl_entries"("tenant_id", "resource_node_id");

-- CreateIndex
CREATE INDEX "role_bindings_tenant_id_scope_type_scope_id_idx" ON "role_bindings"("tenant_id", "scope_type", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE INDEX "roles_tenant_id_organization_id_idx" ON "roles"("tenant_id", "organization_id");

-- CreateIndex
CREATE INDEX "spaces_tenant_id_status_idx" ON "spaces"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_tenant_id_code_key" ON "spaces"("tenant_id", "code");

-- CreateIndex
CREATE INDEX "users_tenant_id_status_idx" ON "users"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_login_name_key" ON "users"("tenant_id", "login_name");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- AddForeignKey
ALTER TABLE "tenant_security_policies" ADD CONSTRAINT "tenant_security_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_parent_organization_id_fkey" FOREIGN KEY ("parent_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_mfa_method_id_fkey" FOREIGN KEY ("mfa_method_id") REFERENCES "mfa_methods"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_initial_role_id_fkey" FOREIGN KEY ("initial_role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_acl_entries" ADD CONSTRAINT "resource_acl_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Prisma cannot express partial indexes or cross-table Tenant invariants. Keep
-- these constraints in SQL so invalid authorization data cannot bypass the API.
CREATE UNIQUE INDEX "groups_tenant_name_key"
ON "groups"("tenant_id", "name")
WHERE "organization_id" IS NULL;

CREATE UNIQUE INDEX "organization_memberships_active_primary_key"
ON "organization_memberships"("user_id")
WHERE "is_primary" = true AND "status" = 'ACTIVE';

ALTER TABLE "spaces"
ADD CONSTRAINT "spaces_owner_type_check" CHECK (
  ("owner_type" = 'TENANT' AND "owner_organization_id" IS NULL)
  OR
  ("owner_type" = 'ORGANIZATION' AND "owner_organization_id" IS NOT NULL)
);

ALTER TABLE "roles"
ADD CONSTRAINT "roles_owner_check" CHECK (
  "organization_id" IS NULL OR "tenant_id" IS NOT NULL
);

ALTER TABLE "role_bindings"
ADD CONSTRAINT "role_bindings_scope_check" CHECK (
  ("scope_type" = 'PLATFORM' AND "tenant_id" IS NULL AND "scope_id" IS NULL)
  OR
  ("scope_type" = 'TENANT' AND "tenant_id" IS NOT NULL AND "scope_id" = "tenant_id")
  OR
  ("scope_type" IN ('ORGANIZATION', 'SPACE') AND "tenant_id" IS NOT NULL AND "scope_id" IS NOT NULL)
);

ALTER TABLE "invitations"
ADD CONSTRAINT "invitations_type_check" CHECK (
  ("type" = 'TENANT_ADMIN' AND "organization_id" IS NULL)
  OR
  ("type" = 'ORGANIZATION_MEMBER' AND "organization_id" IS NOT NULL)
);

CREATE FUNCTION resolve_principal_tenant(
  principal_type "PrincipalType",
  principal_id UUID
) RETURNS UUID AS $$
DECLARE
  resolved_tenant_id UUID;
BEGIN
  CASE principal_type
    WHEN 'USER' THEN
      SELECT "tenant_id" INTO resolved_tenant_id FROM "users" WHERE "id" = principal_id;
    WHEN 'GROUP' THEN
      SELECT "tenant_id" INTO resolved_tenant_id FROM "groups" WHERE "id" = principal_id;
    WHEN 'ORGANIZATION' THEN
      SELECT "tenant_id" INTO resolved_tenant_id FROM "organizations" WHERE "id" = principal_id;
  END CASE;

  IF resolved_tenant_id IS NULL THEN
    RAISE EXCEPTION 'authorization principal % (%) does not exist', principal_type, principal_id
      USING ERRCODE = '23503';
  END IF;

  RETURN resolved_tenant_id;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION resolve_resource_tenant(resource_node_id UUID) RETURNS UUID AS $$
DECLARE
  resolved_tenant_id UUID;
BEGIN
  SELECT space."tenant_id"
  INTO resolved_tenant_id
  FROM "resource_nodes" node
  JOIN "spaces" space ON space."id" = node."space_id"
  WHERE node."id" = resource_node_id;

  IF resolved_tenant_id IS NULL THEN
    RAISE EXCEPTION 'resource node % does not exist', resource_node_id
      USING ERRCODE = '23503';
  END IF;

  RETURN resolved_tenant_id;
END;
$$ LANGUAGE plpgsql STABLE;

CREATE FUNCTION enforce_organization_tenant_boundary() RETURNS trigger AS $$
DECLARE
  parent_tenant_id UUID;
BEGIN
  IF NEW."parent_organization_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."parent_organization_id" = NEW."id" THEN
    RAISE EXCEPTION 'organization cannot be its own parent' USING ERRCODE = '23514';
  END IF;

  SELECT "tenant_id" INTO parent_tenant_id
  FROM "organizations" WHERE "id" = NEW."parent_organization_id";

  IF parent_tenant_id IS NULL OR parent_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'organization parent must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organizations_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "parent_organization_id" ON "organizations"
FOR EACH ROW EXECUTE FUNCTION enforce_organization_tenant_boundary();

CREATE FUNCTION enforce_membership_tenant_boundary() RETURNS trigger AS $$
DECLARE
  organization_tenant_id UUID;
  user_tenant_id UUID;
BEGIN
  SELECT "tenant_id" INTO organization_tenant_id
  FROM "organizations" WHERE "id" = NEW."organization_id";
  SELECT "tenant_id" INTO user_tenant_id
  FROM "users" WHERE "id" = NEW."user_id";

  IF organization_tenant_id IS NULL OR user_tenant_id IS NULL
     OR organization_tenant_id IS DISTINCT FROM user_tenant_id THEN
    RAISE EXCEPTION 'organization membership must stay within one Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organization_memberships_tenant_boundary"
BEFORE INSERT OR UPDATE OF "organization_id", "user_id" ON "organization_memberships"
FOR EACH ROW EXECUTE FUNCTION enforce_membership_tenant_boundary();

CREATE FUNCTION enforce_group_tenant_boundary() RETURNS trigger AS $$
DECLARE
  organization_tenant_id UUID;
BEGIN
  IF NEW."organization_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "tenant_id" INTO organization_tenant_id
  FROM "organizations" WHERE "id" = NEW."organization_id";

  IF organization_tenant_id IS NULL
     OR organization_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'group organization must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "groups_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "organization_id" ON "groups"
FOR EACH ROW EXECUTE FUNCTION enforce_group_tenant_boundary();

CREATE FUNCTION enforce_group_member_tenant_boundary() RETURNS trigger AS $$
DECLARE
  group_tenant_id UUID;
  user_tenant_id UUID;
BEGIN
  SELECT "tenant_id" INTO group_tenant_id FROM "groups" WHERE "id" = NEW."group_id";
  SELECT "tenant_id" INTO user_tenant_id FROM "users" WHERE "id" = NEW."user_id";

  IF group_tenant_id IS NULL OR user_tenant_id IS NULL
     OR group_tenant_id IS DISTINCT FROM user_tenant_id THEN
    RAISE EXCEPTION 'group member must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "group_members_tenant_boundary"
BEFORE INSERT OR UPDATE OF "group_id", "user_id" ON "group_members"
FOR EACH ROW EXECUTE FUNCTION enforce_group_member_tenant_boundary();

CREATE FUNCTION enforce_role_tenant_boundary() RETURNS trigger AS $$
DECLARE
  organization_tenant_id UUID;
BEGIN
  IF NEW."organization_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "tenant_id" INTO organization_tenant_id
  FROM "organizations" WHERE "id" = NEW."organization_id";

  IF organization_tenant_id IS NULL
     OR organization_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'role organization must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "roles_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "organization_id" ON "roles"
FOR EACH ROW EXECUTE FUNCTION enforce_role_tenant_boundary();

CREATE FUNCTION enforce_space_tenant_boundary() RETURNS trigger AS $$
DECLARE
  related_tenant_id UUID;
BEGIN
  IF NEW."owner_organization_id" IS NOT NULL THEN
    SELECT "tenant_id" INTO related_tenant_id
    FROM "organizations" WHERE "id" = NEW."owner_organization_id";

    IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
      RAISE EXCEPTION 'space owner organization must belong to the same Tenant'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT "tenant_id" INTO related_tenant_id
  FROM "users" WHERE "id" = NEW."created_by_id";

  IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'space creator must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "spaces_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "owner_organization_id", "created_by_id" ON "spaces"
FOR EACH ROW EXECUTE FUNCTION enforce_space_tenant_boundary();

CREATE FUNCTION enforce_role_binding_tenant_boundary() RETURNS trigger AS $$
DECLARE
  related_tenant_id UUID;
  role_tenant_id UUID;
  role_is_system BOOLEAN;
BEGIN
  SELECT "tenant_id", "is_system"
  INTO role_tenant_id, role_is_system
  FROM "roles" WHERE "id" = NEW."role_id";

  IF role_is_system IS NULL THEN
    RAISE EXCEPTION 'role % does not exist', NEW."role_id" USING ERRCODE = '23503';
  END IF;

  IF role_tenant_id IS NOT NULL AND role_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'role binding role must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  IF role_tenant_id IS NULL AND role_is_system = false THEN
    RAISE EXCEPTION 'global role bindings require a system role'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."scope_type" = 'PLATFORM' THEN
    RETURN NEW;
  END IF;

  related_tenant_id := resolve_principal_tenant(NEW."principal_type", NEW."principal_id");
  IF related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'role binding principal must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."scope_type" = 'ORGANIZATION' THEN
    SELECT "tenant_id" INTO related_tenant_id
    FROM "organizations" WHERE "id" = NEW."scope_id";
  ELSIF NEW."scope_type" = 'SPACE' THEN
    SELECT "tenant_id" INTO related_tenant_id
    FROM "spaces" WHERE "id" = NEW."scope_id";
  ELSE
    related_tenant_id := NEW."tenant_id";
  END IF;

  IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'role binding scope must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "role_bindings_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "role_id", "principal_type", "principal_id", "scope_type", "scope_id" ON "role_bindings"
FOR EACH ROW EXECUTE FUNCTION enforce_role_binding_tenant_boundary();

CREATE FUNCTION enforce_space_member_tenant_boundary() RETURNS trigger AS $$
DECLARE
  space_tenant_id UUID;
  role_tenant_id UUID;
  role_is_system BOOLEAN;
BEGIN
  SELECT "tenant_id" INTO space_tenant_id FROM "spaces" WHERE "id" = NEW."space_id";

  IF space_tenant_id IS NULL
     OR resolve_principal_tenant(NEW."principal_type", NEW."principal_id") IS DISTINCT FROM space_tenant_id THEN
    RAISE EXCEPTION 'space member must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  SELECT "tenant_id", "is_system"
  INTO role_tenant_id, role_is_system
  FROM "roles" WHERE "id" = NEW."role_id";

  IF role_is_system IS NULL
     OR (role_tenant_id IS NULL AND role_is_system = false)
     OR (role_tenant_id IS NOT NULL AND role_tenant_id IS DISTINCT FROM space_tenant_id) THEN
    RAISE EXCEPTION 'space member role must be global system role or belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "space_members_tenant_boundary"
BEFORE INSERT OR UPDATE OF "space_id", "principal_type", "principal_id", "role_id" ON "space_members"
FOR EACH ROW EXECUTE FUNCTION enforce_space_member_tenant_boundary();

CREATE FUNCTION enforce_acl_tenant_boundary() RETURNS trigger AS $$
DECLARE
  related_tenant_id UUID;
BEGIN
  related_tenant_id := resolve_resource_tenant(NEW."resource_node_id");
  IF related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'ACL resource must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  related_tenant_id := resolve_principal_tenant(NEW."principal_type", NEW."principal_id");
  IF related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'ACL principal must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  SELECT "tenant_id" INTO related_tenant_id
  FROM "users" WHERE "id" = NEW."created_by_id";
  IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'ACL creator must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "resource_acl_entries_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "resource_node_id", "principal_type", "principal_id", "created_by_id" ON "resource_acl_entries"
FOR EACH ROW EXECUTE FUNCTION enforce_acl_tenant_boundary();

CREATE FUNCTION enforce_invitation_tenant_boundary() RETURNS trigger AS $$
DECLARE
  related_tenant_id UUID;
  role_tenant_id UUID;
  role_is_system BOOLEAN;
BEGIN
  IF NEW."organization_id" IS NOT NULL THEN
    SELECT "tenant_id" INTO related_tenant_id
    FROM "organizations" WHERE "id" = NEW."organization_id";
    IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
      RAISE EXCEPTION 'invitation organization must belong to the same Tenant'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT "tenant_id" INTO related_tenant_id
  FROM "users" WHERE "id" = NEW."invited_by_id";
  IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
    RAISE EXCEPTION 'invitation sender must belong to the same Tenant'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."accepted_by_user_id" IS NOT NULL THEN
    SELECT "tenant_id" INTO related_tenant_id
    FROM "users" WHERE "id" = NEW."accepted_by_user_id";
    IF related_tenant_id IS NULL OR related_tenant_id IS DISTINCT FROM NEW."tenant_id" THEN
      RAISE EXCEPTION 'invitation recipient must belong to the same Tenant'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."initial_role_id" IS NOT NULL THEN
    SELECT "tenant_id", "is_system"
    INTO role_tenant_id, role_is_system
    FROM "roles" WHERE "id" = NEW."initial_role_id";
    IF role_is_system IS NULL
       OR (role_tenant_id IS NULL AND role_is_system = false)
       OR (role_tenant_id IS NOT NULL AND role_tenant_id IS DISTINCT FROM NEW."tenant_id") THEN
      RAISE EXCEPTION 'invitation role must be global system role or belong to the same Tenant'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "invitations_tenant_boundary"
BEFORE INSERT OR UPDATE OF "tenant_id", "organization_id", "initial_role_id", "invited_by_id", "accepted_by_user_id" ON "invitations"
FOR EACH ROW EXECUTE FUNCTION enforce_invitation_tenant_boundary();

-- Tenant reassignment would invalidate dependent authorization rows without
-- firing their triggers, so Tenant ownership is immutable after creation.
CREATE FUNCTION prevent_tenant_reassignment() RETURNS trigger AS $$
BEGIN
  IF NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id" THEN
    RAISE EXCEPTION 'Tenant ownership cannot be reassigned'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "organizations_tenant_immutable"
BEFORE UPDATE OF "tenant_id" ON "organizations"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

CREATE TRIGGER "users_tenant_immutable"
BEFORE UPDATE OF "tenant_id" ON "users"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

CREATE TRIGGER "groups_tenant_immutable"
BEFORE UPDATE OF "tenant_id" ON "groups"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

CREATE TRIGGER "roles_tenant_immutable"
BEFORE UPDATE OF "tenant_id" ON "roles"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

CREATE TRIGGER "spaces_tenant_immutable"
BEFORE UPDATE OF "tenant_id" ON "spaces"
FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();
