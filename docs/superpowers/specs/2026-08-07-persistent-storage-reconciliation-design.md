# Persistent Storage Reconciliation Design

Status: approved on 2026-08-07.

## Goal

Replace request-bound PostgreSQL and MinIO scans with durable, Tenant-scoped reconciliation runs.
Administrators can start a run, observe progress, browse immutable result snapshots, and start a
follow-up run without repeatedly scanning storage for every result page.

The production design targets servers with at least 16 GB of memory. Checkpointed execution is used
for fault recovery, fair scheduling, horizontal Worker scaling, and observability rather than as a
substitute for production capacity. Local verification remains serial so the current workstation is
not overloaded.

## Scope

This iteration includes:

- manual reconciliation runs and optional `sourceRunId` lineage for rechecks;
- durable run progress, summaries, and immutable issue snapshots;
- bounded, retryable Worker checkpoints with lease renewal;
- Tenant-isolated run history and issue pagination APIs;
- a run-history and selected-snapshot interface in the existing maintenance page;
- safe errors, audit events, tests, and desktop/mobile verification.

This iteration does not include scheduled runs, cancellation, result acknowledgement, notes,
unknown-object deletion, or automatic repair. A failed run may be resumed through its terminal
maintenance job or replaced by a new run. No endpoint in this iteration deletes an unknown object.

## Approach

Three approaches were considered:

1. A synchronous API scan followed by persistence has the smallest code change, but still blocks an
   HTTP request, risks timeouts, and cannot recover reliably after a partial scan.
2. Checkpoint jobs in the existing maintenance queue reuse current leasing, retry, audit, and local
   deployment boundaries. This is the selected approach.
3. A dedicated reconciliation service and RabbitMQ topology offers independent scaling, but adds
   deployment and consistency work that is not justified before object volume requires it.

The API creates and reads runs. The Worker scans PostgreSQL and MinIO. Result endpoints only query
persisted rows and never initiate storage I/O.

## Data Model

### StorageReconciliationRun

- `id`: UUIDv7 primary key.
- `tenantId`: owning Tenant.
- `requestedById`: nullable requesting user, `SET NULL` when the user is removed.
- `sourceRunId`: nullable prior run used for a recheck, restricted to the same Tenant by service
  validation.
- `status`: `QUEUED`, `RUNNING`, `RETRYING`, `SUCCEEDED`, or `FAILED`.
- `phase`: `DATABASE_SCAN`, `STORAGE_SCAN`, `FINALIZING`, or `COMPLETE`.
- `checkpointVersion`: monotonically increasing integer used to reject stale jobs.
- `databaseCursor`: internal UUID cursor for the next database checkpoint.
- `storageCursor`: internal MinIO `startAfter` cursor. It is never selected by API response queries,
  logs, notifications, or audit events. Both cursors are cleared after successful completion, but a
  failed run retains them internally so its terminal maintenance job can resume the same checkpoint.
- `cutoffAt`: run observation cutoff. Database rows created after it and MinIO objects modified after
  it are not included in counts or findings.
- `databaseObjects`, `storageObjects`, `missingObjects`, `unknownObjects`: accumulated counters.
- `lastCheckpointAt`, `startedAt`, `completedAt`, `createdAt`, and `updatedAt`.
- `errorCode` and `errorMessage`: normalized, storage-safe failure information without bucket names,
  object keys, credentials, SQL, or raw provider errors.

Indexes support `(tenantId, id DESC)`, `(tenantId, status, updatedAt)`, and a PostgreSQL partial unique
index that allows at most one `QUEUED`, `RUNNING`, or `RETRYING` run per Tenant. A composite unique
key on `(id, tenantId)` supports a Tenant-safe issue foreign key.

### StorageReconciliationIssue

- `runId` and `tenantId`: composite foreign key to the owning run.
- `issueKey`: stable SHA-256 identifier and opaque result cursor.
- `issueType`: `DATABASE_OBJECT_MISSING` or `STORAGE_OBJECT_UNKNOWN`.
- `storageObjectId`: snapshot UUID for a missing database object, without a live foreign key.
- `objectFingerprint`: SHA-256 fingerprint for an unknown MinIO object.
- `expectedSizeBytes` or `observedSizeBytes`.
- `databaseCreatedAt` or `lastModifiedAt`.
- `createdAt`.

The primary key is `(runId, issueKey)`. Unknown bucket and object-key values are not stored in issue
rows. Issue evidence is immutable after the run succeeds.

The migration only adds enums, tables, indexes, and relations. It does not backfill, rewrite, or
delete existing DAM data.

## State And Checkpoints

The run state flow is:

```text
QUEUED -> RUNNING -> SUCCEEDED
             |  ^
             v  |
          RETRYING
             |
             v
           FAILED
```

Starting a run creates the run and its first `RECONCILE_STORAGE_STEP` maintenance job in one
transaction. The job target is the run UUID. Its payload contains only the expected phase and
checkpoint version; it never contains a bucket, object key, or internal cursor.

Each job processes one bounded checkpoint:

- the database phase reads a bounded page of Tenant storage objects and stats objects with bounded
  concurrency;
- the storage phase reads a bounded MinIO page using the internal `startAfter` cursor and checks
  registered objects, active uploads, and pending deletion jobs;
- the final phase completes the immutable snapshot and writes its summary audit event.

