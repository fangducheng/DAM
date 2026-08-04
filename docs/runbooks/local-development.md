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
pnpm db:migrate
pnpm dev
```

Verify:

```powershell
Invoke-RestMethod http://localhost:3000/api/v1/health/live
Invoke-RestMethod http://localhost:3000/api/v1/health/ready
```

## Common failures

- Port `5432` belongs to another local project. DAM deliberately uses `5433`.
- A degraded readiness response identifies the unavailable dependency and connection error.
- If Docker memory pressure is high, stop optional profiles before restarting Docker Desktop.
- Never reuse `.env.example` credentials outside the local workstation.

## Shutdown

```powershell
pnpm infra:down
```

Named volumes are retained. Use `docker compose down --volumes` only when intentionally
destroying all local DAM data.
