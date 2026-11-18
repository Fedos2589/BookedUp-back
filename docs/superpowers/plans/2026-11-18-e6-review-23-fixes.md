# E6 — the lost review fixes of PR #23 — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus this repo's AGENTS.md and the skills it points
> to (`back-schedule`). If the task turns out bigger than described, stop and say so — it gets split,
> not pushed through. Tick the task's box when its check passes, commit, don't push.

**Where this comes from:** the review of back PR #23 (E6 B5+B6) was fixed in commit `a4c9728` on the
local branch `e6/slots-bookings`, five minutes before the PR merged. It was never pushed, so `main`
doesn't have it (checked 2026-11-18 against `main` bbc6596). Since then E8 (`ClientsService`,
`appointments.select.ts`, the client in `take`) changed the same files, so the commit doesn't
cherry-pick cleanly: port it by hand. `git show a4c9728` is the reference — what it does is right, the
code around it has moved.

The E6 common plan's B11 / K4 rows were stale («not started»); fixed on this branch already
(3d4fe8f, a cherry-pick of the unpushed `docs/e6-front-done`).

## R1: port `a4c9728` onto `main`

- [x] **Branch** `fix/e6-review-23` (this one).
- **Problem, four things missing from `main`:**
  1. **Move can undo a concurrent change.** `AppointmentsService.move` rereads the booking under the
     staff lock by `{ id, businessId }` only, then `update({ where: { id } })`. A status change takes
     no staff lock, so a cancel that lands between the reread and the update is overwritten by the
     move (the booking comes back to life); a move by someone else to another master isn't seen either.
     Fix: the reread also filters `staffId: current.staffId` (select `staffId` in the first
     `findFirst` too), a missing row is `409 badTransition` «The booking has just changed», and the
     write is `updateManyAndReturn({ where: { id, businessId, staffId: current.staffId, status:
booking.status }, … })` with the same 409 when it returns nothing.
  2. **A seat of another meeting doesn't hold the master's time in `freeSlots`.** `src/schedule/slots.ts`
     feeds `overlapsAny` only bookings with no meeting; the `appointments_no_overlap` constraint holds
     every live booking's time except against seats of the same meeting. So an hours slot (the master's
     mode changed after the seat was booked) or another group's meeting over a booked seat is offered,
     and booking it fails with 409 from the constraint. Fix as in the commit: every booking goes to
     `overlapsAny` with its `meeting` (`meetingOf`), and a slot is busy unless the overlapping interval
     is the slot's own meeting. Update the `freeSlots` paragraph in `.claude/skills/back-schedule/SKILL.md`
     as the commit does.
  3. **Swagger:** `PUT groups/:groupId` doesn't document its `409 hasBookings` — the conflict schema is
     `z.union([scheduleConflictSchema, hasBookingsSchema])` with the description from the commit.
  4. **Dead check and wording:** `take` has `if (!slot) throw notFree();` after `findSlot`, which throws
     that itself — drop it; `changeStatus`'s «The status has just changed» becomes «The booking has
     just changed», one message for both.
- **Files:** `src/appointments/appointments.service.ts`, `src/schedule/slots.ts`,
  `src/schedule/slots.spec.ts`, `src/schedule/groups.controller.ts`, `test/appointments.int-spec.ts`,
  `.claude/skills/back-schedule/SKILL.md`. Nothing else; if E8 code (`ClientsService`, the client in
  `take`) seems to need a change, stop and say why.
- **Tests (take them from the commit, adapted):**
  - `slots.spec.ts`: «lets a seat of another meeting hold the master's time, as the database does» and
    «keeps the slots of the meeting the seat belongs to»; in «does not count a seat of another
    occurrence…» the other group's seat moves off Tuesday's meeting (`'2026-11-17T14:00:00Z'`), or the
    new rule rightly hides that slot.
  - `appointments.int-spec.ts`: «refuses a move into a meeting with every seat taken with 409 full, and
    the seat stays» — the booking fixture now needs a client (see how neighbouring tests in the file
    book a seat today).
  - Fix 1 gets no new test, like the commit: the race (a cancel landing between the reread and the
    write) can't be timed over HTTP, and the guard is the conditional `where` — the same pattern
    `changeStatus` already uses. The existing move tests must stay green.
- **Check:** each new test fails without its fix and passes with it (mutation check by hand: back the
  file up to the scratchpad, revert one fix, run, `cp` back — never `git checkout -- file`).
  `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:int` (Docker) green. Front:
  `npm run api:generate` in `~/work/BookedUp-front` changes only the `PUT groups/:groupId` 409 type,
  and the front's `npm run typecheck` still passes (don't commit there; say if it doesn't).
- **Commit:** `fix(appointments): review of PR #23, lost before the merge` with the four points in the
  body; then tick this box and the row below in the same commit.

## Status

| Task | Status |
| ---- | ------ |
| R1   | done   |

After R1: Opus reviews the branch diff in a separate session, then the user pushes and opens the PR.
The local branches `e6/slots-bookings` and `docs/e6-front-done` can then be deleted.
