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

The root scripts are tuned for this 8 GB workstation. `build`, `typecheck`, and `test` run Turbo
with one task at a time; the installed Turbo version no longer starts a background daemon. API and
Worker development processes have a 384 MB Node.js old-space limit, while Vite has a 512 MB limit.

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

`pnpm dev` is the default low-memory profile. It serially builds the shared packages, API, and
Worker without performing an unnecessary Web production build, then runs only three long-lived
processes: the compiled API, the compiled lightweight Worker, and Vite. Backend source changes are
not rebuilt automatically in this profile; stop the command and run `pnpm dev` again.

Backend hot reload is explicitly opt-in:

```powershell
pnpm dev:watch
```

This starts TypeScript and Node watchers for both backend applications in addition to Vite. It is
materially heavier and should be used only for a focused editing session. Return to `pnpm dev`
afterward.

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
`ASSET_PROCESSING_MODE=local-bypass`. Start the API, Web console, and lightweight maintenance
Worker with `pnpm dev`. Processing jobs stay disabled in this mode, but lifecycle maintenance still
runs in the Worker.

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

Restart `pnpm dev` after changing the mode. To run only the Worker for focused diagnosis, use a
second terminal:

```powershell
pnpm dev:worker
```

Use `pnpm dev:worker:watch` only when Worker source hot reload is required.

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

## Low-memory verification

Stop `pnpm dev` or `pnpm dev:watch` before running build, type checking, tests, or browser checks.
Run heavy commands sequentially, never in parallel:

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Do not keep Playwright or a browser verification process running while these commands execute. Stop
optional Docker profiles first if Windows is already under memory pressure. Vitest is configured to
use one worker and disables file-level parallelism in every workspace package.

### Local integration tests

The local integration suite requires the PostgreSQL, Redis, and MinIO base containers to be running
before the command starts. Prepare a dedicated database once, then deploy migrations and seed its
reference roles without changing the normal development database:

```powershell
pnpm infra:up
docker compose exec postgres createdb -U dam dam_integration
$env:DATABASE_URL = 'postgresql://dam:dam_local_password@localhost:5433/dam_integration?schema=public'
pnpm --filter @dam/database migrate:deploy
pnpm --filter @dam/database seed
Remove-Item Env:DATABASE_URL
```

Keep both URLs and both MinIO bucket names in the repository root `.env` as shown in `.env.example`.
The integration database URL must use `localhost`, `127.0.0.1`, or `::1`, its database name must
contain `test` or `integration`, and it must point to a different database from `DATABASE_URL`.
`MINIO_ENDPOINT` is also restricted to those loopback hosts. `DAM_INTEGRATION_MINIO_BUCKET` must
contain `test` or `integration` and differ from `MINIO_BUCKET`; `minio-init` creates both buckets
idempotently and never deletes or empties them. Then run:

```powershell
pnpm test:integration:local
```

`test:integration:local` loads the repository root `.env` and runs all nine integration specs:
Identity, Tenant, Space, Asset, Discovery, Processing, Lifecycle, Reconciliation, and Maintenance. They run strictly
one at a time after a single-concurrency shared-package build. The runner forces every spec to use
`DAM_INTEGRATION_DATABASE_URL` as `DATABASE_URL` and `DAM_INTEGRATION_MINIO_BUCKET` as
`MINIO_BUCKET`, injects the internal safety sentinel, and stops at the first failure. Directly
enabling an integration spec is blocked; always use the root command so the database and object
storage safety checks run first. Each child process uses a 384 MB Node.js old-space limit unless
`NODE_OPTIONS` already contains a caller-defined limit. The runner itself does not start or stop
Docker, create a database, deploy migrations, seed data, reset the database, or delete object storage
contents. Do not run another build, test, Worker, Playwright, or browser verification command
alongside this suite on the 8 GB workstation.

## Shutdown

```powershell
pnpm infra:down
```

Named volumes are retained. Use `docker compose down --volumes` only when intentionally
destroying all local DAM data.