Storage I/O occurs outside a database transaction. The checkpoint transaction then verifies the
active job lease and expected run version, inserts issues with duplicate protection, updates
counters and cursors, increments the version, and creates the next step job atomically.

If a Worker exits before the checkpoint commits, the reclaimed job repeats the same page. If it
exits after the checkpoint commits but before the old job completes, the stale version becomes a
no-op and duplicate issue keys remain harmless. Multiple Worker replicas may process different
Tenants, but the partial unique run index and version check prevent concurrent steps for one run.

The maintenance queue gains owner-checked lease renewal. The reconciliation processor renews before
long storage work and before checkpoint commit. Lease loss aborts the checkpoint and prevents stale
writes.

## Lifecycle Classification

The persisted scan preserves the current safe classification rules:

- every registered `StorageObject` is known, including a zero-reference object awaiting cleanup;
- Tenant `CREATED` and `UPLOADING` sessions are known;
- Tenant `DELETE_STORAGE_OBJECT` jobs in `PENDING`, `RUNNING`, `FAILED`, or `DEAD` are known;
- `COMPLETED`, `ABORTED`, and `EXPIRED` sessions do not hide a residual object;
- `SUCCEEDED` and `CANCELLED` deletion jobs do not hide a residual object;
- unknown objects are reported by fingerprint and are never automatically deleted.

## API

All endpoints retain the existing access-token and Tenant authorization guards.

- `POST /api/v1/maintenance/storage-reconciliation/runs`
  - requires `maintenance.manage`;
  - accepts an optional same-Tenant `sourceRunId`;
  - returns HTTP 202 with the queued run;
  - returns a stable conflict when the Tenant already has an active run.
- `GET /api/v1/maintenance/storage-reconciliation/runs`
  - requires `maintenance.read`;
  - supports UUIDv7 cursor pagination and optional status filtering.
- `GET /api/v1/maintenance/storage-reconciliation/runs/:runId`
  - requires `maintenance.read`;
  - returns safe progress, counters, timestamps, and normalized failure information.
- `GET /api/v1/maintenance/storage-reconciliation/runs/:runId/issues`
  - requires `maintenance.read`;
  - supports opaque hash cursor pagination and issue-type filtering;
  - returns results only for a successful run.

The request-bound `GET /maintenance/storage-reconciliation` scan is removed from the Web workflow
and no longer performs full storage scans. Polling and page reads do not create audit rows. State
changes write append-only `storage.reconciliation.requested`, `storage.reconciliation.completed`,
and `storage.reconciliation.failed` events containing counts and timings only.

## Error Handling

- A concurrent start returns HTTP 409 and a user-facing message to refresh the active run.
- An unknown or cross-Tenant run returns the same resource-not-found response.
- Provider, SQL, cursor, bucket, object-key, and credential details are normalized before they reach
  a run, maintenance job error, log, audit event, or response.
- A retryable step failure moves the run to `RETRYING` in the same transaction that reschedules the
  job. Claiming it again returns it to `RUNNING`.
- Exhausted attempts move the job to `DEAD` and the run to `FAILED`.
- Retrying the terminal maintenance job restores the same checkpoint only when no other active run
  exists. Creating a new run leaves the failed snapshot and its history unchanged.

## Web Interface

`MaintenanceView.vue` keeps the task-queue and storage-reconciliation modes. Reconciliation content
moves into a focused component so the existing page does not continue growing.

The desktop view uses a master-detail layout:

- run history ordered newest first;
- selected run status, phase, progress counts, timestamps, and recheck action;
- the existing four summary metrics for successful runs;
- issue-type filtering and opaque-cursor result pagination.

The mobile view presents run history as a horizontally scrollable selector followed by a vertical
detail layout. Long UUIDs and fingerprints continue to wrap without page overflow.

Refreshing reloads persisted history or the selected snapshot and never starts a scan. Starting or
rechecking is an explicit command available only to `maintenance.manage`. Active runs poll their
detail at a bounded interval; polling stops when the component unmounts or the run becomes terminal.
Failures preserve the selected run, current issue page, and available navigation.

## Verification

- Unit tests cover run transitions, checkpoint versions, lease renewal, stale-job no-ops, cursor
  progression, issue deduplication, classification boundaries, and error redaction.
- PostgreSQL integration covers the active-run unique constraint, Tenant isolation, checkpoint and
  next-job atomicity, crash recovery, retry exhaustion, terminal-job resume, and result pagination.
- MinIO integration covers database-missing and storage-unknown snapshots, active uploads, terminal
  upload residue, pending deletion jobs, cutoff behavior, no deletion, and response/audit redaction.
- API tests cover read/manage permissions, conflict behavior, cross-Tenant hiding, and filters.
- Playwright covers no-history, active, successful-clean, successful-with-issues, and failed states;
  explicit start/recheck; history selection; polling; failed pagination recovery; secret redaction;
  and desktop/mobile overflow.
- Resource-intensive build, integration, and browser checks remain serial on the current workstation.

## Follow-Up

The next iteration adds stable reconciliation cases, append-only administrator notes,
acknowledgement, and explicitly authorized repair tasks. Destructive repair requires a separate
security review and will never be inferred from acknowledgement or enabled by default. Scheduled
runs and configurable history retention follow after manual-run behavior is accepted.
