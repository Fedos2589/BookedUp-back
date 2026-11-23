# E7a online booking — back — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus the repo's AGENTS.md (and the skills it
> points to). If the task turns out bigger than described, stop and say so — it gets split, not
> pushed through. Tick the task's box when its check passes, commit, don't push.
>
> **When the step is merged:** its last task updates the step's row in the common plan.

**Status:** done, merged (P1–P3 in #38, P4–P9 in #39).

**Common plan** (goal, decisions, the kit's and the front's steps): `2026-11-18-e7-online-booking.md`
next to this file. Open it only if a task leaves a question this file doesn't answer.

**Branch:** `e7/public-booking` from `main`, one PR, reviewed by Opus before merge.

## Global constraints

- AGENTS.md and its skills rule (`back-access`, `back-api-contract`, `back-schedule`, `back-prisma`,
  `back-nest`, `back-auth` for the throttler).
- Everything public lives in a new module `src/public-booking/` (controller, service, schema):
  `@ApiTags('public-booking')`, `@Public()` on the controller, **never** a route under
  `/businesses/:businessId`. The service resolves `slug → businessId` once per request (404 `NotFound`
  when unknown) and passes `businessId` into every query — no query without it.
- Public answers carry nothing about other clients: no names, phones, notes, booking ids of others.
- Reuse, don't copy: slots come from `ScheduleService.slots`, booking from `AppointmentsService`,
  the client from `ClientsService`, the phone and name schemas from `src/clients/clients.schema.ts`,
  token helpers on the model of `src/invitations/invitation-token.ts`.
- Unique values in int tests from `randomUUID()`; phones built from it (digits only). Public routes
  are called without a cookie.
- Checks before a commit: `npm run typecheck && npm run lint && npm test && npm run test:int`.
  Commit messages via `git commit -F - <<'EOF'`.

## Review focus (for the Opus review of the PR)

1. Two parallel public bookings of one hours slot, and of the last seat of a meeting → one 201, one
   409 (P4 test) — the cabinet's lock and constraint decide, the public path adds no shortcut.
2. Every query in `src/public-booking/` and the new service methods has `businessId` in `where`; a
   token of business A can't read, cancel or move into business B.
3. The booking answer is identical for a known and a new phone (no «welcome back», no other names).
4. «Any master» never picks an archived master, a master in GROUPS mode, or a slot that isn't free.
5. Limits: the 11th booking from one IP within an hour → 429; the 4th live future booking of a phone
   → 409 `tooManyBookings`, counted inside the booking's transaction.

---

### - [x] P1: public business page data

**Files:** create `src/public-booking/{public-booking.module.ts,public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
`src/app.module.ts` (import the module), create `test/public-booking.int-spec.ts`.

`GET /public/businesses/:slug` → `{ name, slug, timeZone, masters: { id, name, scheduleMode }[] }`.
Masters: the business's staff with `archivedAt: null`, by name then id. `slug` param: the same shape
the sign-up schema checks (reuse it; ≤ 63 chars) — a malformed one is 400, an unknown one 404.
A service method `businessIdOf(slug)` that the next tasks reuse.

**Check:** int test — a signed-up business with two masters (one archived) answers its name, zone and
the live master only, with no cookie; unknown slug → 404; `A_B` → 400. Swagger lists the route under
`public-booking`. Commit `feat(public-booking): business and its masters by slug`.

### - [x] P2: public free slots

**Files:** `src/public-booking/{public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
`test/public-booking.int-spec.ts`.

`GET /public/businesses/:slug/slots?from&to&staffId?` → `Slot[]` — `ScheduleService.slots(businessId,
{ from, to, staffId }, now)`; the query is `slotsQuery` without `includePast` (`.omit`), so ≤ 31 days.
The answer's schema is `slotSchema` from `src/schedule/schedule.schema.ts` (it has counts, no client
data — confirm it and say so in the commit). `staffId` of another business → an empty list (the
filter has `businessId`), not an error.

**Check:** int test — a master with weekly hours and a group: the hours slots and the meeting with
`capacity` / `booked` come back; a booked hour is gone; `staffId` of another business's master → `[]`;
`to` 40 days after `from` → 400. Commit `feat(public-booking): free slots`.

### - [x] P3: manage token on a booking

**Files:** `prisma/schema.prisma`, a new migration `prisma/migrations/<ts>_appointment_manage_token/`,
create `src/public-booking/manage-token.ts` + `manage-token.spec.ts`.

`Appointment.manageTokenHash String? @unique @map("manage_token_hash")` — only online bookings have
one. `manage-token.ts`: `newManageToken()`, `hashManageToken(token)`, `manageLink(appUrl, slug, token)`
→ `<appUrl>/book/<slug>/manage/<token>` (same base handling as `invitationLink`). If the two token
helpers are identical to the invitation ones, move the shared pair to `src/common/random-token.ts`
and import it from both — don't keep two copies.

**Check:** `npm run db:migrate` applies on the dev DB; `test/schema.int-spec.ts` still green; unit
tests for `manageLink` with and without a path in `APP_URL`. Commit
`feat(appointments): manage token for online bookings`.

### - [x] P4: book online

**Files:** `src/appointments/appointments.service.ts`, `src/clients/clients.service.ts`,
`src/public-booking/{public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
`test/public-booking.int-spec.ts`.

`POST /public/businesses/:slug/bookings` with `{ staffId, startsAt, endsAt, groupId?, oneOffSessionId?,
name, phone, note? }` (`staffId` required here; P5 makes it optional) → 201
`{ booking: { id, staffId, staffName, startsAt, endsAt, title, groupId, oneOffSessionId }, manageLink }`.

- `AppointmentsService`: split `take` so its locked part (lock, `findSlot`, `full`, create) takes the
  person from a callback; the cabinet keeps passing `resolveForBooking`, the public path passes
  `ClientsService.resolveByPhone(tx, businessId, { name, phone })`. No actor and no
  `authorizeChangeOf` on the public path. Only `ahead` mode.
- `resolveByPhone`: the holder with that phone → `{ clientId: holder.id, clientName: <typed name>,
clientPhone: phone }` (card untouched); none → create the holder. Two parallel bookings with one new
  phone must end on one client, both booked (an `INSERT … ON CONFLICT DO NOTHING` then select, or
  Prisma's native upsert — whichever the test proves).
- Inside the same transaction, before creating: live future bookings of that client
  (`holdsTime`, `startsAt > now`) ≥ 3 → `409 { code: 'tooManyBookings' }`.
- The created booking gets `manageTokenHash`; the answer's `manageLink` uses `APP_URL` from
  `ConfigService<Env, true>`.
- `@Throttle({ default: { limit: 10, ttl: hours(1) } })` on this route.
- 409s: `notFree`, `full`, `tooManyBookings` — one schema like `bookingConflictSchema`, in Swagger.

**Check:** int tests — book an hours slot: 201, the booking is in the cabinet's `GET …/appointments`
with the typed name; known phone → same `clientId`, card name unchanged; two parallel requests for one
slot → 201 + 409 `notFree`; for the last seat → 201 + 409 `full`; two parallel new-phone bookings of
two slots → one client; the 4th → 409 `tooManyBookings`; the answer's keys are the same for a known
and a new phone. The cabinet's `appointments.int-spec.ts` stays green. Commit
`feat(public-booking): book a slot by name and phone`.

### - [x] P5: any free master

**Files:** `src/public-booking/{public-booking.service.ts,public-booking.schema.ts}`, maybe a pure
helper `src/public-booking/pick-master.ts` + spec, `test/public-booking.int-spec.ts`.

`staffId` becomes optional in the booking body; when absent, `groupId` / `oneOffSessionId` must be
absent too (400 otherwise — a meeting is always one master's). Candidates: the day's free hours slots
(`ScheduleService.slots` for that date, no `staffId`) with exactly this `startsAt` / `endsAt`; order
them by the master's live bookings that day (fewest first), then by name; book the first through P4's
path; on `notFree` try the next; none left → `409 notFree`. The ordering is a pure function with a
unit test.

**Check:** unit test of the ordering; int tests — two masters free at 10:00, the one with fewer
bookings gets it; the first taken in between (book it directly first) → the second gets it; a GROUPS
master's meeting at the same time is never picked; `staffId` absent with `groupId` → 400. Commit
`feat(public-booking): any free master`.

### - [x] P6: see and cancel by the link

**Files:** `src/public-booking/{public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
`src/appointments/appointments.service.ts` (only if the status change needs a no-actor entry),
`test/public-booking.int-spec.ts`.

`GET /public/bookings/:token` → `{ business: { name, slug, timeZone }, booking: { staffId, staffName,
startsAt, endsAt, title, status, groupId, oneOffSessionId }, canChange }` — `canChange`: BOOKED or
CONFIRMED and not started. `POST /public/bookings/:token/cancel` → the same shape, now `CANCELLED`;
started or not live → `409 badTransition`. Token param: `z.string().length(43)` base64url; unknown → 404. Look up by `manageTokenHash`, then every further query also has the found `businessId`. The
cancel reuses the status rule and the conditional update of `AppointmentsService.changeStatus`.

**Check:** int tests — read by token; cancel → the cabinet sees CANCELLED and the hour is free again in
public slots; cancelling twice → 409; a started booking → 409; a cabinet booking (no token) can't be
reached; malformed token → 400, unknown → 404. Commit `feat(public-booking): see and cancel by link`.

### - [x] P7: move by the link

**Files:** `src/appointments/appointments.service.ts`, `src/public-booking/{public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
`test/public-booking.int-spec.ts`.

`PATCH /public/bookings/:token` with `{ staffId?, startsAt, endsAt, groupId?, oneOffSessionId? }` →
the GET shape. Split `move` like P4 split `take`: the locked part is shared, the public path has no
actor and no `authorizeChangeOf`; `staffId` absent → the same master (no «any» on a move). Not
started and live, else `409 badTransition`; the same 409 `notFree` / `full` as booking.

**Check:** int tests — move to another free hour: the old one frees, the new one is taken; into a full
meeting → 409 `full`, booking unchanged; into a slot of another business's master (its `staffId`) →
404 / 409, never moved; a started booking → 409. The cabinet's move tests stay green. Commit
`feat(public-booking): move by link`.

### - [x] P8: the business's web manifest

**Files:** `src/public-booking/{public-booking.controller.ts,public-booking.service.ts}`,
`test/public-booking.int-spec.ts`.

`GET /public/businesses/:slug/manifest.webmanifest` → `Content-Type: application/manifest+json`,
`{ id: '/book/<slug>', name: <business name>, short_name: <name, ≤ 12 chars cut>, start_url:
'/book/<slug>', scope: '/book/<slug>', display: 'standalone', background_color, theme_color, icons }`
— colors and icon paths copied from BookedUp-front `vite.config.ts` (`VitePWA({ manifest })`), with a
comment naming that file. `Cache-Control: public, max-age=3600`. Swagger: an object schema.

**Check:** int test — the content type, `start_url` / `scope` of the slug, the business name; unknown
slug → 404. Commit `feat(public-booking): web manifest per business`.

### - [x] P9: docs and the common plan

**Files:** `.claude/skills/back-access/SKILL.md`, `AGENTS.md` (only the «Вход, доступ» paragraph, one
line), `docs/superpowers/plans/2026-11-18-e7-online-booking.md`, this file.

In `back-access`: a section «Публичные маршруты» — `/public/…`, `@Public()` on the controller, slug
or token → `businessId` once, every query filtered by it; limits per IP; no client data in answers.
In AGENTS.md: the exception for `/public/…` next to «Каждый маршрут требует входа». Tick the boxes,
set **Status** above, and the row P in the common plan to «done — PR #…» (after the merge).

**Check:** `npm run format:check`. Commit `docs: public booking routes`.
