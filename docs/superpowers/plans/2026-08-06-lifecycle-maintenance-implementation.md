# Lifecycle Maintenance Implementation Plan

## Outcome

Deliver local-first recycle-bin retention, irreversible deletion, expired-upload cleanup, durable
object deletion, metadata pruning, and administrator maintenance visibility without requiring
ClamAV, Tika, RabbitMQ, or production infrastructure.

Status: in progress.

## Work items

1. Extend Prisma with deletion batches, leased maintenance jobs, notification archive timestamps,
   purge-safe upload-session relations, lifecycle indexes, and the corresponding SQL migration.
2. Add validated retention, lease, retry, scheduler, and worker configuration; make root `pnpm dev`
   start the lightweight NestJS worker while keeping malware processing independently disabled.
3. Introduce shared maintenance job scheduling in the API, create warning and purge jobs when a
   subtree enters the recycle bin, merge nested batches, and cancel scheduled work on restore.
4. Implement exact-name permanent-delete requests with `node.delete`, optimistic locking,
   idempotent state transitions, structured errors, audit records, and recycle-bin countdown data.
5. Build the worker maintenance queue and handlers for upload expiry, batch purge, MinIO object
   deletion, retention warnings, notification pruning, and completed-job pruning.
6. Make database purge atomic: lock the batch and space, remove the exact subtree, detach retained
   session history, release source-version quota once, repair storage reference counts, enqueue
   zero-reference objects, and leave audit history append-only.
7. Add `maintenance.read` and `maintenance.manage` to the role catalog plus tenant-scoped summary,
   filtered job-list, and dead-job retry APIs that never expose object keys or raw payloads.
8. Extend the Vue console with recycle-bin deadlines and exact-name deletion confirmation, then add
   a responsive maintenance view with status filters, safe error summaries, and retry controls.
9. Cover state transitions and retry math with unit tests; cover nested batches, early/day-30 purge,
   quota release, object cleanup retry, upload expiry, retention, authorization, and tenant isolation
   with disposable PostgreSQL and MinIO integration tests.
10. Run Prisma validation and generation, focused tests, desktop/mobile Playwright verification, and
    root `pnpm verify`; record the completed status and synchronize both configured remotes.

## Delivery checkpoints

- Checkpoint 1: schema, migration, scheduling, and recycle-bin state transitions.
- Checkpoint 2: worker purge, object deletion, expiry, pruning, and integration coverage.
- Checkpoint 3: administrator APIs, Vue workflows, responsive verification, and full quality gate.

## Acceptance

- Retained batches restore normally and unhandled batches become purge-eligible exactly 30 days
  after their latest recycle-bin action.
- A permitted user can request immediate irreversible deletion only after an exact-name
  confirmation; repeat or stale requests return stable structured errors.
- Database deletion and space quota release commit once, while MinIO deletion remains durable,
  idempotent, and independently retryable.
- Expired multipart uploads are closed without a follow-up user request, including retry after a
  temporary MinIO abort failure.
- Unread notifications, dead jobs, deletion-batch history, and audit records are not pruned.
- Maintenance visibility and retry remain tenant-scoped and do not disclose storage internals.
- The default local profile remains viable on the 8 GB workstation and `pnpm verify` passes.
