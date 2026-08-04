# Foundation Implementation Plan

## Outcome

Deliver a reproducible monorepo that proves the selected runtime, database model, local
infrastructure, health contract, web operations console, quality gates, and deployment
boundaries before identity and asset workflows are added.

## Work items

1. Establish pnpm workspaces for the web, API, worker, shared contracts, and database client.
2. Define the approved PostgreSQL model in Prisma and validate it against PostgreSQL 18.
3. Expose liveness and readiness endpoints with database, Redis, and object-store probes.
4. Build a responsive system-status console driven by the readiness endpoint.
5. Add constrained Docker profiles, CI verification, environment validation, and runbooks.
6. Run formatting, lint, type checks, unit tests, production builds, and local smoke checks.

## Acceptance

- A clean checkout installs with one pnpm command.
- The default Docker profile stays within the 4 GB Docker memory allocation.
- Liveness succeeds without dependencies; readiness reports every dependency independently.
- The web console renders dependency state without layout overlap at desktop and mobile widths.
- Schema validation, tests, and builds pass in CI and locally.
