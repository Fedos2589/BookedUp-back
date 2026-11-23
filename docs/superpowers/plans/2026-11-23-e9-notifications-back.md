# E9 notifications and reminders — back — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus the repo's AGENTS.md (and the skills it
> points to). If the task turns out bigger than described, stop and say so — it gets split, not
> pushed through. Tick the task's box when its check passes, commit, don't push.
>
> **When a step is merged:** its last task updates the step's row in the common plan.

**Status:** not started.

**Common plan** (goal, decisions 1–11, the front's step): `2026-11-23-e9-notifications.md` next to this
file. Open it only if a task leaves a question this file doesn't answer — the decisions are referred to
below as «D1»…«D11».

**Two steps, two branches, two PRs**, each reviewed by Opus before the next:

- **N (N1–N10), branch `e9/notifications` from `main`:** tables, events, reminders, sending through a
  log channel, settings routes. Works end to end with every message in the log.
- **M (M1–M9), branch `e9/channels` from `main` after N is merged:** Telegram, Web Push, WhatsApp,
  email, the routes that turn them on — for the client (by the manage link) and for a member (in the
  cabinet).

## Global constraints

- AGENTS.md and its skills rule (`back-prisma` for the migrations, `back-access` for routes and roles,
  `back-api-contract` for schemas, `back-nest` for ESM and modules, `back-schedule` for times).
- Everything lives in a new module `src/notifications/`; a channel is one class behind one interface
  (`Channel` in N6) — no `if (kind === 'TELEGRAM')` outside its own file and the registry.
- Every query on these tables has `businessId` in `where` (the deliveries table goes through its event's
  `businessId`), except the dispatcher's «what is due» scans, which run across businesses by design —
  say so in a comment there.
- Outside services are called with `fetch` through a small client class per service, injected, so tests
  replace it with a fake. No network in tests.
- Times: `Business.timeZone`, never the server's; texts en / ru only.
- Logs through `nestjs-pino`, errors under `err`. Never log a manage link, a Telegram chat id with a
  name, a push subscription or a phone in full (the log channel prints the message text and a masked
  address: last 4 characters).
- Unique values in int tests from `randomUUID()`. Int tests never need Redis: they call the services'
  methods (`dispatch(now)`, `scheduleReminders(now)`) directly.
- Checks before a commit: `npm run typecheck && npm run lint && npm test && npm run test:int`.
  Commit messages via `git commit -F - <<'EOF'`.

## Review focus (for the Opus review of each PR)

N:

1. Every booking change that should notify writes its event in the same transaction (book, walk-in,
   online book, move, online move, cancel, online cancel); a failed change leaves none.
2. Two `dispatch(now)` running at once send each delivery once (`FOR UPDATE SKIP LOCKED`, unique keys).
3. Reminders: moved → the new time only; cancelled → none; booked after the reminder's time → none;
   two runs → one event (unique index, not a check in code).
4. Recipients: the master who acted gets nothing; another master's booking never reaches a master;
   `notifyAllOnline` only for owner / admin and only for online changes (actor `null`).

M:

1. A Telegram chat, push subscription or email turned on from booking A's link gets booking A's
   messages only (D4); a client's WhatsApp reaches the phone of the card; a member's channels get only
   the businesses they are a member of, and only what N4's rules give them.
2. The webhook refuses a request without the secret; a link token works once and expires in an hour;
   only its hash is stored.
3. The manage link lives only in the `CHANNEL_ON` event's payload and is wiped after it is sent (D5).
4. A missing key in env: the app starts, the channel is not listed as on, its routes answer 404
   `channelOff`.

---

## Step N — the engine

### - [x] N1: tables

**Files:** `prisma/schema.prisma`, a new migration `prisma/migrations/<ts>_notifications/`,
`test/schema.int-spec.ts`.

Add (names in the DB in snake_case, like the rest):

- `Business.reminderOffsets Int[]` (`reminder_offsets`, minutes), default `{1440}`. CHECK:
  `reminder_offsets <@ ARRAY[60,120,180,1440,2880] AND cardinality(reminder_offsets) <= 3` (D9).
- `User.notifyEmail Boolean @default(true)` (`notify_email`) — the account's email channel (D6).
- `Membership.notifyAllOnline Boolean @default(true)` — owner / admin only get it offered (D6).
- `Appointment`: `@@unique([businessId, id])` (what the new tables reference with `business_id`).
- enum `ChannelKind { EMAIL TELEGRAM WHATSAPP PUSH LOG }`.
- `UserChannel` (`user_channels`): `id`, `userId` (FK users, cascade), `kind ChannelKind`, `address
String` (chat id / E.164 / push endpoint), `keys Json?` (push), `createdAt`. CHECK `kind IN
('TELEGRAM','WHATSAPP','PUSH')` (the account's email is `users.email` + `notify_email`). Unique
  `(user_id, kind, address)`; at most one TELEGRAM and one WHATSAPP per user (partial uniques), push —
  one row per device.
- `ClientChannel` (`client_channels`): `id`, `businessId`, `clientId`, `appointmentId?`,
  `kind ChannelKind`, `address String` (chat id / E.164 / push endpoint / email ≤ 254), `keys Json?` (push
  `p256dh`, `auth`), `locale String` (`en`|`ru` CHECK), `createdAt`. Composite FKs `(businessId, clientId)` →
  clients and `(businessId, appointmentId)` → appointments, both cascade. CHECKs: `kind IN
('TELEGRAM','WHATSAPP','PUSH','EMAIL')`; `(kind = 'WHATSAPP') = (appointment_id IS NULL)` (D4). Unique
  `(business_id, client_id, kind, address, appointment_id) NULLS NOT DISTINCT`.
- enum `NotificationKind { BOOKED MOVED CANCELLED REMINDER CHANNEL_ON }`.
- `NotificationEvent` (`notification_events`): `id`, `businessId`, `appointmentId` (composite FK,
  cascade), `kind`, `actorUserId String?` (null = the client online or the system), `startsAt` (the
  booking's start when the event was written), `offsetMinutes Int?` (REMINDER only), `channelId
String?` (CHANNEL_ON only: the channel just turned on, FK client_channels, cascade), `payload Json?`
  (CHANNEL_ON: `{ manageLink }`), `processedAt DateTime?`, `createdAt`. Index `(processed_at)` partial
  `WHERE processed_at IS NULL`. Partial unique `(appointment_id, offset_minutes, starts_at) WHERE kind =
'REMINDER'` (D2). CHECKs: `offset_minutes` set ⇔ REMINDER; `channel_id` set ⇔ CHANNEL_ON.
- enum `DeliveryStatus { PENDING SENDING SENT FAILED }`.
- `NotificationDelivery` (`notification_deliveries`): `id`, `businessId`, `eventId` (FK, cascade),
  `channel ChannelKind`, `address String`, `audience String` (`client`|`staff` CHECK), `locale`,
  `status DeliveryStatus @default(PENDING)`, `attempts Int @default(0)`, `lastError String?`,
  `createdAt`, `sentAt?`. Unique `(event_id, channel, address)` (D3). Index `(status)` partial
  `WHERE status IN ('PENDING','FAILED')`.

**Check:** `test/schema.int-spec.ts` — a reminder offset of 30 is refused; a 4th offset is refused;
WhatsApp with an `appointment_id` and Telegram or email without one are refused; a second
TELEGRAM `user_channel` for one user is refused; the same reminder key twice is
refused; the same `(event, channel, address)` twice is refused. `npx prisma migrate reset --force` on
the dev DB is clean. Commit `feat(notifications): tables`.

### - [x] N2: an event with every booking change

**Files:** create `src/notifications/{notifications.module.ts,notification-events.ts}`,
`src/appointments/{appointments.service.ts,appointments.module.ts}`, `src/public-booking/public-booking.service.ts`
(only if it needs to pass something through), `test/notification-events.int-spec.ts`.

`recordEvent(tx, { businessId, appointmentId, kind, actorUserId, startsAt })` — one insert on the
transaction it is given. Call it inside the existing transactions of `book` (BOOKED; a walk-in made
as DONE writes none — it already happened), `relocate` (MOVED, the new `startsAt`; payload `{ fromStaffId, fromStartsAt }`, written only when the time or the master changed), and in `transition`
only for → `CANCELLED` (wrap the conditional update and the insert in one `$transaction`). Actor: the
cabinet's `AuthUser.id`; online paths (`bookOnline`, `moveOnline`, `cancelOnline`) pass `null`.

**Check:** int test — cabinet booking → one BOOKED event with the actor; online booking → actor
`null`; move → MOVED with the new start; cancel → CANCELLED; DONE / NO_SHOW → no new event; a 409
(slot taken) → no event; a walk-in → no event. Commit `feat(notifications): an event with every booking change`.

### - [x] N3: message texts

**Files:** create `src/notifications/{messages.ts,messages.spec.ts}`.

Pure `messageFor(input): { subject: string; text: string }` with input `{ kind, audience: 'client' |
'staff', locale: 'en' | 'ru', businessName, masterName, title: string | null (group / session),
startsAt: Date, fromStartsAt? (MOVED), fromMasterName? (MOVED to another master), timeZone, clientName (staff only), offsetMinutes? (REMINDER), manageLink? (CHANNEL_ON) }`.
Client: BOOKED «You're booked: Thu 27 Nov, 17:00, with Anna, Studio X» (CHANNEL_ON is the same text +
the link + «You'll get reminders here»); MOVED «moved to …»; CANCELLED «cancelled»; REMINDER «Tomorrow
at 17:00…» / «In 2 hours…» (from the offset). Staff: «New booking: Maria, Thu 27 Nov 17:00» / moved
from → to (`fromStartsAt` from the MOVED payload; the master's name changes too if `fromStaffId` differs) / cancelled. Dates through `Intl.DateTimeFormat`
with the business zone and the locale; plain text, no markup (Telegram is sent without `parse_mode`).

**Check:** `messages.spec.ts` — each kind × audience in en and ru (snapshot-free: assert the key
parts); a time near the DST change in `Europe/Berlin` shows the wall clock; no `manageLink` in staff
texts. Commit `feat(notifications): message texts`.

### - [x] N4: who gets an event

**Files:** create `src/notifications/{recipients.ts,recipients.spec.ts}`.

Pure `recipientsOf(event, ctx): Recipient[]`, `Recipient = { channel: ChannelKind; address; audience;
locale }`. `ctx`: the booking's master's `userId | null` (and, for MOVED with `payload.fromStaffId` different from it, the previous master's — they get the message too, as «moved away»), the business's memberships `{ userId, role,
email, locale, notifyEmail, notifyAllOnline, channels: { kind, address, keys }[] }[]`, the client
channels that apply (the caller already picked: not switched off (`disabled_at IS NULL`), WhatsApp of the person or their guardian, and Telegram
/ push / email with this `appointmentId` — D4), and `fallbackToLog: boolean`.

Rules: staff only for BOOKED / MOVED / CANCELLED. The master's account, unless `actorUserId` is that
account. Plus owners / admins with `notifyAllOnline` when `actorUserId === null`, unless they are the
actor. Dedupe by user. Per staff user: EMAIL to the account's address if `notifyEmail`, plus each of their
`user_channels`.
Client: every client channel for BOOKED / MOVED / CANCELLED / REMINDER; CHANNEL_ON → only the event's
`channelId`. With `fallbackToLog`, each recipient's channel becomes LOG (same address), so N works
before M.

**Check:** `recipients.spec.ts` — a table of cases: master acted → no staff; admin acted on a master's
booking → the master; online → master + owner, admin with the switch off left out; a master who is
also the owner gets one set; email off → only their linked channels; two push devices → two; REMINDER → clients only; CHANNEL_ON → the one
channel. Commit `feat(notifications): who gets an event`.

### - [x] N5: events into deliveries

**Files:** create `src/notifications/{dispatcher.service.ts}`, `src/notifications/notifications.module.ts`,
create `test/notification-dispatch.int-spec.ts`.

`DispatcherService.expand(now)`: in one transaction, `SELECT … FROM notification_events WHERE
processed_at IS NULL ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED`; for each, load the booking
(`businessId` in `where`), its master, the memberships (+ users, + `user_channels`), and the
client channels (D4: WhatsApp of the booking's client or of their guardian; Telegram / push / email
with this `appointmentId`); `recipientsOf`; `createMany(..., skipDuplicates: true)` into deliveries with the
event's `businessId`; set `processed_at`. `fallbackToLog` comes from a provider N6 defines — here a
constant `true`.

**Check:** int test — a booking with a master that has an account and an owner → after `expand`, the
expected delivery rows (channel LOG, audiences); a second `expand` adds nothing; two parallel `expand`
→ the same rows, no error. Commit `feat(notifications): events into deliveries`.

### - [x] N6: sending deliveries

**Files:** create `src/notifications/channels/{channel.ts,log.channel.ts,channel-registry.ts}`,
`src/notifications/dispatcher.service.ts`, `test/notification-dispatch.int-spec.ts`.

`interface Channel { kind; send(address, message, keys?): Promise<'sent' | 'unreachable'> }` (throws
on a retryable error). `LogChannel` logs `{ channel, to: masked, subject, text }` at `info`.
`ChannelRegistry` maps a kind to its channel; in N it has only LOG and `fallbackToLog = true`
(M turns this into «true when the real channel isn't configured and NODE_ENV ≠ production», D8).

`DispatcherService.send(now)`: claim up to 50 deliveries `status IN (PENDING, FAILED) AND attempts < 3`
with `UPDATE … SET status = 'SENDING', attempts = attempts + 1 … FOR UPDATE SKIP LOCKED RETURNING` (its
own transaction, committed before any call); render with `messageFor` (load what it needs, `businessId`
in `where`); call the channel; `SENT` + `sentAt`, or `FAILED` + `lastError` (message only), or on
`unreachable` mark `FAILED` with attempts = 3 and switch off that client channel (`disabled_at = now()`, the row stays: its events and deliveries hang on it) or delete that user channel (nothing hangs on it)
(an email `unreachable` changes nothing: the account's address stays, M6). A delivery
left `SENDING` is never picked again (D3). After the last delivery of a CHANNEL_ON event is out, set
its `payload` to `null` (D5). `dispatch(now)` = `expand` then `send`.

**Check:** int test with a fake channel registered for LOG: one booking → each recipient's message sent
once; two parallel `dispatch` → each sent once; the fake throws once → FAILED, the next `dispatch` sends
it; after 3 failures it stays FAILED; a row left `SENDING` is not sent again; `unreachable` sets `disabled_at` on
the client channel (the row and its event stay). Commit `feat(notifications): send deliveries`.

### - [ ] N7: reminders

**Files:** create `src/notifications/reminders.service.ts`, `src/notifications/notifications.module.ts`,
create `test/reminders.int-spec.ts`.

`scheduleReminders(now)`: one `INSERT … SELECT … ON CONFLICT DO NOTHING` (raw SQL, comment why it
scans every business): for each business offset `o`, bookings with `status = 'BOOKED'`,
`starts_at - o min` in `(now - 15 min, now]`, `starts_at > now`, `created_at <= starts_at - o min`
→ a REMINDER event with `offset_minutes = o`, `starts_at`, actor `null`. Moved bookings: `created_at`
stays the first one, which is right (a booking made two days ago and moved to tomorrow gets a reminder).

**Check:** int test with a fixed `now`: due → one event; run twice → one; outside the window → none;
cancelled → none; moved after an event was written → the old key stays, the new start gets its own
event when due; booked after the reminder time → none; offsets `[1440, 60]` → two events at their
times; `[]` → none. Commit `feat(notifications): reminders`.

### - [ ] N8: the queue that runs it

**Files:** create `src/notifications/{notifications.processor.ts,notifications.processor.spec.ts}`,
`src/notifications/notifications.module.ts`, `src/config/env.ts` (+ `env.spec.ts`), `.env.example`,
`test/test-app.ts`.

`BullModule.registerQueue({ name: 'notifications' })`; on module init, when `NOTIFICATIONS_WORKER` is
true, `upsertJobScheduler('tick', { every: 30_000 })`. The processor runs `scheduleReminders(now)` then
`dispatch(now)`, `now = new Date()`. Env `NOTIFICATIONS_WORKER: z.stringbool().default(true)`; the
processor and the scheduler are not registered when false (read how `@nestjs/bullmq` lets a module
register a processor conditionally — a dynamic module or a provider factory; pick the simplest that
keeps the worker off in tests). `test/test-app.ts` sets it to `false`.

**Check:** unit test — the processor calls both in order with one `now`; env test — default `true`,
`false` parses. By hand: `docker compose up -d`, `npm run start:dev`, book in the cabinet → within
30 s the log shows the master's LOG message. Note the hand check in the commit. Commit
`feat(notifications): run every 30 seconds`.

### - [ ] N9: reminder times in the business settings

**Files:** `src/business/{business.controller.ts,business.service.ts,business.schema.ts}`,
`test/business-access.int-spec.ts` or a new `test/reminder-settings.int-spec.ts`.

`GET /businesses/:businessId` answers `reminderOffsets: number[]` too. `PUT
/businesses/:businessId/reminders` `{ offsets: (60|120|180|1440|2880)[] }` (≤ 3, unique, sorted on
save) → the business; owner and admin only (`@Can…` as for members' roles — `back-access`); 400 on
anything else. Swagger: typed body and response, 400 / 403.

**Check:** int test — owner sets `[1440, 60]` → GET shows `[60, 1440]`; admin can; master → 403;
`[30]` → 400; `[1440, 1440]` → 400 (the CHECK lets repeats through; this schema is the only guard); 4 items → 400; another business's id → 403. Commit `feat(business): reminder times`.

### - [ ] N10: my notification switches, docs, close N

**Files:** create `src/notifications/{my-notifications.controller.ts,my-notifications.schema.ts}`,
`src/notifications/notifications.module.ts`, `test/my-notifications.int-spec.ts`, `AGENTS.md` (one line
in «Что где»), the common plan, this file.

Two routes, because email is the account's and «all online» is per business (D6):
`GET /me/notifications` → `{ email: boolean }`, `PUT` the same (signed in, `@Can.Anyone()`-style as
`/me`); `GET /businesses/:businessId/me/notifications` → `{ allOnline: boolean | null }` (`null` for a
master: not offered), `PUT` the same (a master sending a boolean → 400), own membership only,
`@MemberOfBusiness()`. M7–M8 add the channels to the first one. AGENTS.md: `src/notifications/` — events in the
booking's transaction, the 30 s tick, channels behind `Channel`, the log channel in development.

**Check:** int test — defaults true; a master gets `allOnline: null`; PUT changes only the caller's
user / membership; another business → 403. Tick N1–N10, set row N in the common plan to «done — PR #…» after
the merge. Commit `feat(notifications): my switches; docs`.

---

## Step M — real channels

Branch `e9/channels` from `main` after N is merged.

### - [ ] M1: Telegram channel

**Files:** create `src/notifications/channels/{telegram.client.ts,telegram.channel.ts,telegram.channel.spec.ts}`,
`src/notifications/channels/channel-registry.ts`, `src/config/env.ts` (+ spec), `.env.example`.

Env (optional): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` (both or none — a refine),
`TELEGRAM_WEBHOOK_SECRET`. `TelegramClient.call(method, body)` → `fetch('https://api.telegram.org/bot<token>/<method>')`,
JSON; returns `result` or throws with the description (never log the token). `TelegramChannel.send` →
`sendMessage { chat_id, text }`; 403 (blocked) / 400 «chat not found» → `unreachable`; 429 / 5xx →
throw. Registry: TELEGRAM is real when the token is set; `fallbackToLog` becomes per kind: «not
configured and NODE_ENV ≠ production» (D8); in production an unconfigured kind is skipped by
`recipientsOf`'s caller. The registry gets `isOn(kind)` — M8 and the routes use it.

**Check:** unit test with a fake `fetch`: the URL and body; 403 → `unreachable`; 500 → throws; env:
token without username → invalid. Commit `feat(notifications): Telegram channel`.

### - [ ] M2: Telegram link tokens

**Files:** `prisma/schema.prisma`, a migration `<ts>_channel_link_tokens`, create
`src/notifications/{link-tokens.service.ts,telegram-link.controller.ts,link.schema.ts}`,
`src/public-booking/{public-booking.controller.ts,public-booking.service.ts}`, `test/telegram-link.int-spec.ts`.

Table `channel_link_tokens`: `tokenHash` (unique), `businessId?`, `appointmentId?` (composite FK,
cascade), `userId?` (FK, cascade), `locale`, `manageLink String?`, `expiresAt`, `createdAt`; CHECK:
exactly one of `user_id` and `appointment_id`. Token and hash as `src/common/random-token.ts`. Routes:
`POST /me/telegram-link` (signed in, any user) → `{ url: 'https://t.me/<bot>?start=<token>' }`;
`POST /public/bookings/:token/telegram-link` `{ locale }` → `{ url }`, only while the booking can still
change (as the manage page's `canChange`; else 409), stores the `manageLink` rebuilt from the path
token (D5). 1 h TTL. Telegram off → 404 `channelOff`. The public route goes under the existing public
throttle.

**Check:** int test — both routes return a `t.me` URL with a 32+ char token; only the hash is in the DB;
a token of business A's booking is stored with A's ids; a cancelled booking → 409; no bot token → 404.
Commit `feat(notifications): Telegram link tokens`.

### - [ ] M3: Telegram updates

**Files:** create `src/notifications/{telegram-updates.service.ts,telegram-webhook.controller.ts,telegram-polling.ts}`,
`src/notifications/notifications.module.ts`, `test/telegram-updates.int-spec.ts`.

`handleUpdate(update)`: only `message.text` starting with `/start `. Find the link token by hash,
unexpired; delete it (one use). User token → upsert the user's TELEGRAM `user_channel` (a new chat
replaces the old one), reply «Connected: you'll get your bookings here» (in `User.locale`). Booking
token → insert a TELEGRAM `client_channel` with that `appointmentId` and `locale` = the token's (or
`language_code` when it is `en`/`ru`), and a CHANNEL_ON event with `payload: { manageLink }`, in one
transaction. Unknown / expired → reply «This link has expired, open it again». Replies go straight
through `TelegramClient`, not the outbox. `POST /telegram/webhook`: `@Public()`, compares
`X-Telegram-Bot-Api-Secret-Token` with the env secret in constant time (401 otherwise), always 200 after
handling (errors logged). Polling: when the token is set, the secret isn't, and NODE_ENV = development,
a loop on `getUpdates` (long poll 25 s, offset in memory), stopped on module destroy.

**Check:** int test with a fake client — user token → channel saved, reply sent; booking token →
channel + event, the token is gone; the same token again → «expired» reply; webhook without the header
→ 401, with it → 200. Commit `feat(notifications): link a Telegram chat`.

### - [ ] M4: Web Push channel, the client's route

**Files:** `package.json` (`web-push`), create `src/notifications/channels/{push.channel.ts,push.channel.spec.ts}`,
`src/notifications/push.schema.ts`, `src/public-booking/{public-booking.controller.ts,public-booking.service.ts}`,
`src/config/env.ts` (+ spec), `.env.example`, `test/public-channels.int-spec.ts`.

Env (all or none): `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (a `mailto:` or https URL).
`PushChannel.send` → `webPush.sendNotification({ endpoint, keys }, JSON.stringify({ title: subject,
body: text, url }))`, TTL 1 day; 404 / 410 → `unreachable`. `url`: for a client the business's
`/book/<slug>`, for staff the cabinet's `/calendar` (the delivery's audience decides). `push.schema.ts`:
`{ endpoint: https URL ≤ 1000, keys: { p256dh ≤ 200, auth ≤ 100 } }` — M7 reuses it. Routes:
`PUT /public/bookings/:token/push` `{ subscription, locale }` → upsert a PUSH channel for that booking +
CHANNEL_ON (only when new); `DELETE /public/bookings/:token/push` `{ endpoint }` (sets `disabled_at`, never deletes a client channel; a PUT of the same endpoint clears it, with a CHANNEL_ON again). Off → 404 `channelOff`.
`.env.example`: how to make keys — `npx web-push generate-vapid-keys`.

**Check:** unit — 410 → `unreachable`, 500 → throws; int — PUT twice → one channel, one event; DELETE
switches it off, PUT again switches it on; another booking's token can't switch it off; off → 404. Commit `feat(notifications): Web Push`.

### - [ ] M5: WhatsApp channel, the client's route

**Files:** create `src/notifications/channels/{whatsapp.client.ts,whatsapp.channel.ts,whatsapp.channel.spec.ts}`,
`src/notifications/messages.ts` (+ spec), `src/notifications/channels/channel.ts`, `src/notifications/dispatcher.service.ts`,
`src/public-booking/{public-booking.controller.ts,public-booking.service.ts}`, `src/config/env.ts` (+ spec),
`.env.example`, `test/public-channels.int-spec.ts`.

A WhatsApp row has `appointment_id` NULL, and Prisma's composite unique (`upsert`) refuses NULL parts: attach it with `INSERT … ON CONFLICT` in raw SQL (the unique index is `NULLS NOT DISTINCT`).

Env (all or none): `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`. WhatsApp sends templates only (D11):
`templateFor(input) → { name: 'bookedup_<kind>_<audience>', language: 'en'|'ru', params: string[] }` in
`messages.ts`, the same parts as the text. Change `Channel.send` to take the render input (and render
inside the channel: text channels call `messageFor`, WhatsApp `templateFor`) — one path, not two. The
channel sends `POST https://graph.facebook.com/v21.0/<phone id>/messages { messaging_product: 'whatsapp',
to, type: 'template', template: { name, language: { code }, components: [{ type: 'body', parameters }] } }`.
Error 131026 (not on WhatsApp) → `unreachable`; others → throw. Route `PUT
/public/bookings/:token/whatsapp` `{ locale }` → a WHATSAPP channel on the booking's client — or their
guardian when the client has no phone — with `address` = that phone (D4), + CHANNEL_ON (a switched-off row is switched on again); `DELETE` →
sets `disabled_at`.

**Check:** unit — the body for a reminder in ru; 131026 → `unreachable`; int — PUT → channel on the
card (no `appointmentId`); a dependent's booking → the guardian's card; another booking of the same
phone gets the WhatsApp messages too; off → 404. Commit `feat(notifications): WhatsApp`.

### - [ ] M6: email channel, the client's route

**Files:** create `src/notifications/channels/{email.channel.ts,email.channel.spec.ts}`,
`src/notifications/channels/channel-registry.ts`, `src/public-booking/{public-booking.controller.ts,public-booking.service.ts}`,
`src/config/env.ts` (+ spec), `.env.example`, `test/public-channels.int-spec.ts`.

Env (both or none): `RESEND_API_KEY`, `MAIL_FROM` (`BookedUp <no-reply@…>`). `EmailChannel.send` →
`fetch('https://api.resend.com/emails', { from, to, subject, text })`; 422 invalid address →
`unreachable`; 429 / 5xx → throw. In production without the key email is off (D8), logged once at
start. Route `PUT /public/bookings/:token/email` `{ email (z.email, ≤ 254, lowercased), locale }` → an
EMAIL channel on that booking (D4) + CHANNEL_ON; a second PUT with another address replaces it (the old row is switched off);
`DELETE` sets `disabled_at`; a PUT of an address that was switched off clears it.

**Check:** unit with a fake `fetch`: body, auth header, 422 → `unreachable`, 500 → throws; int — PUT →
channel on the booking + event; another booking of the same phone has no email channel; `NOT-AN-EMAIL`
→ 400; off → 404. Commit `feat(notifications): email`.

### - [ ] M7: a member's channels in the cabinet

**Files:** `src/notifications/{my-notifications.controller.ts,my-notifications.schema.ts}`,
`src/notifications/telegram-link.controller.ts`, `test/my-notifications.int-spec.ts`.

All under `/me/…`, the account's (D6), any signed-in user: `PUT /me/notifications/whatsapp` `{ phone }`
(the E.164 schema from `src/clients/clients.schema.ts`) → the user's WHATSAPP channel (replaces the old
one); `DELETE` the same. `PUT /me/notifications/push` `{ subscription }` (M4's schema) → a PUSH channel
for that device; `DELETE` `{ endpoint }` → removes only that one of the user's. `DELETE
/me/notifications/telegram` → removes the chat. A channel off → 404 `channelOff`. No CHANNEL_ON for
staff: nothing to confirm about a booking.

**Check:** int test — WhatsApp PUT twice → one channel with the new phone; two push devices → two rows,
DELETE one leaves the other; user A can't delete user B's endpoint (nothing removed); an online booking
of a master with Telegram + WhatsApp + push + email → after `dispatch`, four deliveries to the master.
Commit `feat(notifications): a member's channels`.

### - [ ] M8: what is on, for the front

**Files:** `src/public-booking/{public-booking.service.ts,public-booking.schema.ts}`,
`src/notifications/{my-notifications.controller.ts,my-notifications.schema.ts}`,
`test/public-booking.int-spec.ts`, `test/my-notifications.int-spec.ts`.

`GET /public/businesses/:slug` adds `channels: { telegram, whatsapp, push, email: boolean }` (which are
on, D8) and `pushKey: string | null` (the VAPID public key). `GET /public/bookings/:token` adds
`notifications: { telegram: boolean, whatsapp: boolean, push: string[] (endpoints, so a device knows if
it is one), email: string | null (masked: `m***@example.com`) }` — for this booking (D4; WhatsApp is the
card's). `GET /me/notifications` becomes `{ available: { telegram, whatsapp, push, email }, pushKey,
email: boolean, telegram: boolean, whatsapp: string | null (the phone), push: string[] (endpoints) }`.

**Check:** int tests — the flags follow env (a test module with and without the keys) and the linked
channels; another booking of the same phone shows `telegram: false`, `email: null`; the masked email
never shows the full local part. Commit `feat(notifications): which channels are on`.

### - [ ] M9: docs, close M

**Files:** create `docs/notifications.md`, `package.json` (a script), create `scripts/whatsapp-templates.ts`,
`AGENTS.md` («Что где», the `src/notifications/` line), `.env.example` (every key has a comment), the
common plan, this file.

`docs/notifications.md`: create the bot (BotFather), set the webhook (`curl
…/setWebhook?url=<API>/telegram/webhook&secret_token=…`), make VAPID keys, connect Resend (domain DNS),
the WhatsApp Cloud API number and token, and the templates to submit — a table of every `templateFor`
name × language with its text and parameters, printed by `npm run whatsapp:templates` from
`messages.ts`, so it can't drift. Tick M1–M9, set **Status** and row M in the common plan to «done —
PR #…» after the merge.

**Check:** `npm run whatsapp:templates` prints the table; `npm run format:check`. Commit
`docs: notification channels`.
