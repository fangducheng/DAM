ALTER TABLE "auth_sessions"
ADD COLUMN "mfa_method" VARCHAR(20);

ALTER TABLE "auth_sessions"
ADD CONSTRAINT "auth_sessions_mfa_method_check" CHECK (
  "mfa_method" IS NULL OR "mfa_method" IN ('totp', 'recovery_code')
);
