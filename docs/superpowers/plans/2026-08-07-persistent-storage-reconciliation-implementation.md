# Persistent Storage Reconciliation Implementation Plan

## Outcome

Replace request-bound PostgreSQL and MinIO scans with durable Tenant-scoped runs, bounded Worker
checkpoints, immutable issue snapshots, and a responsive run-history interface. The production
architecture targets servers with at least 16 GB of memory; only local verification is serialized.

Status: in progress on 2026-08-07.

## Work Items

1. Extend Prisma with reconciliation run, phase, status, and issue enums; run and issue tables;
   Tenant-safe relations; checkpoint fields; query indexes; and the partial active-run unique index.
2. Add a forward-only SQL migration and regenerate the Prisma client without resetting or rewriting
   existing DAM data.
3. Replace the synchronous reconciliation report service with Tenant-isolated commands and queries
   for run creation, run history, run detail, and successful issue pagination.
4. Create the first `RECONCILE_STORAGE_STEP` maintenance job in the same transaction as its run,
   enforce same-Tenant recheck lineage, normalize conflicts and failures, and write summary-only
   requested/completed/failed audit events.
5. Add owner-checked maintenance lease renewal and a dedicated Worker reconciliation processor;
   reject unsupported job types instead of completing them silently.
6. Implement bounded database, storage, and finalization checkpoints with version checks, stale-job
   no-ops, duplicate-safe issue insertion, cutoff classification, atomic next-step scheduling, and
   retry/terminal run transitions.
7. Extend the Worker object-storage adapter with safe Tenant iteration and existence checks while
   keeping bucket names, object keys, credentials, and provider errors outside responses and audit.
8. Extract the Vue reconciliation UI into a focused component and typed API module with run history,
   selected progress, explicit start/recheck, active-run polling, immutable summaries, issue filters,
   cursor pagination, preserved-error state, and read/manage permission handling.
9. Add focused unit and disposable PostgreSQL/MinIO integration tests for constraints, Tenant
   isolation, checkpoint recovery, lease loss, lifecycle classification, pagination, and redaction;
   update Playwright mocks and desktop/mobile acceptance scenarios.
10. Apply migrations only with `migrate deploy`, run formatting, lint, Prisma validation, typechecks,
    unit tests, builds, all eight local integration suites, and browser verification serially; then
    update the Chinese DAM work report and synchronize both configured remotes.

## Parallel Boundaries

- Database and API: Prisma schema, migration, API DTOs, service, controller, module, and API tests.
- Worker: queue renewal, object-storage adapter, reconciliation processor, runtime delegation, and
  Worker tests. This work consumes the approved target Prisma model and does not edit the migration.
- Web: typed maintenance client, reconciliation component, view integration, styles, Web tests, and
  Playwright fixtures. This work consumes the approved API response contract.

Shared-file reconciliation, Prisma generation, formatting, migration deployment, and full validation
are performed once after the three implementation streams converge.

## Acceptance

- Starting a run returns promptly and never scans MinIO in the API process.
- One Tenant can have at most one active run, while different Tenants can run concurrently.
- A reclaimed or duplicated checkpoint cannot double-count issues or overwrite a newer checkpoint.
- A lost lease prevents checkpoint writes; retryable failures resume the same cursor and exhausted
  failures leave a safe persisted failure record.
- Run history and issues are Tenant-isolated, cursor-paginated database reads, and issue results are
  visible only after successful finalization.
- Unknown objects are represented only by fingerprints and are never deleted or repaired in this
  iteration.
- The maintenance UI distinguishes refresh from start/recheck, polls only active selected runs, and
  retains usable data when a refresh or page request fails.
- Desktop and 390-pixel mobile views have no overflow, secret disclosure, console error, or failed
  network response outside explicitly tested failures.
- Existing DAM lifecycle, authorization, upload, discovery, and processing behavior remains green.
