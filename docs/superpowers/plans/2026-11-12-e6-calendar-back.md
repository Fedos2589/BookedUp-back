# E6 calendar of bookings — back — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus the repo's AGENTS.md (and the skills it
> points to). If the task turns out bigger than described, stop and say so — it gets split, not
> pushed through. Tick the task's box when its check passes, commit, don't push.
>
> **When the step is merged:** its last task updates the step's row in the common plan (another repo — its own branch from `main` and its own commit; don't push).

**Status:** B1–B11 done; B11 is on branch `e6/past-slots`, not merged yet.

**Common plan** (goal, decisions, the kit's and the front's steps): `2026-11-12-e6-calendar.md` next to this file.

## Global constraints

- AGENTS.md and its skills rule. New table follows the schema rules (`business_id NOT NULL`, staff
  by `(business_id, staff_id)` FK, snake_case plural, `Timestamptz(3)`, `uuidv7()`, `updated_at`);
  every string bounded in zod (name 1–100 trimmed, phone E.164 ≤ 16, note ≤ 2000, blank → `null`);
  every route has `@ApiOkResponse` / `@ApiCreatedResponse` with `openApi(schema)`. Checks before a
  commit: `npm run typecheck && npm run lint && npm test && npm run test:int`.
- Commit messages via `git commit -F - <<'EOF'`.

## Review focus (for the Opus review of each PR)

1. Two parallel `POST`s for one hours slot → exactly one 201 and one 409 (B3 test).
2. Two parallel seats for the last place of a group meeting → one 201, one 409 `full` (B4 test).
3. A booking that runs past midnight sits on the day it starts — in `freeSlots` and in `GET`.
4. A master calling `GET /appointments?staffId=<another>` gets nothing of the other master's.
5. `NO_SHOW` frees an hours booking's time in both places that hold it — the `EXCLUDE` constraint
   and `GET /slots` — and in neither for a seat (B9).
6. Without `includePast` `GET /slots` answers exactly as before (booking screens must not start
   offering started meetings); with it a started or finished meeting comes back with the right
   `booked` / `capacity` / `full` (B11).
7. A walk-in never goes through `full`, and a meeting that hasn't started can't take one (B10).

---

## Step B — back (branch `e6/appointments` in BookedUp-back)

### - [x] B1: `appointments` table

**Files:** `prisma/schema.prisma`, new migration `prisma/migrations/<ts>_appointments/migration.sql`
(`npx prisma migrate dev --create-only --name appointments`, then append SQL), `test/schema.int-spec.ts`,
`src/prisma/unique-violation.ts` (comment only).

**Model `Appointment` (`appointments`):** `id, businessId, staffId, startsAt, endsAt,
status AppointmentStatus @default(BOOKED), clientName, clientPhone, note String?,
groupId String?, oneOffSessionId String?`, timestamps. `enum AppointmentStatus { BOOKED CONFIRMED
DONE NO_SHOW CANCELLED }`. FKs: staff by `(business_id, staff_id)` cascade; group by
`(business_id, group_id) → groups(business_id, id)` restrict; one-off session likewise (add
`@@unique([businessId, id])` on `OneOffSession` if missing). `@@index([businessId, startsAt])`.

**SQL:** `CHECK (starts_at < ends_at AND ends_at - starts_at <= interval '1 day')`;
`CHECK (group_id IS NULL OR one_off_session_id IS NULL)`;
`EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status <> 'CANCELLED' AND group_id IS NULL AND one_off_session_id IS NULL)` as `appointments_no_overlap`.

**Check:** new tests in `test/schema.int-spec.ts` pass — two overlapping hours bookings of one
master refused (`violatedExclusion(e) === 'Appointment'`); the same overlap allowed when the first
is `CANCELLED`; two seats in one group meeting allowed; both `group_id` and `one_off_session_id`
set → CHECK error. Commit `feat(appointments): table with no-overlap for hours bookings`.

### - [x] B2: `freeSlots` counts bookings

**Files:** `src/schedule/slots.ts`, `src/schedule/slots.spec.ts`.

Add `bookings: readonly Booking[]` to `SlotQuery`
(`Booking = { staffId, startsAt, endsAt, groupId, oneOffSessionId }`, active ones only — the caller
filters `CANCELLED`). Hours-mode bookings act like `busy`; a group / session slot gets
`booked = number of bookings with that groupId (or oneOffSessionId) and that startsAt`; a slot with
`booked >= capacity` stays in the answer (the grid shows it full) — add `full: boolean` to `Slot`.
Remove the «until E6» comments.

**Check:** `npm test -- slots` — new cases: hours slot taken by a booking is gone; group slot with
2 of 3 booked → `booked: 2, full: false`; 3 of 3 → `full: true`; a booking of another master or
another occurrence of the group doesn't count. Commit `feat(slots): bookings take hours slots and seats`.

### - [x] B3: `POST /businesses/:id/appointments` — hours mode

