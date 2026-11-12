# E5 schedule modes — back — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A master's schedule gets a mode — hours (weekly windows + day overrides) or groups (groups with a seat limit, cancellations, one-off sessions) — and `/slots` answers by that mode with capacity and booked.

**Architecture:** Five tables change in one migration (mode on `staff`; `day_overrides`, `groups`, `group_cancellations`, `one_off_sessions` new; `one_off_windows` dropped). `freeSlots` stays the one pure function and stays mode-agnostic: the service hands it only the sources of each master's mode. Overlaps in groups mode are checked in code under a `FOR UPDATE` lock on the staff row; sessions among themselves also by `EXCLUDE`.

**Tech Stack:** NestJS 12, Prisma 7 (pg adapter), Postgres 18, zod 4, Vitest, supertest.

**Spec:** `docs/superpowers/specs/2026-11-12-e5-schedule-modes-design.md` (+ mockup next to it). This plan is step 1 of the spec's «Порядок работ»; the kit and the front get their own plans.

## Global Constraints

- Every new table: `business_id NOT NULL`, staff reached by `(business_id, staff_id) → staff(business_id, id) ON DELETE CASCADE`, snake_case plural `@@map`, `@db.Timestamptz(3)`, `id @default(dbgenerated("uuidv7()"))`, `updated_at @default(now()) @updatedAt` (AGENTS.md).
- A local date is `YYYY-MM-DD` on the business's clock (`LocalDate`, `src/schedule/local-time.ts`); a slot belongs to the day it starts.
- Every string has an upper bound in zod: title 1–100 (trimmed), description ≤ 2000 (trimmed, blank → `null`), capacity int 1–1000.
- Changes go through `StaffService.authorizeChangeOf`; reads through `StaffService.findIn` (404 for another business's master).
- Every route carries `@ApiOkResponse`/`@ApiCreatedResponse` with `openApi(schema)` — the front generates its client from it.
- Run `npm run typecheck` before every commit; commit messages via `git commit -F - <<'EOF'`.

## Review Focus

1. **A group that runs past midnight** (Sun 23:00, 120 min) — its occurrence belongs to Sunday, and a Monday one-off session at 00:30 conflicts with it. Test in Task 4.
2. **The clocks jump forward over a group's start** (Europe/Berlin, last Sunday of March, 02:30) — that occurrence is skipped, like a weekly slot, not shifted. Test in Task 2.
3. **Un-cancelling** a group's date when a one-off session was put there meanwhile — 409, the cancellation stays. Test in Task 4.
4. **Switching mode** keeps the other mode's data and `/slots` stops showing it at once; switching back brings it back. Test in Task 3.
5. **A day override on a date whose previous day's window runs past midnight** — the night slots from the previous day stay; the override's own slots that would overlap them are dropped by the no-overlap rule (earliest wins). Test in Task 2.

---

### Task 1: Migration — mode, day overrides, groups, cancellations, one-off sessions; one-off windows gone

**Files:**

- Modify: `prisma/schema.prisma` (Staff, remove `OneOffWindow`, add four models + enum)
- Create: `prisma/migrations/<timestamp>_schedule_modes/migration.sql` (via `npx prisma migrate dev --create-only --name schedule_modes`, then hand-written SQL appended)
- Modify: `src/prisma/unique-violation.ts` (comment: the EXCLUDE is now `one_off_sessions_no_overlap`)
- Test: `test/schema.int-spec.ts`

**Interfaces — Produces (Prisma models):**

- `enum ScheduleMode { HOURS GROUPS }`; `Staff.scheduleMode ScheduleMode @default(HOURS) @map("schedule_mode")`.
- `DayOverride` (`day_overrides`): `id, businessId, staffId, date @db.Date, windows Json` (array of `{startMinute, durationMinutes, slotMinutes}`), timestamps; `@@unique([staffId, date])`.
- `Group` (`groups`): `id, businessId, staffId, title, description String?, weekdays Int[] @db.SmallInt, startMinute, durationMinutes, capacity` (SmallInt), timestamps; `@@unique([businessId, id])`; `@@index([businessId, staffId])`.
- `GroupCancellation` (`group_cancellations`): `id, businessId, groupId, date @db.Date`, timestamps; `(business_id, group_id) → groups(business_id, id) ON DELETE CASCADE`; `@@unique([groupId, date])`.
- `OneOffSession` (`one_off_sessions`): `id, businessId, staffId, title, description String?, startsAt, endsAt, capacity`, timestamps; `@@index([businessId, staffId, startsAt])`.

- [ ] **Step 1: Write the failing schema tests** in `test/schema.int-spec.ts`:
  - `it('refuses a group with no weekdays, a weekday outside 1–7, or capacity 0')` — raw `INSERT` → each rejected by CHECK (`groups_weekdays`, `groups_capacity`).
  - `it('refuses two one-off sessions of one master that overlap')` — second `prisma.oneOffSession.create` throws, `violatedExclusion(error) === 'OneOffSession'`.
  - `it('refuses a second day override for the same master and date')` — P2002 on `day_overrides_staff_id_date_key`.
  - `it('refuses a cancellation that points at a group of another business')` — FK error.
    (The existing «every table has `business_id NOT NULL`» test covers the new tables by itself.)
- [ ] **Step 2: Run** `npm run test:int -- schema` → FAIL (models don't exist; typecheck errors count as failing).
- [ ] **Step 3: Schema + migration.** `--create-only`, then append SQL:
  - `groups`: `CHECK (cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])` as `groups_weekdays`; `start_minute BETWEEN 0 AND 1439`; `duration_minutes BETWEEN 1 AND 1440`; `capacity BETWEEN 1 AND 1000` as `groups_capacity`.
  - `one_off_sessions`: `starts_at < ends_at AND ends_at - starts_at <= interval '1 day'`; `capacity BETWEEN 1 AND 1000`; `EXCLUDE USING gist (staff_id WITH =, tstzrange(starts_at, ends_at) WITH &&)` as `one_off_sessions_no_overlap`.
  - `DROP TABLE one_off_windows` (Prisma writes it).
    Then `npm run db:migrate && npx prisma generate`.
- [ ] **Step 4: Run** `npm run test:int -- schema` → PASS. `npm run typecheck` will fail where `oneOffWindow` is still used — expected; Task 2 and Task 5 remove those uses. Leave the service compiling by deleting the one-off-window methods/routes/schemas and their `describe('the one-off windows of a master')` block now (they have no replacement until Task 5).
- [ ] **Step 5: Commit** `feat(schedule): tables for schedule modes; one-off windows dropped`.

### Task 2: `freeSlots` — day overrides, groups, cancellations, one-off sessions, capacity

**Files:**

- Modify: `src/schedule/slots.ts`
- Create: `src/schedule/group-occurrences.ts`
- Test: `src/schedule/slots.spec.ts`, `src/schedule/group-occurrences.spec.ts`

**Interfaces — Produces:**

```ts
// slots.ts
export interface DayWindow {
  startMinute: number;
  durationMinutes: number;
  slotMinutes: number;
}
export interface DayOverride {
  staffId: string;
  date: LocalDate;
  windows: readonly DayWindow[];
}
export interface Group {
  id: string;
  staffId: string;
  title: string;
  description: string | null;
  weekdays: readonly number[];
  startMinute: number;
  durationMinutes: number;
  capacity: number;
}
export interface OneOffSession {
  id: string;
  staffId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  capacity: number;
}
export interface SlotQuery {
  timeZone;
  weekly;
  dayOverrides: readonly DayOverride[];
  groups: readonly Group[];
  cancellations: readonly { groupId: string; date: LocalDate }[];
  oneOffSessions: readonly OneOffSession[];
  busy;
  from;
  to;
  notBefore;
} // `oneOff` removed
export interface Slot {
  staffId: string;
  startsAt: Date;
  endsAt: Date;
  title: string | null;
  description: string | null;
  capacity: number;
  booked: number;
  groupId: string | null;
  oneOffSessionId: string | null;
}
// group-occurrences.ts
export interface Occurrence {
  start: number;
  end: number;
  date: LocalDate;
}
export function groupOccurrences(
  group: Pick<Group, 'weekdays' | 'startMinute' | 'durationMinutes'>,
  cancelled: ReadonlySet<LocalDate>,
  timeZone: string,
  from: LocalDate,
  to: LocalDate,
): Occurrence[];
```

`groupOccurrences` walks dates `from..to` (the caller widens the range for windows from the day before), one occurrence per date whose ISO weekday is in `weekdays` and not in `cancelled`; start via `clockOf(timeZone)(wallOfDate(date) + startMinute*MINUTE)`, skipped when `undefined`; end = start + duration of real time.

- [ ] **Step 1: Failing tests** (existing one-off-window cases in `slots.spec.ts` are deleted; every existing expectation gains `description: null, capacity: 1, booked: 0, groupId: null, oneOffSessionId: null`):
  - `groupOccurrences`: `'gives a group on each of its weekdays, cancelled dates left out'`; `'skips a start the clocks jump over'` (Europe/Berlin, `2026-03-29`, startMinute 150 → none that day); `'puts a group that runs past midnight on the day it starts'`.
  - `freeSlots`: `'a day override replaces the weekly slots that start on its date'` (Mon 10–13 weekly, override Mon `[{600+120, 60, 60}]` → only 12:00 local); `'an override with no windows is a day off'`; `'keeps the night slots of the day before under an override'` (Sun 23:00 120/60 weekly, override Mon `[{0,120,60}]` → Sun 23:00, Mon 00:00 from the weekly, then Mon 01:00 from the override; the override's 00:00 dropped as overlapping); `'gives a group as one slot with its capacity, description and id'` (`capacity: 12, booked: 0, groupId, oneOffSessionId: null`); `'gives a one-off session as one slot with its id'`; `'leaves a cancelled date of a group out'`; `'takes time off out of group slots too'`.
- [ ] **Step 2: Run** `npx vitest run src/schedule` → FAIL.
- [ ] **Step 3: Implement.** Weekly candidates whose `date` has an override for that staff are dropped (a `Set` of `staffId|date`); override windows are cut like weekly windows on their own date (extract the inner loop of `weeklySlots` into `slotsOfDay(window, date, staffId, instantOf)` and reuse). Group candidates from `groupOccurrences(group, cancelledOf(group.id), timeZone, addDays(from, -1), to)`. Sessions: one candidate each. `withoutOverlaps`, the `from..to` filter, `notBefore` and `busy` stay as they are and apply to all.
- [ ] **Step 4: Run** `npx vitest run src/schedule` → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(schedule): slots from day overrides, groups and one-off sessions`.

### Task 3: Mode of a master; `/slots` by mode

**Files:**

- Modify: `src/staff/staff.schema.ts` (`staffSchema.scheduleMode: z.enum(['HOURS','GROUPS'])`), `src/staff/staff.service.ts` (`staffSelect`)
- Modify: `src/schedule/schedule.schema.ts` (`scheduleModeInput = z.object({ mode: z.enum(['HOURS','GROUPS']) })`; `slotSchema` gains `description, capacity, booked, groupId, oneOffSessionId`)
- Modify: `src/schedule/schedule.controller.ts` (`PUT staff/:staffId/schedule-mode` → `{ mode }`), `src/schedule/schedule.service.ts` (`setMode`, `slots`)
- Test: `test/schedule.int-spec.ts`, `test/staff.int-spec.ts` (list shows `scheduleMode: 'HOURS'`)

**Interfaces — Produces:** `ScheduleService.setMode(actor, businessId, staffId, { mode }): Promise<{ mode }>`; `slots()` loads, per master on the team, only its mode's sources (`HOURS`: weekly + day overrides; `GROUPS`: groups + cancellations + one-off sessions), time off for both.

- [ ] **Step 1: Failing int tests:** `describe('the mode of a schedule')` — `'is HOURS for a new master and is changed by whoever may change the schedule'` (master on own: 200; master on another's: 403); `'switching keeps the other mode's data, and slots follow the mode'` (weekly window + group on one master: HOURS → weekly slots only; GROUPS → the group slot only; back to HOURS → weekly again); the existing slot tests expect the new fields.
- [ ] **Step 2: Run** `npm run test:int -- schedule staff` → FAIL.
- [ ] **Step 3: Implement** (`slots` reads `staff.scheduleMode` with the masters it already filters; the group/session/override reads use the same `around` margin as time off).
- [ ] **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(schedule): a master's schedule mode; slots by mode`.

### Task 4: Day overrides API

**Files:** `schedule.schema.ts`, `schedule.controller.ts`, `schedule.service.ts`; Test: `test/schedule.int-spec.ts`

**Interfaces — Produces:**

- `dayOverrideSchema = { date: z.iso.date(), windows: DayWindow[] }`; input `{ windows: z.array(dayWindow).max(48) }` with `firstOverlap` on windows placed at weekday 1 → 400 `windows.N: Overlaps windows.M`; `slotMinutes <= durationMinutes` as in weekly.
- `GET staff/:staffId/day-overrides` → `DayOverride[]`, date ≥ today on the business clock, by date. `PUT …/day-overrides/:date` → upsert, 200 with the saved one. `DELETE …/day-overrides/:date` → 204, 404 if none.

- [ ] **Step 1: Failing int tests:** `'are put, listed by date and removed'`; `'an empty list is a day off and is listed'`; `'refuse overlapping windows with 400 and keep the old one'`; `'leave out dates before today'`; `'may be changed by a master for their own schedule only'`; `:date` added to the `a date that is no date` table.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (`prisma.dayOverride.upsert` on `staffId_date`). **Step 4: Run** → PASS; typecheck.
- [ ] **Step 5: Commit** `feat(schedule): day overrides replace a weekday on a date`.

### Task 5: Groups, cancellations, one-off sessions — and their conflicts

**Files:**

- Create: `src/schedule/group-conflicts.ts` (pure), Test: `src/schedule/group-conflicts.spec.ts`
- Modify: `schedule.schema.ts`, `schedule.controller.ts`, `schedule.service.ts`; Test: `test/schedule.int-spec.ts`

**Interfaces — Produces:**

```ts
// group-conflicts.ts — the first thing the candidate would overlap, or undefined
export type Conflict = { kind: 'group'; id: string; title: string; date: LocalDate }
                     | { kind: 'oneOffSession'; id: string; title: string; startsAt: string }
export function groupConflict(candidate: Group, others: { groups: Group[]; sessions: OneOffSession[];
  cancellations: { groupId: string; date: LocalDate }[] }, timeZone: string): Conflict | undefined
export function sessionConflict(candidate: { startsAt: Date; endsAt: Date },
  groups: Group[], cancellations: ..., timeZone: string): Conflict | undefined
```

Group vs groups: expand each to `{weekday, startMinute, durationMinutes}` per weekday and use `firstOverlap` (week ring). Group vs sessions / session vs groups: `groupOccurrences` over the session's dates `addDays(dateOf(startsAt), -1)..dateOf(endsAt)`.

- `scheduleConflictSchema = conflictErrorSchema(['startMinute','startsAt','date']).extend({ conflictsWith: conflict })` — 409, `message` names it: `Overlaps «Football» on 2030-01-08`.
- Routes under `staff/:staffId`: `GET/POST groups`, `PUT/DELETE groups/:groupId` (each group comes with `cancellations: LocalDate[]`, today on); `PUT/DELETE groups/:groupId/cancellations/:date` (PUT idempotent, 200); `GET/POST one-off-sessions` (not over yet, earliest first), `DELETE one-off-sessions/:id`.
- Group input: `title`, `description`, `weekdays` (int 1–7, 1–7 items, deduplicated and sorted by the schema), `startMinute`, `durationMinutes`, `capacity`. Session input: `title`, `description`, `startsAt`, `endsAt` (instants, ≤ 1 day, start < end), `capacity`.
- Every write here (group create/update, session create, cancellation delete) runs in one transaction that starts with `SELECT 1 FROM staff … FOR UPDATE`, reads the master's groups, future cancellations and future sessions, checks, writes. Session vs session also by `EXCLUDE` → the same 409 shape (`kind: 'oneOffSession'`, fetched after the violation).

- [ ] **Step 1: Failing unit tests** (`group-conflicts.spec.ts`): `'a group overlapping another on a shared weekday'`; `'groups on different weekdays at one time do not conflict'`; `'Sunday 23:00 for 120 min overlaps Monday 00:30'` (ring); `'a session over a group occurrence conflicts, unless that date is cancelled'`; `'a session on the morning after a group past midnight conflicts'`.
- [ ] **Step 2: Failing int tests:** `'groups are added, listed with their cancellations, changed and removed'`; `'a group overlapping another is 409 naming it'`; `'a session over a group is 409; cancel the date and it goes in'`; `'un-cancelling a date under a session is 409 and the cancellation stays'`; `'changing a group onto a session's time is 409'`; `'two sessions racing for one time: one 201, one 409'`; `'refuses capacity 0 / 1001, no weekdays, a title of 101 characters, a description of 2001 with 400'`; `'a master changes only their own groups'`; another business's group id → 404 on PUT/DELETE/cancellations.
- [ ] **Step 3: Run** → FAIL. **Step 4: Implement.** **Step 5: Run** unit + int → PASS; typecheck.
- [ ] **Step 6: Commit** (two commits: `feat(schedule): groups with a seat limit and cancellations`, `feat(schedule): one-off sessions; conflicts in groups mode`).

### Task 6: Docs and the full check; PR

**Files:** `AGENTS.md` (the «Услуг нет…» paragraph: modes, day overrides, groups, sessions, conflicts by lock + EXCLUDE; the `violatedExclusion` sentence names `one_off_sessions`), `test/business-access.int-spec.ts` (no change expected — it walks every route; run it).

- [ ] **Step 1:** Update AGENTS.md.
- [ ] **Step 2: Run** the whole list from AGENTS.md «Перед PR»: `format:check`, `typecheck`, `lint`, `test`, `test:e2e`, `test:int` (Docker), `build` → all green.
- [ ] **Step 3: Mutation-check by hand** (crapper/dryer/mutator not installed): flip the cancellation filter, the override `Set` check and the `FOR UPDATE` line one at a time (file backed up to the scratchpad and copied back) — each must turn a test red.
- [ ] **Step 4: Commit**, push `e5/schedule-modes`, `gh pr create` into `main`: title `E5 step 2: schedule modes — hours or groups with a seat limit`; body: what changed, the API list, the 409 shape, «one-off windows dropped», how to try it.
