# Processing and Discovery Implementation Plan

## Outcome

Deliver a local-first, fail-closed asset processing pipeline and the discovery and operational
interfaces needed to use it, while keeping ClamAV and document/media processors optional.

Status: completed on 2026-08-06.

## Work items

1. Extend the schema and configuration for leased idempotent jobs, normalized tags, search indexes,
   processor capabilities, and worker limits.
2. Schedule deferred processing in the upload transaction and implement PostgreSQL job claiming,
   retry, lease recovery, and terminal state handling in the NestJS worker.
3. Add streaming MinIO reads, ClamAV scanning, bounded text/Tika extraction, and rendition adapter
   boundaries; publish only explicitly clean versions.
4. Add tag management, asset tag assignment, processing status, rendition listing, and authorized
   PostgreSQL search APIs.
5. Add audit browsing and personal notification APIs, including read/download audit writes.
6. Extend the Vue console with search, tags, processing state, notifications, and audit views.
7. Add integration fixtures and responsive browser verification, then run the full quality gate.

## Acceptance

- Deferred uploads cannot be previewed or downloaded until ClamAV explicitly returns clean.
- Infected, failed, and unsupported processing outcomes are distinct and visible.
- Job delivery is idempotent and recovers a worker that exits after claiming a task.
- Search never returns an asset the caller cannot view and supports Chinese/partial filename
  matching plus extracted-content queries.
- Tag writes honor space and node permissions; audit browsing requires `audit.read`.
- Users can see and acknowledge their processing notifications.
- Default local services remain PostgreSQL, Redis, and MinIO; optional processors do not consume
  memory unless their profiles are enabled.
- `pnpm verify` and the desktop/mobile Playwright flow pass.
