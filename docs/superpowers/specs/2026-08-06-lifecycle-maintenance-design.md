# Lifecycle Maintenance Design

## Scope

Add safe, local-first data lifecycle maintenance to Enterprise DAM. The slice covers recycle-bin
retention, user-requested permanent deletion, automatic deletion after 30 days, expired multipart
uploads, durable MinIO object deletion, maintenance observability, and bounded retention for
notifications and completed jobs.

Backup and restore, production deployment topology, and destructive deletion of unknown MinIO
objects remain outside this slice. Audit events remain append-only and are not automatically
deleted.

## Retention Policy

- A resource deletion batch remains recoverable for 30 days.
- A user with `node.delete` may request permanent deletion before the deadline.
- An unhandled batch is automatically purged when its 30-day deadline arrives.
- Restoring a batch cancels its warnings and purge task.
- The original deleter receives warnings seven days and one day before automatic purge.
- Unread notifications have no automatic expiry. Read notifications remain for 180 days and
  archived notifications remain for 90 days.
- Successful processing and maintenance jobs remain for 30 days.
- Terminal failed jobs remain until an administrator resolves them; their 30-day retention starts
  only after successful completion.
- Audit events remain append-only without an automatic retention deadline.

Retention values are validated configuration with the approved values as defaults. Production may
override bounded notification and job-retention values, but the initial recycle-bin deadline stays
30 days so the user promise is stable.

## Data Model

### Deletion batches

Add a durable `deletion_batches` record for every recycle-bin action. It stores the Tenant and
space, original root-node ID, root name and type snapshots, original deleter, deletion and purge
times, item and byte counts, status, and a bounded terminal error. It intentionally outlives the
resource nodes so administrators can trace completed cleanup without retaining object keys. The
original root-node ID is therefore a scalar snapshot rather than a restrictive foreign key.

Batch states are `RETAINED`, `PURGE_REQUESTED`, `PURGING`, `PURGED`, `FAILED`, `RESTORED`, and
`SUPERSEDED`. Existing `resource_nodes.deletion_batch_id` becomes an optional foreign key to the
batch while the nodes exist. `FAILED` means the database purge exhausted its retries before it
committed. A later administrator retry moves the batch back to `PURGE_REQUESTED`. Failures in
post-commit MinIO deletion jobs do not change an already `PURGED` batch.

Deleting a parent whose subtree already contains recycle-bin batches merges those descendant
batches into the new parent batch. All affected nodes receive the new deletion time and 30-day
deadline, the old batches become `SUPERSEDED`, and their pending maintenance jobs are cancelled.
This prevents a retained child batch from blocking deletion of its parent and gives the user one
clear recovery unit.

### Maintenance jobs

Add a generic `maintenance_jobs` queue with job type, unique idempotency key, optional Tenant and
space scope, target ID, bounded JSON payload, status, attempts, availability, unique worker lock,
lease expiry, completion time, and bounded error text.

Notifications gain an `archived_at` timestamp. Read-notification retention is measured from
`read_at`, and archived-notification retention is measured from `archived_at`; status transitions
set or clear these timestamps atomically.

Job types initially cover:

- `EXPIRE_UPLOAD_SESSION`
- `RETENTION_WARNING`
- `PURGE_DELETION_BATCH`
- `DELETE_STORAGE_OBJECT`
- `PRUNE_NOTIFICATIONS`
- `PRUNE_COMPLETED_JOBS`

Workers claim jobs with PostgreSQL `FOR UPDATE SKIP LOCKED`, unique per-process lock tokens,
unexpired leases, bounded exponential retry, and a terminal `DEAD` state. Scheduling uses a unique
idempotency key so restarts and repeated requests cannot duplicate a purge, warning, quota update,
or object deletion.

## Lifecycle Flows

### Move to recycle bin

