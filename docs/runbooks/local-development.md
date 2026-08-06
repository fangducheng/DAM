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

Browser uploads use MinIO multipart URLs directly, so the local MinIO container allows only the
configured localhost Web origins through `MINIO_API_CORS_ALLOW_ORIGIN`. The default
`ASSET_PROCESSING_MODE=local-bypass` keeps the core workflow usable without ClamAV on this 8 GB
workstation and records versions with scan status `SKIPPED`. It never records a bypassed file as
`CLEAN`, and production environment validation rejects this mode. Use `deferred` whenever files
must remain quarantined for a processing worker.

## Asset processing modes

The default local profile keeps `PROCESSING_WORKER_ENABLED=false`, `CLAMAV_ENABLED=false`, and
`ASSET_PROCESSING_MODE=local-bypass`. Start the API and Web console with `pnpm dev`; a separate
worker is unnecessary in this mode.

To exercise fail-closed processing locally, start ClamAV and change the matching values in `.env`:

```powershell
docker compose --profile processing up -d clamav
```

```dotenv
ASSET_PROCESSING_MODE=deferred
PROCESSING_WORKER_ENABLED=true
CLAMAV_ENABLED=true
CLAMAV_HOST=127.0.0.1
```

Restart the API after changing the mode, then run the worker in a second terminal:

```powershell
pnpm dev:worker
```

The worker reads source objects as streams and uses PostgreSQL `processing_jobs` as its local
reliable queue. A file remains quarantined until ClamAV explicitly returns `CLEAN`. Timeouts,
unavailable processors, malformed responses, and terminal scan errors never publish the file.
Content extraction uses the bounded built-in text parser by default. Enable `TIKA_ENABLED` only
when a Tika service is running at `TIKA_ENDPOINT`; unsupported extraction or preview formats do not
make an already clean source unavailable.

## Common failures

- Port `5432` belongs to another local project. DAM deliberately uses `5433`.
- A degraded readiness response identifies the unavailable dependency and connection error.
- If Docker memory pressure is high, stop optional profiles before restarting Docker Desktop.
- If a Refresh Token is replayed, all sessions in that token family are revoked and the event is
  written to the audit log. Log in again instead of retrying the old cookie.
- If a deferred asset stays quarantined, confirm ClamAV is healthy and the worker process is
  running. The job is retried with exponential backoff and preserves its terminal error for
  administrator diagnosis.
- Never reuse `.env.example` credentials outside the local workstation.

## Shutdown

```powershell
pnpm infra:down
```

Named volumes are retained. Use `docker compose down --volumes` only when intentionally
destroying all local DAM data.
