# Audit follow-ups — back — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus this repo's AGENTS.md. If the task turns out
> bigger than described, stop and say so — it gets split, not pushed through. Tick the task's box
> when its check passes, commit, don't push.

**Where this comes from:** an outside review of the three repos (ChatGPT, 2026-11-18). Only the
points that held up against the code are here; the front and kit ones are in BookedUp-front
`docs/plans/2026-11-18-audit-followups.md`.

Not taken, and why — don't re-propose:

- **Split `AppointmentsService`** — 278 lines, smaller than `groups.service.ts`; nothing to split yet.
- **Tenant isolation / IDOR review, booking race tests** — already covered:
  `test/business-access.int-spec.ts` walks every route through `DiscoveryService` and the default-deny
  guard refuses a handler with no check; `test/appointments.int-spec.ts` fires parallel bookings
  (`Promise.all`) against the exclusion constraint and seat capacity.
- **Register BullMQ queues** — that is the reminders epic's job, not a fix.
- **Graceful shutdown** — `app.enableShutdownHooks()` is already in `src/main.ts`.

B-A1 is worth doing now (small, no new dependency). B-A2 and B-A3 wait for E1 (deploy) — they are
here so they aren't forgotten; E1 picks them up.

## B-A1: readiness check that touches Postgres and Redis

- [ ] **Branch** `feat/health-ready` from `main`.
- **Problem:** `GET /health` answers `{ status: 'ok' }` without touching anything — a process with a
  dead database still looks healthy to a load balancer or a deploy that waits for it.
- **Do:** keep `GET /health` as liveness (process is up). Add `GET /health/ready`, `@Public()`:
  `SELECT 1` through `PrismaService` and `PING` to Redis (the connection `BullModule.forRootAsync`
  already configures from `REDIS_URL` — reuse the URL from config, no new package); 200
  `{ status: 'ok' }` when both answer within ~1 s, 503 `{ status: 'unavailable', failed: ['db' |
  'redis'] }` otherwise. Swagger responses for both codes. No error details in the body.
- **Files:** `src/health/health.controller.ts`, `src/health/` module/service if one is needed,
  `src/app.module.ts` (only if the module is new), a new `test/health.int-spec.ts`.
- **Check:** int test — 200 with the test containers up; 503 with `failed: ['redis']` when the Redis
  client is pointed at a closed port (or the ping is made to fail through the service). `npm run
  typecheck`, `npm run lint`, `npm test`, int tests pass. Front: `npm run api:generate` shows the new
  route only (nothing else changes).

## B-A2 (with E1, only if the deploy runs more than one instance): shared rate-limit storage

- [ ] **Branch** from `main` when E1 starts.
- **Problem:** `ThrottlerModule` counts in process memory (`src/app.module.ts` already says so):
  with two instances each lets through its own 5 sign-ins per account, and a restart resets every
  counter.
- **Do:** ThrottlerModule storage in Redis. A storage package is a new runtime dependency — agree it
  with the user first (or write the small `ThrottlerStorage` over the Redis client already present).
  Update the comment in `app.module.ts` and the Gotchas about counters resetting on restart.
- **Files:** `src/app.module.ts`, `package.json` (if a package), `test/` — an int test that two app
  instances on one Redis share the sign-in limit.
- **Check:** that int test: 5 failed sign-ins through instance A, the 6th through instance B → 429.

## B-A3 (before launch, with E1): query plans on realistic volume

- [ ] **Branch** from `main` when E1 starts.
- **Problem:** indexes were chosen by reading the queries; nobody has looked at plans with more than a
  few rows.
- **Do:** a dev-only seed script (`prisma/seed-volume.ts`, not run by tests): one business, 30
  masters, a year of bookings at a busy salon's pace, 5 000 clients. Run `EXPLAIN ANALYZE` on the
  slots query, the calendar day/week query and client search; write the plans and any index added
  into the PR body. Add an index only where a plan shows a seq scan on bookings or clients.
- **Files:** `prisma/seed-volume.ts`, `package.json` (script `db:seed-volume`), a migration only if an
  index is added.
- **Check:** each of the three queries under 50 ms on the seeded DB; plans in the PR body.
