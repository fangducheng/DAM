# Processing and Discovery Design

## Scope

This slice turns an uploaded binary into a safe, discoverable enterprise asset and exposes the
operational records needed to understand that lifecycle. It covers deferred malware scanning,
content extraction, preview renditions, tags, PostgreSQL search, audit browsing, and in-product
notifications. External processors remain optional on the 8 GB local workstation.

## Decisions

### Reliable work dispatch

`processing_jobs` is the authoritative local queue. Workers claim due rows with PostgreSQL
`FOR UPDATE SKIP LOCKED`, record a lease, and recover abandoned leases. A unique asset-version and
job-type key makes scheduling idempotent. This is lighter than requiring RabbitMQ locally and more
reliable than running processors inside the API request. The existing outbox remains the future
boundary for publishing the same jobs to RabbitMQ without changing upload transactions.

Jobs form a dependency chain:

1. `MALWARE_SCAN` is scheduled when a deferred upload commits.
2. A clean result makes the version available and schedules `CONTENT_EXTRACT` and
   `PREVIEW_RENDITION`.
3. Extraction updates searchable content. Rendition generation records each supported output.
4. Terminal success or failure creates an audit event and a notification for the uploader.

### Security behavior

Deferred assets stay `QUARANTINED` until ClamAV returns an explicit clean result. A timeout,
unreachable service, malformed response, or processing exception never publishes the asset.
Detected malware marks the version `REJECTED` and the scan `INFECTED`. If an earlier clean version
exists, it is restored as the current version; otherwise the node remains quarantined.

`local-bypass` remains development-only and records `SKIPPED` visibly. It does not claim that a
scan occurred. Production validation continues to reject this mode.

### Processor adapters

- ClamAV uses the documented `clamd` INSTREAM protocol through a bounded TCP adapter.
- Plain text formats use a built-in bounded UTF-8 extractor. Other document formats use an
  optional Tika HTTP adapter.
- Existing browser-readable originals remain valid previews. Optional LibreOffice/FFmpeg/image
  processors can add normalized renditions without changing API contracts.
- Source objects are streamed from MinIO; processors do not load unrestricted files into memory.

Capability checks distinguish `not configured` from processing failures. Unsupported extraction
or rendition types complete as skipped capabilities and do not make a clean source unavailable.

## Discovery model

Space managers own the tag vocabulary. Users with `node.update` may assign existing space tags to
an asset. Duplicate tag names are prevented case-insensitively within a space.

Search is scoped to one space and returns only nodes for which the caller has `node.view`.
PostgreSQL combines a GIN full-text vector for extracted content with trigram matching for names
and metadata. The service boundary returns stable cursors and can later be backed by OpenSearch.
Filters include MIME family and tag IDs.

## API and user interface

- Asset APIs expose version processing status, tags, and available renditions.
- Space APIs manage tags and perform permission-filtered search.
- Tenant audit APIs require `audit.read` and support action, actor, result, resource, and time
  filters.
- Notification APIs list the current user's records and mark one or all as read or archived.
- The web console adds search and tag controls to the asset workspace, a notification inbox, and
  an audit browser. User-facing failures continue to use the existing structured error contract.

## Consistency and error handling

Upload completion, initial job creation, and audit creation share one database transaction. Worker
state transitions use compare-and-set updates so two workers cannot complete the same lease.
Retries use bounded exponential backoff and end in `DEAD`; administrators can inspect the terminal
error without exposing internal stack traces to ordinary users.

Tag assignment and audit filters are tenant- and space-scoped at the database boundary. Presigned
preview/download URLs still require a fresh permission check and now append a read audit record.

## Verification

- Unit tests cover ClamAV responses, retry delays, extraction bounds, query validation, and status
  transitions.
- Disposable PostgreSQL and real MinIO tests cover deferred upload, clean publication, infected
  rejection, abandoned-lease recovery, tags, permission-filtered search, audit filters, and
  notification state.
- API type checks, all workspace tests, production builds, and the root `pnpm verify` remain green.
- Playwright verifies search, tag assignment, notifications, and audit browsing at desktop and
  mobile sizes without console errors or unexpected responses.

