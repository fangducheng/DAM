# Production Prerequisites

Production deployment is blocked until the infrastructure owner supplies:

- Supported Linux servers or private-cloud virtual machines across failure domains
- Internal DNS names, TLS certificates, and Company A/B network routes
- PostgreSQL and MinIO data volumes plus an off-site backup target
- Private container registry and GitHub Actions runner or equivalent CI runner
- SMTP or enterprise notification channel
- Secret-management integration and named alert recipients

The Windows development workstation is not a production deployment target.
