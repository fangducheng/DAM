ALTER TABLE "auth_sessions"
ADD COLUMN "authenticated_at" TIMESTAMPTZ(3);

UPDATE "auth_sessions"
SET "authenticated_at" = COALESCE("mfa_verified_at", "created_at")
WHERE "revoked_at" IS NULL;
