# E7b client sign-in by phone, through Telegram — back — Implementation Plan

> **For the executor (Sonnet):** one task = one fresh session (`/clear` between tasks). Work inline,
> no subagents. Read only the files the task names plus the repo's AGENTS.md (and the skills it
> points to). If the task turns out bigger than described, stop and say so — it gets split, not
> pushed through. Tick the task's box when its check passes, commit, don't push.
>
> **When the step is merged:** S11 (or a follow-up) sets row S of the common plan to «done — PR #…».

**Status:** S1–S11 merged (#57–#61). Tails of the review of #58 on branch `e7b/tails-58`: limit and `opted_out_at` bug done; S12–S14 (sign-in code) done, PR #63; front F1 open.

**Common plan** (goal, decisions 1–6, the front's step): `2026-11-23-e7b-client-sign-in.md` next to this
file. Open it only if a task leaves a question this file doesn't answer — its decisions are «D1»…«D6»,
the ones made while splitting are «D7»…«D9» below.

**One step, one branch `e7b/client-sign-in` from `main`, one PR**, reviewed by Opus before the front starts.

## Decisions made while splitting (2026-11-25)

- **D7 (user):** no Telegram → no online booking. Without a client session `POST …/bookings` is 401; with
  Telegram off on the deployment the login route is 404 `channelOff` and the business answers
  `clientSignIn: false`, so the front says to call the business. No unconfirmed fallback.
- **D8 (user):** the confirmed chat becomes the client's Telegram **on their card** at the business
  (like WhatsApp now: `appointment_id IS NULL`), so every booking of that phone there — and of their
  dependents — gets the messages. Switched off from the E9 block like any channel.
- **D9 (proposed, check in the PR):** the confirmation proves a **phone**, not a client of one business:
  `client_logins` and `client_sessions` are global tables (no `business_id`, like `sessions`), one
  session works on every business's page, and each query by it is filtered by the slug's business.
  The card's Telegram is written when a booking is made (in its transaction, with the session's chat),
  not at confirmation — at confirmation there is no booking and maybe no card yet.

## Shape of the flow (what S4–S8 build)

```
front                                back                                   Telegram
POST /public/client-login {locale} → login row (nonce hash, browser hash)
                                   ← 201 {url: t.me/<bot>?start=<nonce>} + cookie cl=<browser secret> (10 min)
opens url ───────────────────────────────────────────────────────────────→ /start <nonce>
                                     bot: row.chat_id = chat → reply with «Share my phone» (request_contact)
                                                                          ← contact (user_id = from.id)
                                     bot: row.phone = +E.164, confirmed_at = now → «Confirmed, go back»
GET /public/client-login (cookie cl) → pending | expired | confirmed:
                                       one tx: delete the login, create a client session
                                   ← {status:'confirmed'} + cookie client=<session token> (30 days, sliding), cl cleared
POST /public/businesses/:slug/bookings (cookie client) → phone = session's, card Telegram = session's chat
```

Cookie names follow the cabinet's rule (`back-auth`): `__Host-client` / `__Host-cl` with Secure, `client` /
`cl` when `SESSION_COOKIE_SECURE=false`. Both `HttpOnly`, `SameSite=Lax`, `Path=/`. Only hashes are stored.

## Global constraints

- AGENTS.md and its skills rule (`back-prisma` for the migration, `back-auth` for cookies and limits,
  `back-api-contract` for schemas and errors, `back-nest` for ESM and modules).
- New code lives in a new module `src/client-session/` (cookies, logins, sessions, the guard), plus the
  bot's handling in `src/notifications/telegram-updates.service.ts` and the booking in `src/public-booking/`.
  Every route is under `@Controller('public')` with `@Public()` on the controller; the client's identity
  comes only from `ClientSessionGuard` (S7), never from the cabinet's `@CurrentUser()`.
- Every query on business tables carries the slug's `businessId`; the two new tables are global (D9).
- No network in tests: `TelegramClient.call` is spied, updates are fed to `handleUpdate` directly (see
  `test/telegram-updates.int-spec.ts`). Unique phones in int tests from `randomUUID()` digits.
- Never log a phone, a chat id or a token in full.
- Checks before a commit: `npm run typecheck && npm run lint && npm test && npm run test:int`.
  Commit messages via `git commit -F - <<'EOF'`.

## Review focus (for the Opus review of the PR)

The common plan's «Review focus across repos» 1–6, and:

1. The login is bound to the browser: the nonce alone (another browser, the bot's chat) never yields a
   session; the browser secret alone (no confirmation) neither. Both are single-use and expire in 10 min.
2. `contact.user_id === from.id` and the chat is private; a contact without `user_id` confirms nothing.
3. A booking made through a session can't carry another phone; a disabled card Telegram is not turned
   back on by a new booking (the client said no).
4. `my-bookings` and the by-id routes find only bookings of the session's phone (holder or guardian) at
   the slug's business; another's id is 404, same as a missing one.

## Left from the review of #58

- **Forwarded sign-in link** — split into S12–S14 below; the front's part is F1 (other repo).
- ~~**Rate limit of `POST /public/client-login`**~~ — done: 30 an hour per IP (CGNAT).
- ~~**A bug in main, `switchClientChannelOff`**~~ — done in `b8f59b7` (takes every row without `opted_out_at`).

---

### - [x] S1: tables

**Files:** `prisma/schema.prisma`, a new migration `prisma/migrations/<ts>_client_sign_in/migration.sql`,
`test/schema.int-spec.ts`.

- `client_logins`: `id uuid` (uuidv7), `nonce_hash text UNIQUE`, `browser_hash text UNIQUE`, `locale text`
  (CHECK en/ru, as `channel_link_tokens`), `chat_id text NULL`, `phone text NULL` (E.164 CHECK
  `^\+[1-9]\d{6,14}$`), `confirmed_at timestamptz NULL`, `expires_at timestamptz`, `created_at`. Index on
  `expires_at`, index on `chat_id`. CHECK: `confirmed_at IS NULL OR (phone IS NOT NULL AND chat_id IS NOT NULL)`.
- `client_sessions`: `id uuid`, `token_hash text UNIQUE`, `phone text` (same CHECK), `chat_id text`,
  `created_at`, `last_used_at`, `expires_at` (sliding: moved on use). Index on `expires_at`, on `phone`.
- `client_channels`: relax `CHECK (("kind" = 'WHATSAPP') = ("appointment_id" IS NULL))` to «WhatsApp is
  always on a card, Telegram may be on a card or a booking, push and email are always on a booking» (D8).
  Update the comment on `ClientChannel` in the schema.
- Both new tables are global (D9): add them to the list of tables without `business_id` that
  `test/schema.int-spec.ts` allows, with a one-line why.

**Check:** `npx prisma migrate dev` applies; `npm run test:int -- schema` passes; a raw insert of a card
TELEGRAM row (no `appointment_id`) succeeds and a card PUSH row still fails (add both to the schema test).
Commit `feat(client-session): tables`.

### - [x] S2: a card's Telegram reaches its bookings

**Files:** `src/notifications/dispatcher.service.ts`, `src/notifications/client-notifications.service.ts`,
`src/notifications/recipients.ts` (+ `recipients.spec.ts`), `test/notification-dispatch.int-spec.ts`.

Where both read «the booking's own rows, and the WhatsApp of its cards» (`{ kind: 'WHATSAPP', clientId:
{ in: cards } }`), read every card row instead: `{ appointmentId: null, clientId: { in: cards } }`. Update
the comments (D8). If the same chat is on the booking and on the card, the client gets one message, not
two: dedupe client recipients by `(channel, address)` in `recipients.ts` unless the deliveries' unique
key already makes it one — check, and say which in a comment.

**Check:** int test — a card TELEGRAM row gets a BOOKED event of the card's booking and of a dependent's
booking; a card row of another client gets nothing; booking + card on the same chat → one delivery.
`client-notifications` reports `telegram: true` for a card row. Commit `feat(notifications): Telegram on a client card`.

### - [x] S3: switch the client's Telegram off by the manage link

**Files:** `src/public-booking/public-booking.controller.ts`, `src/public-booking/public-booking.service.ts`,
`test/public-channels.int-spec.ts`.

`DELETE /public/bookings/:token/telegram` → 204: sets `disabled_at` on the booking's TELEGRAM rows and on
the card rows `cardsOf(booking)` reaches (as `whatsappOff` does — never deletes). 404 for an unknown
token; 204 also when nothing was on. Swagger as the other `…Off` routes.

**Check:** int test — on (booking row and card row) → off → `GET /public/bookings/:token` says
`telegram: false`, the dispatcher sends nothing to it. Commit `feat(public-booking): turn the client's Telegram off`.

### - [x] S4: start a login

**Files:** create `src/client-session/{client-session.module.ts,client-cookies.ts,client-logins.service.ts,client-session.controller.ts,client-session.schema.ts}`,
`src/app.module.ts`, create `test/client-login.int-spec.ts`.

- `client-cookies.ts`: names (`__Host-client`/`client`, `__Host-cl`/`cl` by `SESSION_COOKIE_SECURE`),
  `set`/`clear` with `res.cookie` (see `LocaleCookie` in `src/account/locale.ts`), and reading a cookie from
  `req.headers.cookie` (no cookie-parser in the app: use the `cookie` package if `npm ls cookie` shows it
  as a direct dependency of express, otherwise a small parser with a unit test).
- `POST /public/client-login` body `{ locale }` (`localeBodySchema`) → 201 `{ url }` (reuse
  `telegramLinkSchema`) and the `cl` cookie (10 min). Writes a `client_logins` row with the nonce's and the
  browser secret's hashes (`newRandomToken`/`hashRandomToken`), 10-minute expiry. 404 `channelOff` when
  Telegram is off (same check as `LinkTokensService.issue`). `@Throttle` 30 an hour per IP (was 10; raised for CGNAT, 2026-11-25).
- A second POST from the same browser replaces its earlier login (delete by the old cookie's hash).

**Check:** int test — 201, the url has `start=<43 chars>`, the cookie is `__Host-cl` HttpOnly Secure
SameSite=Lax; only hashes are in the row; Telegram off → 404 `channelOff`; a second POST leaves one row.
Commit `feat(client-session): start a login through Telegram`.

### - [x] S5: the bot confirms the phone

**Files:** `src/notifications/telegram-updates.service.ts`, `src/client-session/client-logins.service.ts`,
`src/notifications/notifications.module.ts` (import what it needs; no import cycle — the bot calls a
method of `ClientLoginsService`), `test/client-login.int-spec.ts`.

- `/start <x>`: as now, first a channel link token; if none matches, a login whose nonce hash matches,
  unexpired, unconfirmed → set `chat_id`, reply (in the login's locale) «Share your phone to confirm it»
  with `reply_markup: { keyboard: [[{ text: 'Share my phone', request_contact: true }]], one_time_keyboard:
true, resize_keyboard: true }`. Neither → the «expired» reply as now.
- A new update shape: `message.contact` with `chat.type === 'private'`. Accept only when
  `contact.user_id === from.id`; otherwise reply «Use the button to share your own phone» and confirm
  nothing. Phone: Telegram may send it without `+` — `+` and the digits, then `clientPhone` must parse it.
  Find the latest unexpired unconfirmed login with this `chat_id`; set `phone`, `confirmed_at` → reply
  «Phone confirmed, go back to the page» with `reply_markup: { remove_keyboard: true }`. No login → the
  «expired» reply.
- en / ru texts next to the existing `TEXTS`.

**Check:** int test with the spied client — start → keyboard reply; own contact → login confirmed with
`+E.164`; contact with another `user_id` → not confirmed, refusal reply; contact without `/start` first →
«expired»; expired login → «expired»; a channel link token still works (existing tests green).
Commit `feat(notifications): the bot confirms a client's phone`.

### - [x] S6: the browser takes its session

**Files:** `src/client-session/{client-logins.service.ts,client-sessions.service.ts,client-session.controller.ts,client-session.schema.ts}`,
`test/client-login.int-spec.ts`.

`GET /public/client-login` (reads the `cl` cookie) → 200 `{ status: 'pending' | 'confirmed' | 'expired' }`.
No cookie or no row / expired row → `expired`. Confirmed → in one statement-safe transaction: `DELETE … WHERE
browser_hash = … AND confirmed_at IS NOT NULL AND expires_at > now() RETURNING phone, chat_id` (the row
count decides who wins two parallel polls), insert a `client_sessions` row (30-day expiry, constant in
`client-sessions.service.ts`), set the `client` cookie, clear `cl`. `Cache-Control: no-store`.
`@SkipThrottle` is not used: the front polls every 2 s for at most 10 min — the default 100/min holds.

**Check:** full flow in the int test (S4 POST → S5 updates → GET): `confirmed` + `__Host-client` cookie;
a second GET → `expired`; the nonce through another browser (no `cl` cookie, or another `cl`) → `expired`,
no session; pending before the contact. Commit `feat(client-session): a confirmed login becomes a session`.

### - [x] S7: the session: read, sign out, guard

**Files:** `src/client-session/{client-sessions.service.ts,client-session.guard.ts,current-client.decorator.ts,client-session.controller.ts,client-session.schema.ts}`,
`src/notifications/{notifications.processor.ts,client-session-purge.service.ts}` (+ spec), `test/client-session.int-spec.ts` (new).

- `ClientSessionsService.of(req)` → `{ id, phone, chatId } | null`: by the cookie's hash, unexpired; moves
  `last_used_at` and `expires_at` forward (sliding, conditional update like `touchSession`).
- `ClientSessionGuard` (`@UseGuards` per method) puts it on the request or throws 401
  `{ code: 'clientSignIn', message: 'Confirm your phone first' }`; `@CurrentClient()` reads it. Add the
  error schema in `client-session.schema.ts` for Swagger.
- `GET /public/client-session` → 200 `{ phone: string | null }` (no guard: null without a session).
- `DELETE /public/client-session` → 204, deletes the row, clears the cookie; idempotent like sign-out.
- The notifications job also purges expired `client_logins` and `client_sessions` (next to
  `linkTokens.purgeExpired`, same best-effort handling).

**Check:** int test — a session row + cookie → phone; expired → null; the cabinet's `__Host-sid` alone →
null; sign out → null after. Guard: a unit test with a fake request (no cookie, or only `__Host-sid` →
401 `clientSignIn`; a live session → passes). No test-only route. The processor spec covers the purge. Commit
`feat(client-session): read and end a client session`.

### - [x] S8: a booking needs a confirmed phone

**Files:** `src/public-booking/{public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
`src/notifications/client-channels.ts` (a helper `ensureCardTelegram`), `test/helpers.ts`,
`test/public-booking.int-spec.ts`, `test/public-booking-limits.int-spec.ts`, any other test that POSTs a
public booking.

- `test/helpers.ts`: `clientSession(app, phone?)` → `{ cookie, phone, chatId }`, inserting a session row
  through `ClientSessionsService` (export a `create` the S6 code already uses). Switch every test that
  POSTs `/public/businesses/:slug/bookings` to it.
- `POST …/bookings`: `ClientSessionGuard`; `phone` leaves `publicBookingInput` (an extra `phone` in the
  body is stripped by zod and ignored — test it); the session's phone goes to `resolveByPhone` and the
  3-ahead limit. The result gains `phone` (the booked phone, for the done screen — D5). 401 in Swagger.
- In the booking's transaction (the `bookOnline` callback, after the client is resolved, before the
  BOOKED event so the confirmation reaches it): `ensureCardTelegram(tx, { businessId, clientId, chatId,
locale })` — `INSERT … ON CONFLICT DO NOTHING`, never re-enables a disabled row (review focus 3), no
  CHANNEL_ON event. `locale` comes from the body: add optional `locale` (default `en`) to the input.
- `GET /public/businesses/:slug` gains `clientSignIn: boolean` (Telegram on) — D7.

**Check:** int tests — no cookie → 401 `clientSignIn`; with a session → booked on the session's phone even
with another `phone` in the body; the card has a TELEGRAM row with the chat and the BOOKED event delivers to
it; a disabled card Telegram stays disabled after a new booking; limits (10/h IP for bookings, 3 ahead) still hold;
`clientSignIn` false with no token. Commit `feat(public-booking): book with a confirmed phone`.

### - [x] S9: my bookings

**Files:** `src/public-booking/{public-booking.controller.ts,public-booking.service.ts,public-booking.schema.ts}`,
create `test/my-bookings.int-spec.ts`.

`GET /public/businesses/:slug/my-bookings` (guard) → `{ bookings: [...] }`, the slug's business only,
bookings that hold time and haven't ended, of clients whose `phone` is the session's or whose guardian's
`phone` is, earliest first. Each: `id`, `clientName` (a dependent's name shows whose it is), `staffId`,
`staffName`, `startsAt`, `endsAt`, `title`, `status`, `groupId`, `oneOffSessionId`, `canChange`. Same
shape for a phone with no bookings (empty list).

**Check:** int test — own and a dependent's bookings listed; another phone's, another business's, past
and cancelled ones not; no session → 401. Commit `feat(public-booking): my bookings`.

### - [x] S10: cancel and move my booking

**Files:** `src/public-booking/{public-booking.controller.ts,public-booking.service.ts}`,
`test/my-bookings.int-spec.ts`.

`POST /public/businesses/:slug/my-bookings/:id/cancel` and `PATCH /public/businesses/:slug/my-bookings/:id`
(body `moveInput`), guarded. First find the booking by `id` + the slug's `businessId` + the session's
phone (holder or guardian) → 404 otherwise; then the same `appointments.cancelOnline` / `moveOnline` the
token routes use. Answer the S9 item. Errors and Swagger as the token routes (409 `badTransition`,
`notFree`, `full`).

**Check:** int test — cancel and move own; another phone's id → 404 and the booking unchanged; a started
booking → 409; the manage link of the same booking still works after a move. Commit
`feat(public-booking): cancel and move my booking`.

### - [x] S11: docs

**Files:** `.claude/skills/back-auth/SKILL.md`, `AGENTS.md` (one line under «Что где» for
`src/client-session/`), `docs/notifications.md` (the bot also confirms phones; nothing to set up beyond
Telegram's token), `docs/superpowers/plans/2026-11-23-e7b-client-sign-in.md` (row S → «in review»), this
file's status.

The `back-auth` skill gets a short paragraph: the client session — cookie names, 30 days sliding, stored
as a hash, opens only `/public/…` routes through `ClientSessionGuard`, never the cabinet and vice versa.

**Check:** `npm run format:check`, and the full list from AGENTS.md «Перед PR» passes. Commit
`docs(client-session): client sign-in`.

---

## Tails: the sign-in code (branch `e7b/tails-58`, from `main`)

**Why:** a forwarded `t.me/<bot>?start=<nonce>` link can talk a victim into sharing their phone, and the
attacker's browser takes the session (global, D9: it opens the victim's bookings on every business). The page
shows a short code; the bot's first message shows the same code and says «press the button only if it is
the one on your page». A victim who has no such page sees a stranger's code and has nothing to compare it
with. **Decision (the review's, 2026-11-25):** compare, not type. If it proves too weak, the stronger form is
the bot offering three codes as inline buttons and the person picking the one from the page (a callback
query) — a separate task then.

**Data shape:** `client_logins.code` — four digits, `text NOT NULL`, `CHECK (code ~ '^[0-9]{4}$')`. Not a
secret and never checked by the server: it only lets a human spot the mismatch. Random per login
(`randomInt(10000)` zero-padded).

### - [x] S12: the login has a code, the page gets it

**Files:** `prisma/schema.prisma`, new `prisma/migrations/<ts>_client_login_code/migration.sql`,
`src/client-session/client-logins.service.ts`, `src/client-session/client-session.schema.ts` (the answer
schema), `src/client-session/client-session.controller.ts`, `test/client-login.int-spec.ts`.

- Migration: `DELETE FROM client_logins` (rows live ten minutes; the code can't be invented for them), then
  `ALTER TABLE client_logins ADD COLUMN code text NOT NULL`, add the CHECK. Model: `code String`.
- `start()` writes `code` and returns `{ link, code, browserSecret }`; `POST /public/client-login` answers
  `{ url, code }` — a new schema `clientLoginStartSchema = telegramLinkSchema.extend({ code: z.string().regex(/^\d{4}$/) })`
  used in `@ApiCreatedResponse` and as the return type (the front's Orval client gets `code`).

**Check:** int test — 201 body has `code` matching `^\d{4}$` and the row stores the same code; a second
POST gives a row with its own code; a row with a bad code (`'12a4'`) is refused by the CHECK (see how
`test/schema.int-spec.ts` pins other CHECKs). Commit `feat(client-session): a sign-in has a code`.

### - [x] S13: the bot shows the code

**Files:** `src/notifications/client-login-confirm.service.ts`, `src/notifications/telegram-updates.service.ts`,
`test/client-login.int-spec.ts`.

- `begin()` returns `{ locale, code }` (the same `UPDATE … RETURNING`).
- `TEXTS.sharePhone(host, code)` en / ru, e.g. «You are signing in on {host}. Code: {code}. Press the button
  only if this is the code on your page; otherwise ignore this message». The button and keyboard stay.

**Check:** int test with the spied client — after `/start <nonce>` the reply text contains the login's
code and the host, in the login's language (en and ru); the existing S5 cases stay green. Commit
`feat(notifications): the bot shows the sign-in's code`.

### - [x] S14: docs

**Files:** `.claude/skills/back-auth/SKILL.md`, `docs/notifications.md` (only if it describes the bot's
sign-in text), this file (tick S12–S14, status).

One sentence in `back-auth`: the sign-in's `code` is shown on the page and in the bot, never verified by the
server — it is a prompt for a human.

**Check:** `npm run format:check`, the full list from AGENTS.md «Перед PR». Commit `docs(client-session): the sign-in code`.

### Front (other repo, after S12): F1 — show the code

Not part of this branch. After S12 merges the front regenerates its API client (`code` in the
`POST /public/client-login` answer) and, next to the «Open Telegram» button, shows «Code: 4821 — the bot
will ask you to compare it». Check: Storybook / the sign-in page shows the code; the text is in en and ru.
