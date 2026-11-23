# E9 notifications and reminders — common plan (back, front)

**Goal (epic E9):** a client gets a confirmation and a reminder of their booking, and a master learns
about new, moved and cancelled bookings — each in the channels they pick themselves from the same four:
Telegram, WhatsApp, push (the page or the cabinet installed as an app, or a browser that supports it)
and email. Several picked → the message goes to each. Moving a booking moves its reminder, cancelling it drops the reminder, and a restart
of the worker never sends a reminder twice.

This file holds what the repos share: the goal, the order, the decisions and the review focus that
crosses repos. **Tasks live in each repo's own plan** — an executor opens only that one.

## Steps and where their tasks are

| Step | Repo           | Branch             | Plan                                                                    | Status      |
| ---- | -------------- | ------------------ | ----------------------------------------------------------------------- | ----------- |
| N    | BookedUp-back  | `e9/notifications` | `docs/superpowers/plans/2026-11-23-e9-notifications-back.md`, N1–N10    | not started |
| M    | BookedUp-back  | `e9/channels`      | same file, M1–M9                                                        | not started |
| F    | BookedUp-front | `e9/notifications` | `~/work/BookedUp-front/docs/plans/2026-11-23-e9-notifications-front.md` | not started |

**Order:** N → M → F. N is the engine: events, reminders and settings, with a log channel only
(every message goes to the log), so it can be reviewed without any outside account. M adds the
real channels and the linking routes. F starts once M is merged **and** E7's front G4–G5 (done
screen, manage page) are merged, because F puts its block on those two screens. No kit step: the
kit already has `Checkbox`, `RadioGroup`, `Button`, `SuccessScreen`. Each step is one branch and
one PR, reviewed by Opus before the next. The last task of each step updates its row here.

**Keeping plans in step:** a decision that changes what another repo does goes here first, then into
the affected repo's plan (the front plan's «What the back gives» restates the back's contract).

## Decisions

Made by the user (2026-11-23, don't re-ask):

- **Everyone picks their channels, from the same four:** Telegram, WhatsApp, push, email — the client
  on the booking's done screen and manage page, a member of the staff in the cabinet. Several picked →
  the message goes to each.
- **Who among the staff:** the booking's master, about their own bookings, except changes they made
  themselves. The owner and admins get every **online** booking, move and cancel of the business
  (switchable per person).
- **Settings hold only the reminder times;** texts are fixed (en / ru), no template editor.

Made while planning — the user checks them in this plan's PR:

1. **Outbox, not delayed jobs.** A booking's change writes a row in `notification_events` inside the
   same transaction as the change: no change without its event, no event for a change that rolled
   back. A repeatable BullMQ job (every 30 s) sends what is due. Nothing has to find and remove a
   job when a booking moves or is cancelled.
2. **Reminders are computed, not stored ahead.** The same repeatable job finds `BOOKED` bookings whose
   `startsAt − offset` has come (within the last 15 minutes, so a short outage still sends them), and
   records one `REMINDER` event per `(booking, offset, startsAt)` — a unique key. A moved booking has a
   new `startsAt`, so a new key and a new reminder; a cancelled one is not `BOOKED` and gets none. A
   reminder whose time came before the booking was made is skipped (booked an hour ahead → no «tomorrow»
   reminder). A change of the business's reminder times applies to bookings already made.
3. **Never twice, at the price of maybe never.** Each message is a row in `notification_deliveries`,
   unique per `(event, channel, address)`, claimed (`SENDING`) in its own transaction before the call to
   the outside service and marked `SENT` / `FAILED` after it. A restart finds the claim and doesn't send
   again; a crash between the claim and the call loses that one message. A channel that answers «not
   reachable» (Telegram 403 blocked, push 404/410) is removed; other errors are retried up to 3 times by
   the next runs.
4. **Where a client's channel is attached, until the phone is confirmed (E7b).**
   - **WhatsApp** is attached to the client card (the phone): a message to the phone reaches whoever
     owns it, so it is safe for every booking of that client, the cabinet's too. Opt-in comes from the
     manage link; someone who typed another person's phone can send that phone one opt-in message per
     booking — under E7a's limits, accepted until E7b.
   - **Telegram, push and email** are attached to **the booking** whose manage link turned them on
     (the client types the email there; there's no email on a booking): whoever holds that link already
     sees the booking, and nothing more. They don't serve the client's other
     bookings — a stranger who booked on a regular's phone would otherwise read the regular's
     bookings. With E7b (confirmed phone) they move to the client card.
   - A dependent's booking (E8) goes to the guardian's channels.
5. **The manage link goes only into the first message after a channel is turned on** (the back keeps
   only its hash, so it is passed in by the request that turns the channel on, kept in that event's
   payload and wiped once the event is sent). Reminders carry no link.
6. **Staff channels belong to the account**, for every business it is in: email to the account's
   address, on by default (`users.notify_email`); Telegram after «Connect Telegram» (a deep link to the
   bot); WhatsApp to a phone the member types in the cabinet (not confirmed — it's their own opt-in);
   push for each device where they turned it on in the cabinet. Only `notifyAllOnline` (owner / admin)
   is per business, on the membership. No reminders for staff.
7. **Language and time:** the client's — the browser language the page sends when the channel is turned
   on (Telegram's `language_code` for Telegram), `en` or `ru`, else `en`; staff — `User.locale`. Every
   time in a message is on the business's clock (`Business.timeZone`).
8. **A channel without its keys in env is off.** In development and tests every channel falls back to
   the log channel; in production a missing key just hides that channel (`GET /public/businesses/:slug`
   and the cabinet's `GET …/me/notifications` say which are on), the app still starts.
9. **Reminder times:** 0 to 3 offsets from a fixed list — 1 h, 2 h, 3 h, 24 h, 48 h; default `[24 h]`;
   empty = no reminders. Owner and admin change them.
10. **Telegram updates:** a webhook in production (`/telegram/webhook`, secret header); long polling in
    development when the webhook secret isn't set, so a laptop without a public URL can link a chat.
11. **WhatsApp needs approved templates** in Meta: one per message kind and language. Their names are
    env variables; their texts are ours from the back's message texts, so they match the other
    channels. Submitting them is a manual step for production (M8 writes the list).

## Out of E9

SMS; LINE (with the first market's decision); confirming a typed email or a staff member's WhatsApp
phone by a code; a template editor; reminders and digests for staff; marketing messages; quiet hours.

## Open questions

- **First market** (epics doc) — decides whether LINE joins the channels and whether WhatsApp is worth
  its per-message price; E9 keeps a channel a small class behind one interface, so adding one is a task.

## Review focus across repos

1. A booking's change and its event are one transaction: a 409 leaves no event, a 201 always has one.
2. A reminder is sent once per channel across two parallel runs of the job and across a restart.
3. A moved booking is reminded at its new time only; a cancelled one not at all.
4. A Telegram chat, push subscription or email turned on from one booking's link never gets another
   booking of that phone; nothing of business A reaches a channel of business B; a member's channels
   get only the businesses they are a member of.
5. A master doesn't get a message about a change they made, and never about another master's booking.
6. Missing env keys don't stop the app and don't leak a channel the front then offers.