**Files:** create `src/appointments/{appointments.module,appointments.controller,appointments.service,appointments.schema}.ts`;
register in `src/app.module.ts`; `src/schedule/schedule.service.ts` (export a
`slotsFor(businessId, staffId, date)` helper that loads sources incl. bookings — reuse what
`slots()` does); `test/appointments.int-spec.ts`.

Body: `{ staffId, startsAt, endsAt, clientName, clientPhone, note? }`. In one transaction: lock
the staff row (`FOR UPDATE`, as in `schedule.service.ts:71`), find a free non-full hours slot with
exactly this start/end (else 409 `notFree`), insert. Exclusion violation → 409 `notFree` as well.
Answer 201 with the booking DTO. Authorization: `authorizeChangeOf`.

**Check:** `npm run test:int -- appointments`: books a free slot; 409 on a time that isn't a slot;
409 on a taken slot; **two parallel requests → one 201, one 409**; another business's master → 404;
a master booking another master without the right role → 403. Commit `feat(appointments): book an hours slot`.

> **B4 and B8 ship together** (same PR, or B8's archiving first): seats make deleting a group
> answer 500 until «delete» archives (review of back #19, N2).

### - [x] B4: seats in group meetings and one-off sessions

**Files:** `src/appointments/appointments.{service,schema}.ts`, `test/appointments.int-spec.ts`.

Body gets optional `groupId` or `oneOffSessionId` (not both — zod refine). The slot must be the
group's occurrence / the session with this start (cancelled date → 409 `notFree`); under the staff
row lock count active bookings → `>= capacity` → 409 `full`.

**Check:** int tests: seat booked, `booked` in `GET /slots` grows; last seat by two parallel
requests → one 201, one 409 `full`; cancelled date → 409. Commit `feat(appointments): seats in groups`.

### - [x] B5: `GET /businesses/:id/appointments`

**Files:** `src/appointments/appointments.{controller,service,schema}.ts`, `test/appointments.int-spec.ts`.

Query `from`, `to` (local dates, ≤ 31 days), optional `staffId`, `includeCancelled` (default false).
A booking belongs to the local day it starts. A `MASTER` gets only bookings of their own staff
(ignore / intersect `staffId`). Order by `startsAt`.

**Check:** int tests: range bounds by business zone (a 23:30 booking in Asia/Bangkok on the right
day); master sees own only, also with `staffId` of another; cancelled hidden by default; a seeded
week of 10 masters × 40 bookings answers in < 200 ms (log the time in the test, assert loosely).
Commit `feat(appointments): list bookings for a range`.

### - [x] B6: status changes and cancel

**Files:** `src/appointments/*`, `test/appointments.int-spec.ts`.

`PATCH /businesses/:id/appointments/:appointmentId/status` `{ status }`. Allowed moves per
Decision 2, else 409 `badTransition`; `DONE`/`NO_SHOW` before `startsAt` → 409 `notStarted`.
`authorizeChangeOf` on the booking's master.

**Check:** int tests for every allowed and one refused move; after `CANCELLED` the slot is free
again in `GET /slots`. Commit `feat(appointments): status changes`.

### - [x] B6a: `DONE` / `NO_SHOW` without confirming first

**Branch:** `e6/slots-bookings`, before its PR (B5+B6). **Files:** `src/appointments/appointments.schema.ts`,
`test/appointments.int-spec.ts`.

`nextStatuses.BOOKED` gets `DONE` and `NO_SHOW` (the user's amendment of Decision 2); fix the comment
above it. Nothing else changes: `notStarted` still guards both, cancelling a past booking already works.

**Check:** `npm run test:int -- appointments`: `BOOKED → DONE` and `BOOKED → NO_SHOW` in the
«moves» table (start in the past); `BOOKED → DONE` leaves the «refuses» table (put `DONE → NO_SHOW`
there instead); `BOOKED → DONE` before the start → 409 `notStarted`. Commit
`feat(appointments): done or no-show without confirming`.

### - [x] B7: move a booking

**Files:** `src/appointments/*`, `test/appointments.int-spec.ts`.

`PATCH /businesses/:id/appointments/:appointmentId` `{ staffId?, startsAt, endsAt, groupId?, oneOffSessionId? }`
— the same checks as B3/B4 against the new slot, in one transaction, the booking's own current slot
not counting against it (moving 10:00–11:00 to 10:30–11:30 overlapping itself works). Only
`BOOKED`/`CONFIRMED` move. Locks both masters' rows in id order when the master changes.

**Check:** int tests: move to a free slot; to a taken one → 409, booking unchanged; overlapping
itself works; to another master works. Commit `feat(appointments): move a booking`.

### - [x] B8: schedule changes don't orphan bookings

**Files:** `src/schedule/groups.service.ts`, `src/schedule/schedule.service.ts`,
`test/schedule.int-spec.ts`.

Add `archived_at` to `groups` and `one_off_sessions`; «delete» in `groups.service.ts` archives
(archived ones are left out of slots, lists and the lock-time checks; a name stays free).
Under the existing staff lock: cancelling a group's date, archiving a group or a one-off session,
adding time off → if active bookings fall on it → 409 `{ code: 'hasBookings', appointmentIds }`.

**Check:** int tests for each of the four cases (409 + nothing changed) and the same calls passing
once the booking is cancelled; an archived group with history leaves no 500. Commit `feat(schedule): refuse changes over live bookings`.

### - [x] B9: a no-show frees an hours booking's time

**Branch:** `e6/slots-bookings` (with B5+B6). **Files:** create
`prisma/migrations/<ts>_no_show_frees_time/migration.sql`, `src/schedule/schedule.service.ts`,
`src/schedule/live-bookings.ts` (or wherever the shared `where` below fits),
`test/appointments.int-spec.ts`, `.claude/skills/back-schedule/SKILL.md`.

What holds a master's time becomes one rule: not `CANCELLED`, and not a `NO_SHOW` of an hours
booking (`group_id` and `one_off_session_id` both null). A `NO_SHOW` seat keeps holding and counting.

- Migration: drop and re-add `appointments_no_overlap` with
  `WHERE (status <> 'CANCELLED' AND NOT (status = 'NO_SHOW' AND group_id IS NULL AND one_off_session_id IS NULL))`;
  keep the comment above it in step. Prisma doesn't see the constraint — schema.prisma is untouched.
- The bookings `slots()` reads (`schedule.service.ts`, `status: { not: 'CANCELLED' }`) use the same
  rule as one exported Prisma `where` (`holdsTime`) next to `live`, so the two can't drift.

**Check:** `npm run test:int -- appointments`: an hours booking seeded as `NO_SHOW` on a future slot
→ the slot is free in `GET /slots` and `POST` books it (201; the constraint lets it in); the same as
`DONE` → 409 `notFree`; a `NO_SHOW` seat still counts in `booked` and toward `full`. Commit
`feat(appointments): a no-show frees the master's time`.

### - [x] B10: walk-ins on a meeting that has started

**Branch:** `e6/slots-bookings`, after B9. **Files:** `src/appointments/appointments.{controller,service,schema}.ts`,
`src/schedule/schedule.service.ts` (only the `notBefore` parameter), `test/appointments.int-spec.ts`.

`POST /businesses/:id/appointments/walk-ins` — the body of a seat booking (`staffId`, `startsAt`,
`endsAt`, `groupId` xor `oneOffSessionId` **required**, client fields). Under the staff row lock, as
`create`: the meeting must be the group's occurrence / the session with this start on that day (not
cancelled, not archived) → else 409 `notFree`; its start must be `<= now` → else 409 `notStarted`
(«book a seat instead»). No `full` check. Created as `DONE`. `authorizeChangeOf` as in `create`.

- Finding a started meeting: `slots()` cuts at `notBefore: now`; give it an optional `notBefore`
  (default `now`) and pass the start of that local day (`startOfDay`), instead of a second copy of
  the occurrence logic. Only today's date is accepted (any other → 409 `notFree`).
- Swagger: `@ApiCreatedResponse(appointmentSchema)`, 409 with `code: notFree | notStarted`.

**Check:** int tests: walk-in on a started meeting → 201 `DONE`, `booked` grows; on a full meeting →
201 and `booked > capacity`; yesterday's meeting → 409 `notFree`; a meeting starting later today → 409
`notStarted`; a cancelled date or a time that isn't the meeting → 409 `notFree`; a master of
someone else → 403. Commit `feat(appointments): walk-ins`.

### - [x] B11: slots can include meetings that have started or are over

**Why:** the calendar grid shows past meetings faded, with their bookings (common plan, «Past meetings stay on the grid»).
`GET /slots` cuts at `notBefore: now` (`schedule.controller.ts`, `slots.ts`), so a meeting that has
started would vanish from the grid with its bookings; the front can't rebuild its capacity or title.

**Branch:** `e6/past-slots` from `main`. **Files:** `src/schedule/schedule.schema.ts` (`slotsQuery`),
`src/schedule/schedule.controller.ts` (`SlotsController`), `test/` int test of slots (find it:
`grep -ln "slots" test/*`).

`GET /businesses/:id/slots` gets an optional `includePast` (boolean, default `false`; the schema
parses the query string `true` / `false`, anything else is a 400 like the other query errors). With
`true` the controller passes the start of the range's first local day (`startOfDay`, as B10 does for
walk-ins) instead of `new Date()` as `notBefore`; `ScheduleService.slots` already takes it, so no
change there. Nothing else changes: the 31-day cap, `staffId`, the booked-hours filter. The front
uses only the meetings (`groupId` / `oneOffSessionId` set) from this answer.

- Swagger: describe the flag and say the default answer is from now on.
- Don't change `create` / `move`: they still ask `slots()` from now and refuse a started meeting.

**Check:** int tests on `GET /slots`: a group meeting that started an hour ago with 2 seats booked is
absent without the flag, present with `includePast=true` and `booked: 2`, `capacity` right; a full one
has `full: true`; yesterday's meeting is present with the flag for a range that includes yesterday; the
same request without the flag is byte-identical to before; `includePast=maybe` → 400; a cancelled
group date stays absent. Commit `feat(slots): meetings that have started on request`.
