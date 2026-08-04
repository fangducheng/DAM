# Enterprise DAM Architecture Design

## Decision summary

The platform uses a private-cloud, centrally deployed modular monolith. Company A and
Company B share one control plane while organization, space, folder, and asset permissions
provide logical isolation. Anonymous links are excluded from the first release.

The implementation uses Vue 3 and TypeScript for the web console, NestJS with Fastify for
the API, a separately deployed NestJS worker, PostgreSQL for metadata, MinIO for immutable
binary objects, Redis for cache and sessions, and RabbitMQ with a transactional outbox for
durable jobs.

## Security and authorization

Authentication uses short-lived access tokens, rotating refresh tokens, Argon2id password
hashes, and TOTP MFA. Authorization combines platform and space RBAC with inheritable
resource ACLs. Explicit deny wins over allow and missing permission always denies access.
Downloads and previews require a fresh authorization decision before issuing a short-lived
object-store URL.

New uploads remain quarantined until checksum validation, MIME detection, and ClamAV
scanning complete. Asset versions are immutable. Deletes enter a 30-day recycle bin, and
all sensitive operations append an audit event.

## Data and processing

PostgreSQL stores identities, permissions, hierarchy, asset metadata, version references,
search content, jobs, outbox events, and audit records. MinIO stores source objects and
derived renditions under opaque keys. Folder ancestry uses a closure table so permission
inheritance and subtree reads remain predictable.

The first search implementation uses PostgreSQL full-text and JSONB indexes. An adapter
boundary allows OpenSearch to replace it once volume or query complexity justifies a
separate cluster. Tika, LibreOffice, and FFmpeg run only in workers.

## Availability and operations

Production targets RPO <= 15 minutes and RTO <= 2 hours. Stateless services run with at
least two replicas. PostgreSQL uses streaming replication and WAL archiving; MinIO uses
erasure coding and off-site replication. Deployments are containerized and promoted by CI
and GitOps. OpenTelemetry, Prometheus, Grafana, Loki, and Alertmanager provide operational
visibility.

Local development is optimized for an 8 GB workstation: PostgreSQL, Redis, and MinIO form
the default profile, while RabbitMQ, malware scanning, content extraction, and monitoring
are opt-in profiles.

## Delivery iterations

1. Engineering foundation, database schema, health probes, CI, and local infrastructure.
2. Organizations, users, MFA, sessions, roles, spaces, and ACL evaluation.
3. Resource hierarchy, multipart upload, asset versions, download authorization, and recycle bin.
4. Malware scanning, extraction, renditions, full-text search, audit, and notifications.
5. High availability, backup recovery, performance testing, security testing, and pilot rollout.
