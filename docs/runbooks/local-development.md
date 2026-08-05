# Local Development Runbook

## Runtime profile

The workstation has 8 GB RAM and Docker is limited to roughly 4 GB. Keep the default profile
small:

```powershell
pnpm infra:up
```

This starts PostgreSQL on host port `5433`, Redis on `6379`, and MinIO on `9000/9001`.
RabbitMQ is opt-in:

```powershell
docker compose --profile full up -d
```

ClamAV is intentionally isolated because its signature database is memory intensive:

```powershell
docker compose --profile processing up -d clamav
```

Do not run the processing and observability profiles together on this workstation.

## First start

```powershell
Copy-Item .env.example .env
pnpm install
pnpm infra:up
pnpm --filter @dam/database migrate:deploy
pnpm --filter @dam/database seed
pnpm identity:bootstrap
pnpm dev
```

`identity:bootstrap` idempotently creates the local Tenant, first organization, and administrator.
For an inactive administrator it prints a one-time invitation URL. Complete that invitation to
set the password, bind TOTP, and record the recovery codes; rerunning the command after activation
returns `alreadyActive: true` without changing credentials.

Verify:

```powershell
Invoke-RestMethod http://localhost:3000/api/v1/health/live
Invoke-RestMethod http://localhost:3000/api/v1/health/ready
```

Swagger is available at `http://localhost:3000/api/docs`. Identity endpoints use an in-memory
Bearer Access Token and a rotating `HttpOnly`, `SameSite=Lax` Refresh Cookie. Local HTTP uses
`COOKIE_SECURE=false`; production configuration rejects local default secrets and requires
`COOKIE_SECURE=true`.

## Common failures

- Port `5432` belongs to another local project. DAM deliberately uses `5433`.
- A degraded readiness response identifies the unavailable dependency and connection error.
- If Docker memory pressure is high, stop optional profiles before restarting Docker Desktop.
- If a Refresh Token is replayed, all sessions in that token family are revoked and the event is
  written to the audit log. Log in again instead of retrying the old cookie.
- Never reuse `.env.example` credentials outside the local workstation.

## Shutdown

```powershell
pnpm infra:down
```

Named volumes are retained. Use `docker compose down --volumes` only when intentionally
destroying all local DAM data.
