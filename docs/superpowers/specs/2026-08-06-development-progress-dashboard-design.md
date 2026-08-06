# Development Progress Dashboard Design

## Scope

Add a read-only local development dashboard for the Enterprise DAM project. The dashboard gives
the owner a continuously refreshed view of the current phase, today's progress, active work,
unfinished tasks, blockers, verification results, and repository synchronization. It is a
development-management surface and must remain separate from the DAM business console.

The dashboard updates while an active development session changes its structured task data. It
does not claim to generate progress while no development work is running.

## Architecture

Create an independent `apps/progress` pnpm workspace using Vue 3, TypeScript, Vite, and the existing
Lucide icon library. Its development server binds only to `127.0.0.1` and uses port `5174` by
default. It does not add routes, navigation, database tables, API endpoints, containers, or
permissions to the DAM product.

The authoritative dashboard document is `apps/progress/public/task-board.json`. It is versioned
with the repository and polled by the browser every five seconds with cache bypassing. The page
keeps the last valid response in session storage so a temporary read failure can be distinguished
from an empty board.

Root commands provide the operating contract:

- `pnpm progress:dev` starts the local dashboard.
- `pnpm progress:validate` validates schema and semantic rules.
- Root `pnpm verify` includes progress validation, type checking, tests, and production build.

## Data Contract

The board records project metadata, phases, tasks, daily entries, and repository synchronization.
All timestamps use ISO 8601 values with the Asia/Shanghai offset.

Each task contains:

- A stable unique ID and concise title.
- Phase, functional area, priority, and status.
- Completion percentage from 0 through 100.
- A concrete acceptance statement and next action.
- Created and updated timestamps.
- An optional blocker reason.
- Completion time and verification records when done.

Statuses are `planned`, `in_progress`, `blocked`, and `done`. At most one task may have
`in_progress` status. A blocked task requires a non-empty blocker reason. A completed task requires
100 percent progress, a completion timestamp, and at least one verification record. Tasks that are
not complete always require a next action.

Daily entries contain the date, completed task IDs, a concise progress summary, verification
results, relevant commit hashes, and the next work item. The JSON record links to the corresponding
`docs/progress/YYYY-MM-DD.md` report when one exists.

Repository state records the latest local commit, local-origin synchronization, GitHub
synchronization, and the time each state was observed. It is maintained by the development
workflow rather than by accepting browser writes.

## User Interface

The first screen is the usable dashboard and contains four unframed sections:

1. Project overview shows the current phase, overall completion, last update time, today's counts,
   and local/GitHub synchronization.
2. Task board groups work into active, planned, blocked, and completed-today views. Desktop uses a
   stable multi-column layout; mobile uses a status segmented control and one list.
3. Daily progress defaults to the current day and allows older entries to expand in place.
4. Unfinished work lists every non-complete task with its next action and blocker when applicable.

The visual language is restrained and operational: a light neutral background, white content
surfaces, green for complete, amber for active, and red only for blocked or failed states. Headings
remain compact, cards use no more than 8px radius, and sections do not contain nested cards.
Desktop and mobile layouts must wrap long task titles, acceptance statements, and next actions
without horizontal overflow.

## Refresh And Maintenance Flow

The development workflow updates the task document at these points:

1. Mark a task active before implementation begins.
2. Update progress and verification after each independently verifiable step.
3. Record a blocker immediately when meaningful progress cannot continue.
4. Record the commit and synchronization state after repository updates.
5. Add or update the daily entry before ending the development day.

The browser fetches the document every five seconds. A newer valid `updatedAt` replaces the visible
state without navigation or layout reset. An unchanged response leaves the current view intact.
Data older than 24 hours is visibly marked as potentially stale.

## Error Handling

Initial loading uses a stable loading state. A missing or malformed document displays a prominent
error with the expected file path and validation reason; it never renders a fabricated empty
board. If a refresh fails after a valid load, the dashboard retains the last valid session copy,
labels it as cached, reports the refresh failure, and continues retrying.

Schema validation checks types, required fields, enumerations, timestamp formats, and numeric
ranges. Semantic validation checks unique IDs, task-state invariants, daily task references, one
primary active task, and completion/blocker requirements. Validation failures exit nonzero and
block the repository quality gate.

## Verification

- Unit tests cover derived counts, status grouping, stale detection, cached fallback, and semantic
  validation.
- Vue type checking and the Vite production build pass independently and under root `pnpm verify`.
- Playwright verifies the real local page at 1440x900 and 390x844.
- Browser verification covers five-second refresh, malformed-data messaging, cached fallback, long
  content wrapping, status switching, and daily-entry expansion.
- Browser acceptance requires no page overflow, console errors, or unexpected HTTP responses.

## Acceptance

- The owner can open `http://127.0.0.1:5174` and immediately see today's progress and all unfinished
  work without entering the DAM console.
- Changes to valid task data appear without a manual browser refresh.
- The page makes stale, cached, invalid, blocked, and synchronized states unambiguous.
- The default local DAM Docker profile and its memory footprint do not change.
- Dashboard data and daily history are versioned and survive restarts.
- The feature passes `pnpm progress:validate`, root `pnpm verify`, and desktop/mobile Playwright
  acceptance.