The existing node-delete authorization and optimistic lock remain mandatory. One serializable
transaction creates the batch, snapshots counts and source-version bytes, marks the complete
subtree deleted, merges contained batches, writes the audit event, and schedules warning and purge
jobs for days 23, 29, and 30.

### Restore

The existing exact-batch restore remains atomic. The transaction locks the batch, requires
`RETAINED` state, restores node status according to version availability, cancels scheduled jobs,
marks the batch `RESTORED`, and writes the audit event. Restore is unavailable once purge has been
requested or started.

### User-requested permanent deletion

The API rechecks `node.delete`, optimistic version, Tenant, space, and retained batch state. The
user must submit the exact resource name from a destructive confirmation dialog. The transaction
marks the batch `PURGE_REQUESTED`, moves its purge job to the current time, cancels warnings, and
records `resource.purge.requested`. The API does not synchronously delete MinIO data.

### Automatic or requested purge

The worker locks the maintenance job and batch. A database transaction then:

1. Verifies the batch is requested or past its retention deadline.
2. Marks it `PURGING` and snapshots source-version storage references.
3. Detaches internal parent links needed to satisfy restrictive tree constraints and deletes the
   exact batch nodes, cascading ACLs, assets, versions, renditions, extraction, and processing jobs.
   Upload-session links to resource nodes and assets use `ON DELETE SET NULL`, preserving bounded
   session history without blocking purge.
4. Decrements `spaces.used_bytes` by source-version bytes with an underflow assertion.
5. Recalculates actual remaining version and rendition references for every affected storage
   object instead of trusting the cached reference counter.
6. Updates counters for referenced objects. For zero-reference objects, deletes storage metadata
   and creates idempotent object-deletion jobs containing only the required bucket and opaque key.
7. Marks the batch `PURGED`, writes `resource.purge.completed`, and creates a notification with the
   released byte count.

If the transaction fails, all database changes roll back. The batch eventually becomes `FAILED`
only after bounded retries and remains visible to maintenance administrators.

### Object deletion

The object-deletion handler calls MinIO with the job's opaque snapshot. Removing an already absent
object is success. A MinIO timeout leaves the durable job retryable and never recreates permanently
purged database content. Terminal failure writes `storage.delete.failed` without exposing object
keys or credentials to ordinary users.

An administrator-only reconciliation report may list database metadata without objects and MinIO
objects without database metadata. Unknown MinIO objects are report-only and never automatically
deleted.

### Expired uploads

Creating an upload session schedules one `EXPIRE_UPLOAD_SESSION` job at `expires_at`. The handler
locks the session and skips only completed or already aborted sessions. It first atomically marks a
due session `EXPIRED` and writes `upload.expired`, then idempotently aborts the multipart upload.
If the MinIO abort fails, the same job remains retryable and continues cleanup even though the
session is already `EXPIRED`; the status prevents new parts, completion, and quota reservation.

### Metadata pruning

Daily idempotent jobs delete read and archived notifications past their configured deadlines and
completed processing or maintenance records past 30 days. Unread notifications, dead jobs, active
jobs, deletion-batch history, and audit events are excluded. Pruning writes aggregate audit counts
without copying notification payloads or job error details.

Processing records may be removed earlier when their owning asset is permanently purged; the
30-day rule is the maximum retention for otherwise live completed records. A lightweight scheduler
periodically upserts uniquely keyed daily pruning jobs, so restarts cannot create duplicates.

## Worker Runtime

Lifecycle maintenance runs in the existing NestJS worker independently of malware processing.
`MAINTENANCE_WORKER_ENABLED` defaults to true locally, while `PROCESSING_WORKER_ENABLED` may remain
false. Root `pnpm dev` starts API, Web, and the lightweight worker so expiration and scheduled
cleanup continue on the 8 GB workstation without starting ClamAV, Tika, RabbitMQ, or additional
containers.

The runtime drains processing and maintenance queues fairly, never running more than the configured
small concurrency. Graceful shutdown stops claiming new work and allows the current database
transition to finish. External calls are time-bounded and all logs sanitize opaque keys, payloads,
and credentials.

