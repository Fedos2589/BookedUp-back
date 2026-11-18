# E8 clients — back — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus the repo's AGENTS.md (and the skills it
> points to). If the task turns out bigger than described, stop and say so — it gets split, not
> pushed through. Tick the task's box when its check passes, commit, don't push.
>
> **When the step is merged:** its last task updates the step's row in the common plan.

**Status:** to do.

**Common plan** (goal, decisions, the kit's and the front's steps): `2026-11-18-e8-clients.md` next
to this file. Open it only if a task leaves a question this file doesn't answer.

**Branch:** `e8/clients` from `main`, one PR, reviewed by Opus before merge.

## Global constraints

- AGENTS.md and its skills rule (`back-prisma`, `back-access`, `back-api-contract`, `back-nest`).
  New table follows the schema rules (`business_id NOT NULL`, snake_case plural, `Timestamptz(3)`,
  `uuidv7()`, `updated_at`, `@@unique([businessId, id])` for children's composite FKs).
- Strings bounded in zod: name 1–100 trimmed, phone E.164 ≤ 16 (reuse `clientName` / `clientPhone`
  from `appointments.schema.ts` — move them to `src/clients/clients.schema.ts` and import back),
  note ≤ 2000 (blank → `null`), `q` ≤ 100.
- Every route: `@ApiTags('clients')`, `@ApiOkResponse` / `@ApiCreatedResponse` with `openApi(schema)`,
  409 bodies described like `bookingConflictSchema`. `@MemberOfBusiness()` on the controller — the
  access test (`test/business-access.int-spec.ts`) picks new routes up by itself.
- Unique values in int tests from `randomUUID()`; phones built from it too (digits only).
- Checks before a commit: `npm run typecheck && npm run lint && npm test && npm run test:int`.
  Commit messages via `git commit -F - <<'EOF'`.

## Review focus (for the Opus review of the PR)

1. Two parallel `POST …/clients` with one phone → one 201, one 409 `phoneTaken` with the existing
   client's id (C2 test) — the unique index decides, the code only translates it.
2. Exactly one of `phone` / `guardianId` on every row (CHECK); a guardian always has a phone; a holder
   with dependents can't drop the phone (there's no way to drop it in the API at all).
3. `clientId` of another business in a booking → 404/400, never a booking (composite FK + service).
4. A `MASTER` gets only their own bookings in `GET …/clients/:id/appointments`; the counter is all.
5. Backfill: every existing booking gets a client; same phone in two businesses → two clients.
6. A booking's `clientName` / `clientPhone` are written once and never rewritten by a client edit.

---

### - [ ] C1: `clients` table, bookings point at it

> **Split (2026-11-18):** C1a — the table, its CHECKs and the schema tests, **done**; C1b — `appointments.client_id`
> (backfill, `NOT NULL`, FK), the temporary find-or-create-by-phone bridge in `AppointmentsService.create`
> (C5 replaces it), `createClient` helper and the 9 test call sites. C1b is the next task.

**Files:** `prisma/schema.prisma`, new migration `prisma/migrations/<ts>_clients/migration.sql`
(`npx prisma migrate dev --create-only --name clients`, then edit the SQL), `test/schema.int-spec.ts`.

