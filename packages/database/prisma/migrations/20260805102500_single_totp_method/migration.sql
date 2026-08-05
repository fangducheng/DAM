CREATE UNIQUE INDEX "mfa_methods_user_id_type_key"
ON "mfa_methods"("user_id", "type");