## Authorization, API, And Audit

Add `maintenance.read` and `maintenance.manage` permissions to the existing role catalog. Tenant
administrators receive both; read-only audit roles may receive only `maintenance.read` through
normal role configuration.

Resource APIs expose batch deadline, days remaining, counts, released bytes, and cleanup status.
The permanent-delete endpoint requires `node.delete` and the exact-name confirmation. Tenant
maintenance APIs require `maintenance.read` for filtered job and summary views;
`maintenance.manage` is required to retry a dead job.

Audit actions include `resource.purge.requested`, `resource.purge.completed`,
`resource.purge.failed`, `upload.expired`, `storage.delete.failed`, and aggregate metadata-pruning
events. User requests retain the real actor. Scheduled work uses a system actor while preserving
the original deleter in bounded audit details.

## User Interface

The recycle bin adds deletion time, automatic-purge time, remaining days, item count, source bytes,
and cleanup state. Available actions are restore and permanent delete. The destructive dialog
requires the exact resource name and states that all versions become unrecoverable. Once requested,
the row shows a stable waiting state and cannot be restored or submitted twice.

A maintenance view shows summary counts and filterable pending, running, retrying, and dead jobs.
It displays safe error summaries, scope, attempts, next retry, and completion time. Administrators
with `maintenance.manage` can retry dead jobs through a labelled command with confirmation.
Ordinary users never receive MinIO paths, internal stack traces, or credentials.

The existing structured API error contract drives notifications for stale writes, lost permissions,
already-running purge, invalid confirmation, and terminal maintenance failure. Desktop and mobile
layouts retain the existing quiet operational visual language and avoid horizontal overflow.

## Consistency And Failure Handling

- Database purge and quota changes are one transaction.
- MinIO deletion is deliberately asynchronous and backed by a durable idempotent job.
- Batch and job compare-and-set transitions prevent two workers from applying the same purge.
- Space rows are locked before quota subtraction, and underflow aborts the transaction.
- Actual database references decide object eligibility; cached reference counts are repaired.
- Restore, manual purge, and automatic purge serialize on the batch row.
- Terminal jobs remain inspectable and retryable by authorized administrators.
- Unknown MinIO objects are never automatically deleted.
- Audit records remain append-only across every maintenance path.

## Verification

- Unit tests cover retention deadlines, warning schedules, state transitions, retry delays,
  confirmation validation, quota calculations, and retention filters.
- Disposable PostgreSQL and real MinIO tests cover nested-batch merge, restore cancellation,
  early permanent deletion, automatic day-30 purge, multiple versions, original-preview shared
  references, exact quota release, missing-object idempotency, MinIO retry, and dead-job recovery.
- Upload tests cover unattended expiry, multipart abort retry, completed-session protection, and
  exclusion of expired reservations from quota calculations.
- Authorization tests cover manual purge, maintenance read, retry, Tenant isolation, and hidden
  object details.
- Reconciliation tests prove unknown objects are reported and never deleted.
- Playwright covers countdowns, exact-name confirmation, requested state, maintenance filters,
  friendly errors, and retry controls at 1440x900 and 390x844 without overflow, console errors, or
  unexpected responses.
- Root `pnpm verify` and the disposable lifecycle integration suite pass before commit.

## Acceptance

- A user may restore a retained batch or request irreversible deletion with `node.delete`.
- An unhandled batch is automatically and idempotently purged after 30 days.
- Permanent purge releases exactly the source-version bytes previously charged to the space.
- A MinIO outage cannot produce duplicate quota updates or a partially restored resource.
- Expired upload sessions are cleaned without requiring another user request.
- Unknown objects are never deleted automatically.
- Audit history remains append-only and terminal failures are visible and retryable.
- Default local services remain PostgreSQL, Redis, MinIO, API, Web, and one lightweight NestJS
  worker within the constrained workstation profile.
