# Enterprise DAM

Private enterprise digital asset management for controlled collaboration between organizations.

## Local prerequisites

- Node.js 24+
- pnpm 10+
- Docker Desktop with Linux containers

## Start the foundation stack

```powershell
Copy-Item .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

The web console runs at `http://localhost:5173`, the API at `http://localhost:3000`,
and OpenAPI documentation at `http://localhost:3000/api/docs`.

The local PostgreSQL host port is `5433` because port `5432` is already reserved by
another local project.
