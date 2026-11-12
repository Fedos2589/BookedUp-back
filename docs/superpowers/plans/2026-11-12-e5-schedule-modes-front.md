# E5 schedule modes — kit and front — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus the repo's AGENTS.md. If the task turns out
> bigger than described, stop and say so — it gets split, not pushed through. Tick the task's box
> when its check passes, commit, don't push.

**Goal:** the «График» page in the cabinet: a master's schedule in hours mode (weekly hours, day
overrides, time off) or groups mode (groups with a seat limit, cancellations, one-off sessions).

**Spec:** `docs/superpowers/specs/2026-11-12-e5-schedule-modes-design.md` (sections «Кит», «Фронт»,
mockup variant A next to it). Back is done (PR #14). Step order from the spec: kit → front hours →
front groups; each step is one branch and one PR, reviewed before the next.

## Global constraints

- Kit (`~/work/ted-ui`): its AGENTS.md and topic skills (`kit-styles`, `kit-a11y`, `kit-text`,
  `kit-tests`) rule. Kit knows nothing about BookedUp.
- Front (`~/work/BookedUp-front`): its AGENTS.md rules; every form calls `useUnsavedInput`
  (`src/pwa/unsavedInput.ts`); texts in `src/locales/en.json` and `ru.json`; API only through the
  Orval client (`src/api/*`, `src/apiFetch.ts`); one component per file (oxlint
  `react/no-multi-comp`).
- Dates and times are on the business's clock; the back takes and returns local dates as
  `YYYY-MM-DD` and times as minutes after midnight.
- Front checks before every commit: `npm run typecheck && npm run lint && npm test`.
- Kit checks before every commit: `npm run typecheck && npm run lint && npm test && npm run build-storybook`.

## Back routes the front uses

All under `/businesses/:businessId/staff/:staffId/`; the staff list (`GET /businesses/:id/staff`)
carries `scheduleMode`.

| Mode   | Routes                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| both   | `PUT schedule-mode`, `GET/POST time-off`, `DELETE time-off/:id`                                                                                               |
| hours  | `GET/PUT weekly-windows`, `GET day-overrides`, `PUT/DELETE day-overrides/:date`                                                                               |
| groups | `GET/POST groups`, `PUT/DELETE groups/:groupId`, `PUT/DELETE groups/:groupId/cancellations/:date`, `GET/POST one-off-sessions`, `DELETE one-off-sessions/:id` |

Who may change whose schedule (back `StaffService.authorizeFor`): one's own always; a member's if
the actor's role manages that member's role; a staff without an account counts as `MASTER`.

---

## Step A — kit `TimePicker` (branch `feature/time-picker` in TedUI)

### - [ ] K1: `TimePicker` component

**Decided:** native `<input type="time">` (iOS wheel, Android clock, desktop segmented field), no
new dependency, 24-hour value.

**Files:**

- Create: `TimePicker/TimePicker.tsx`, `TimePicker/TimePicker.module.scss`,
  `TimePicker/TimePicker.stories.tsx`, `TimePicker/index.tsx`
- Create: `TimePicker/timeValue.ts` + `TimePicker/timeValue.test.ts` — `minutesToTime(540) → "09:00"`,
  `timeToMinutes("09:00") → 540`, `""` → `null`; reject out-of-range input
- Modify: root `index.tsx` (export)
- Read first: `Input/Input.tsx`, `Input/InputShell/InputShell.tsx` (label, hint, error wiring),
  `.claude/skills/add-component/SKILL.md`

**API:** `value: number | null`, `onChange(minutes: number | null)`, `step?: number` (minutes,
passed to the input as seconds), `min?`/`max?` (minutes), plus `label`, `hint`, `error`, `size`
like `Input`; native props spread.

**Done when:** kit checks green; story shows empty / with value / error / disabled with 0 a11y
violations; on a phone-width story the native picker opens.

### - [ ] K2: release and bump in the front

Use the `release` skill after K1's PR is merged: minor version, tag, bump in BookedUp-front.
**Done when:** front `package.json` points at the new tag and front checks are green.

---

## Step B — front, hours mode + time off (branch `e5/schedule-hours`)

### - [ ] F1: regenerate the API client

Run the back from `main` on :3000, then `npm run api:generate` in the front.
**Files:** `src/api/**` (generated only). If `OneOffWindow` was used anywhere, the typecheck shows
it — remove those uses.
**Done when:** typecheck green; `src/api` has the schedule routes from the table above.

### - [ ] F2: `/schedule` page shell — master picker and mode switch

**Files:**

- Create: `src/pages/schedule/SchedulePage.tsx`, `src/pages/schedule/editableStaff.ts` +
  `editableStaff.test.ts` (pure: who the actor may edit, by the rule above; uses `roleManages`
  from `src/business/roles.ts`)
- Modify: `src/app/router.tsx` (child of cabinet, like `/team`), `src/pages/cabinet/CabinetLayout.tsx`
  (menu item «График» / «Schedule»), `src/locales/{en,ru}.json`
- Read first: `src/pages/team/TeamPage.tsx` (how a cabinet page loads data), `src/business/currentBusiness.ts`

**Behaviour:** a master sees only their own schedule (no picker); someone who may edit others gets
a picker (only editable staff). Under it `TabsRounded` «Индивидуальные клиенты / Группы» that
calls `PUT schedule-mode`; below, an empty placeholder per mode (filled by F4–F6, G1–G3).
**Done when:** checks green; `editableStaff` tests cover owner / admin / master / staff without account.

### - [ ] F3: week model (pure, no UI)

**Files:** Create `src/pages/schedule/hours/weekModel.ts` + `weekModel.test.ts`.
**Content:** from the `GET weekly-windows` answer to a form state (7 days × `{ working, intervals:
{start, end}[] }`, one `slotMinutes`) and back to the `PUT` body (slotMinutes written into every
window); validation: end after start, intervals of a day don't overlap, a working day has ≥1
interval. An interval may end after midnight only if the back allows it — check the back's
`weeklyWindowsSchema` in `src/schedule/schedule.schema.ts`, don't guess.
**Done when:** tests for round-trip, overlap, empty working day, mixed slotMinutes from the API
(take the most common one).

### - [ ] F4: weekly hours table

**Files:** Create `src/pages/schedule/hours/WeeklyHours.tsx` (+ one file per row component if
needed); Modify `SchedulePage.tsx` (render in hours mode), locales.
**Behaviour:** mockup variant A: a row per weekday — `Checkbox` «работаю», intervals with two
`TimePicker`s, «+ интервал», `IconButton` delete; slot step selector; «Сохранить» / «Отменить»
at the bottom, one `PUT`; `useUnsavedInput` while dirty; validation errors from `weekModel`.
**Done when:** checks green; live: change a day, save, reload — the change is there.

### - [ ] F5: day overrides

**Files:** Create `src/pages/schedule/hours/DayOverrides.tsx`, `DayOverrideDialog.tsx`; Modify
`SchedulePage.tsx`, locales.
**Behaviour:** «Отдельные даты» list (date + intervals or «выходной»), «+ Дата» opens a `Modal`:
`DatePicker`, intervals (reuse F4's interval row) or «выходной» → `PUT day-overrides/:date`;
delete → `DELETE`. Only future dates (the back answers 400 on past ones — show it as a field error).
**Done when:** checks green; live: add, edit, delete an override.

### - [ ] F6: time off

**Files:** Create `src/pages/schedule/timeOff/timeOffRange.ts` + test, `TimeOff.tsx`,
`TimeOffDialog.tsx`; Modify `SchedulePage.tsx` (both modes), locales.
**Content:** `timeOffRange` — from «с даты по дату» (both inclusive) to the API instants: midnight
of the first day and midnight of the day after the last, on the business's time zone (DST tests:
Europe/Berlin around the last Sunday of March and October). Back: a record that doesn't sit on
midnights is shown with times; any record can be deleted. Form: `DatePicker` range + note.
**Done when:** checks green including DST tests; live: add a week off, see it, delete it.

---

## Step C — front, groups mode (branch `e5/schedule-groups`)

### - [ ] G1: group cards

**Files:** Create `src/pages/schedule/groups/Groups.tsx`, `GroupCard.tsx`; Modify `SchedulePage.tsx`, locales.
**Behaviour:** card «Футбол, дети 7–10 · Вт, Чт · 15:00–16:00 · до 12 человек», description
collapsed to the first lines with «ещё», delete with confirmation.
**Done when:** checks green; live: groups created through the API show, delete works.

### - [ ] G2: group form

**Files:** Create `src/pages/schedule/groups/GroupDialog.tsx`, `groupForm.ts` + test (form ↔ API
body, validation like the back: title 1–100, description ≤ 2000, capacity 1–1000, end after start);
Modify `Groups.tsx`, locales.
**Behaviour:** `Modal` for create and edit: title `Input`, description `Textarea`, days `TagSelect
multiple`, start/end `TimePicker`, seats; `POST groups` / `PUT groups/:id`; 409 → message from
the body's `conflictsWith`.
**Done when:** checks green; live: create, edit.

### - [ ] G3: cancellations and one-off sessions

**Files:** Create `src/pages/schedule/groups/GroupDates.tsx`, `CancelDateDialog.tsx`,
`OneOffSessionDialog.tsx`, `groupDays.ts` + test (which dates a group meets — the date picker only
offers those); Modify `Groups.tsx` / `SchedulePage.tsx`, locales.
**Behaviour:** «Отдельные даты»: cancel a group's session on a date it meets (`PUT
cancellations/:date`), undo (`DELETE`; 409 when a one-off session sits there now — show why);
«+ Разовое занятие» — same fields as G2 with a date instead of days; 409 → `conflictsWith`.
**Done when:** checks green; live: cancel, un-cancel, add a one-off session over a cancelled date.
