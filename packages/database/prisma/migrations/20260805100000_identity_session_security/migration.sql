ALTER TABLE "mfa_methods"
ADD COLUMN "last_used_time_step" BIGINT;

ALTER TABLE "auth_sessions"
ADD COLUMN "mfa_failed_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "mfa_locked_until" TIMESTAMPTZ(3);