**Model `Client` (`clients`):** `id, businessId, name String, phone String?, guardianId String?
@map("guardian_id") @db.Uuid, note String?`, timestamps. `@@unique([businessId, id])`,
`@@unique([businessId, phone])` (Postgres treats `NULL`s as distinct — dependents don't collide),
`@@index([businessId, guardianId])`. Self relation `guardian` / `dependents` by
`(business_id, guardian_id) → clients(business_id, id)` `ON DELETE NO ACTION ON UPDATE NO ACTION`.
`Business` gets `clients Client[]`.

**`Appointment`:** `clientId String @map("client_id") @db.Uuid`, relation by
`(business_id, client_id) → clients(business_id, id)` NO ACTION / NO ACTION (as `staff`),
`@@index([businessId, clientId, startsAt])`. Keep `clientName` / `clientPhone` (the snapshot).

**SQL to add / order in the migration:**

1. Create `clients` (Prisma's part) and the CHECKs:
   `clients_phone_or_guardian CHECK ((phone IS NULL) <> (guardian_id IS NULL))`,
   `clients_phone CHECK (phone ~ '^\+[1-9][0-9]{6,14}$')` (the same rule as `appointments_client_phone`).
2. Add `appointments.client_id` **nullable**, backfill, then `SET NOT NULL`, then the FK and index:
   ```sql
   INSERT INTO clients (business_id, name, phone)
   SELECT DISTINCT ON (business_id, client_phone) business_id, client_name, client_phone
   FROM appointments ORDER BY business_id, client_phone, starts_at DESC;
   UPDATE appointments a SET client_id = c.id
   FROM clients c WHERE c.business_id = a.business_id AND c.phone = a.client_phone;
   ```

**Check:** new cases in `test/schema.int-spec.ts` pass — a row with both `phone` and `guardian_id`
and a row with neither are refused; two holders with one phone in one business refused, in two
businesses allowed; two dependents of one guardian allowed; an appointment with a `client_id` of
another business refused (FK). The existing `business_id NOT NULL` / `timestamptz` sweeps stay green.
`npm run test:int` fully green — existing tests that insert appointments by SQL or Prisma get a client
via a small helper in `test/helpers.ts` (`createClient(prisma, businessId)`), if they need it.
Commit `feat(clients): table, bookings point at a client`.

> If fixing the existing tests that create appointments takes more than the helper and a line per
> call site, stop: C1 splits into «table» and «bookings point at it».

### - [ ] C2: create and find clients

**Files:** create `src/clients/{clients.module,clients.controller,clients.service,clients.schema}.ts`,
register in `src/app.module.ts`; `src/appointments/appointments.schema.ts` (import `clientName` /
`clientPhone` from the new schema); new `test/clients.int-spec.ts`.

**Schemas** (`clients.schema.ts`):

- `clientInput`: `{ name, note?, phone }` **or** `{ name, note?, guardianId: uuid }` — a
  `z.union` of two strict objects, so both or neither → 400.
- `clientSchema` (answer): `{ id, name, phone: string | null, guardianId: uuid | null,
guardian: { id, name, phone } | null, note: string | null, noShowCount: number }`.
- `clientsQuery`: `{ q?: string ≤ 100 trimmed, phone?: E.164, limit: 1–100 default 30,
offset: ≥ 0 default 0 }`; `clientsPageSchema`: `{ items: clientSchema[], total: number }`.
- `clientConflictSchema` (409): `code: 'phoneTaken' | 'notHolder'`, plus `clientId: uuid` for
  `phoneTaken` (the existing holder, so the form can offer them).

**Routes** under `/businesses/:businessId/clients`, `@MemberOfBusiness()` on the class, every method
`@MayInBusiness`-free (every member — Decision 1 of the common plan):

- `POST /` → 201 `clientSchema`. A dependent's `guardianId` must be a holder of this business:
  not found / not this business → 404; a dependent as guardian → 409 `notHolder`. A taken phone →
  409 `phoneTaken` from the unique violation (`violatedUniqueConstraint(e) === 'clients_business_id_phone_key'`),
  then look up the holder's id for the body.
- `GET /` → `clientsPageSchema`. `phone` given: that holder and their dependents (holder first, then
  by name), `q` / paging ignored. Otherwise `q` matches `name` `contains` (`mode: 'insensitive'`) or,
  when `q` has digits, `phone contains` those digits; dependents match by their guardian's phone too.
  Order by `name`, `id`. `total` from a `count` with the same `where`.
- `noShowCount` via `_count: { select: { appointments: { where: { status: 'NO_SHOW' } } } }`.

**Check:** `test/clients.int-spec.ts` — create a holder and a dependent; `GET ?phone=` returns both,
holder first; `GET ?q=` finds by part of the name in another case and by phone digits (the dependent
too); a phone taken → 409 `phoneTaken` with the holder's id; two parallel `POST`s with one phone →
one 201 and one 409; a dependent as guardian → 409 `notHolder`; a guardian from another business → 404;
`phone` + `guardianId` together → 400; `limit=1` gives one item and the right `total`.
Commit `feat(clients): create a client, search and look up by phone`.

### - [ ] C3: client card and editing

**Files:** `src/clients/clients.{controller,service,schema}.ts`, `test/clients.int-spec.ts`.

- `GET /:clientId` → `clientCardSchema` = `clientSchema` + `dependents: { id, name }[]` (by name)
  - `visitCount` (`DONE` bookings). Not this business → 404.
- `PATCH /:clientId` → `clientSchema`. Body `{ name?, phone?, note? }` (strict; `note: null` clears).
  `phone` on a dependent → 409 `notHolder` (moving a dependent to their own phone is out of E8).
  A taken phone → 409 `phoneTaken` as in C2. Past bookings are untouched (they keep the snapshot).

**Check:** int tests — the card of a holder lists their dependents and counts `NO_SHOW` / `DONE`
correctly (create bookings by Prisma with those statuses); renaming a client leaves an existing
booking's `clientName` as it was; `phone` on a dependent → 409 `notHolder`; another business's id →
404 on both routes. Commit `feat(clients): card and editing`.

### - [ ] C4: a client's bookings

**Files:** `src/clients/clients.{controller,service,schema}.ts`, `test/clients.int-spec.ts`.

`GET /:clientId/appointments?limit&offset` → `{ items: appointmentSchema[], total }`, newest first
(`startsAt desc, id desc`), cancelled included (it's history). A member without
`policy.seeAllBookings` (see `AppointmentsService.list`) gets only bookings with
`staff: { userId: actor.id }` — `total` counts the same set. Reuse `appointmentSelect` /
`appointmentSchema` from the appointments module (export them; don't copy).

**Check:** int test — a client with bookings at two masters: the owner sees both, the master of one
sees only theirs and `total: 1`; another business's client → 404. Commit
`feat(clients): a client's booking history`.

### - [ ] C5: booking takes a client

**Files:** `src/appointments/appointments.{schema,service}.ts`, `src/clients/clients.service.ts`
(export a `resolveForBooking(tx, businessId, input)`), `src/appointments/appointments.module.ts`
(import `ClientsModule`), `test/appointments.int-spec.ts`, `test/schedule-bookings.int-spec.ts`
(only where inputs change).

Booking (`appointmentInput`, and so walk-ins) replaces `clientName` + `clientPhone` with exactly one of:

- `clientId: uuid` — an existing person of this business (404 otherwise);
- `newClient: clientInput` — created in the same transaction as the booking (C2's rules and
  409 `phoneTaken` / `notHolder`; add `phoneTaken` / `notHolder` to `bookingConflictSchema` and
  `walkInConflictSchema` codes).

The snapshot is written from the resolved person: `clientName` = their name, `clientPhone` = their
phone or their guardian's. `appointmentSchema` gets `clientId`. `move` doesn't touch the client.

**Check:** int tests — booking by `clientId` writes the snapshot from the card (a dependent gets the
guardian's phone); booking with `newClient` creates the client and the booking, and when the slot
turns out not free neither is left (one transaction); `newClient` with a taken phone → 409
`phoneTaken` with the id; both `clientId` and `newClient` → 400; a walk-in by `clientId` works.
`npm run test:e2e` green. Commit `feat(appointments): a booking is for a client`.

### - [ ] C6: close the step

After the PR is merged: in `2026-11-18-e8-clients.md` set row C to «done — PR #N», this plan's
**Status** to «C1–C6 done», on a branch `docs/e8-back-done` from `main`. Commit, don't push.
