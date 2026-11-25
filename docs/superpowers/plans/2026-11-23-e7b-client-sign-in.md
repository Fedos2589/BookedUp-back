# E7b client sign-in by phone, through Telegram — common plan (back, front)

**Goal (epic E7b):** a client who has chosen a master (or a group) and a time on `/book/<slug>` is asked,
at the last step, to confirm their phone through Telegram. Once it is confirmed, they are booked, and for
as long as the browser's cookie lives they can see and change their bookings without typing the phone
or opening a link again. A phone nobody has confirmed can no longer be booked online.

This file holds what the repos share: the goal, the order, the decisions and the review focus that
crosses repos. **Tasks live in each repo's own plan** — an executor opens only that one. It continues E7a's decision 9
(`2026-11-18-e7-online-booking.md`: «a phone is not confirmed until E7b»).

## Steps and where their tasks are

| Step | Repo           | Branch               | Plan                                                                             | Status      |
| ---- | -------------- | -------------------- | -------------------------------------------------------------------------------- | ----------- |
| S    | BookedUp-back  | `e7b/client-sign-in` | `docs/superpowers/plans/2026-11-25-e7b-client-sign-in-back.md`, S1–S11           | not started |
| T    | BookedUp-front | `e7b/client-sign-in` | `~/work/BookedUp-front/docs/plans/2026-11-25-e7b-client-sign-in-front.md`, T1–T8 | not started |

**Order:** E9's step M (the Telegram bot and its linking routes) → S → T. S uses M's bot; T starts once
S is merged **and** E7a's front (G1–G7, the booking page and the manage page) is merged. No kit step
needed: the waiting screen and the list are built from existing kit parts (confirmed while splitting). Each step is one branch and one PR, reviewed by Opus before the next. The last
task of each step updates its row here.

**Keeping plans in step:** a decision that changes what another repo does goes here first, then into
the affected repo's plan.

## Decisions

Made by the user (2026-11-23, don't re-ask):

- **Telegram first**, because it is the only free channel. WhatsApp and SMS codes come later, if a
  pilot needs them (E7b's first cut does not include them).
- **When:** at the end of the booking, after the master or group, the time and the contacts — not at
  the start of the page.
- **While the cookie lives, the client has access** to booking and to their bookings: no second
  confirmation until it ends.

Proposed while planning — the user checks them in this plan's PR:

1. **Confirmation by the bot, no typed code.** The front asks the back for a one-time login and gets a
   Telegram deep link (`t.me/<bot>?start=<nonce>`). The bot answers the `/start` with a button «Share my
   phone» (`request_contact`). The back accepts the phone only if the contact's `user_id` is the
   sender's own `from.id` (a forwarded contact of someone else is refused), marks the login confirmed
   and keeps the phone in E.164. The front waits (poll, or refetch when the page becomes visible again,
   as E9 does) and, once confirmed, the back sets the cookie. The nonce is single-use, short-lived
   (~10 min) and bound to the browser that asked for it.
2. **A client session, not an account.** A cookie (`httpOnly`, `SameSite=Lax`, `Secure` in production)
   whose random value is stored only as a hash in a table of its own (`client_sessions`: phone,
   hash, expiry, last use), **separate from the cabinet's session** (`/me`): a client is never a user,
   and neither cookie opens the other's routes. Lifetime is a constant (start with 30 days, sliding);
   «sign out» removes the row. Cookie gone or expired → the same confirmation again.
3. **The session's phone is the booking's phone.** With a session the contacts step shows the confirmed
   phone read-only (name and note stay editable); the back ignores any phone in the body and uses the
   session's. Without a session `POST /public/businesses/:slug/bookings` answers 401 and the front
   starts the confirmation. E7a's limits stay (10 an hour per IP, 3 live future bookings per phone).
4. **«My bookings».** With a session the back lists the phone's bookings to come at this business
   (`GET /public/businesses/:slug/my-bookings`: time, master, title, status, and what the client may do),
   and cancel and move work by booking id through the session as well as by the private link. The
   private link keeps working exactly as in E7a, with or without a session, and is still the way to
   share or save one booking. The saved-booking link in `localStorage` (E7a G4a) is replaced by this
   list; the front keeps no copy of bookings.
5. **A typed phone that differs from the confirmed one.** The client confirmed through a Telegram
   account whose phone is not the one typed on the contacts step: the confirmed phone wins and the
   form says so («Booked on +7 … — the phone of your Telegram»); nobody is booked on a number they
   did not confirm.
6. **The client's Telegram is linked at the same moment.** The confirmation gives the back the
   client's Telegram chat, so E9's Telegram channel for that phone is on without a second link; E9's
   decision 4 («channels of a booking move to the client card once the phone is confirmed») is what
   this enables. Whether the client can turn it off, and how it is shown in the E9 block, is settled
   when splitting.

## Settled while splitting (2026-11-25)

- **D7 (user): nobody without Telegram books online** until a second channel exists. Without a client
  session the booking route answers 401; on a server without Telegram the business says
  `clientSignIn: false` and the page tells the client to call. No unconfirmed fallback.
- **D8 (user): the confirmed chat is the client's Telegram on their card** at the business (like WhatsApp),
  so every booking of the phone there, and of their dependents, gets the messages; switched off from the
  E9 block (a new `DELETE /public/bookings/:token/telegram`). This answers decision 6's open part.
- **D9 (proposed, check in S's PR): the login and the session are global**, by phone, not by business — one
  confirmation works on every business's page; every query by the session is filtered by the slug's business.
- **D5 simplified (proposed, check in T's PR):** the page no longer asks for a phone at all — it comes from
  Telegram, and the done screen says which phone was booked. Nothing to override, nothing to explain.
- **Dependents** stay out of the first cut, as proposed (bookings of a holder's dependents are listed in
  «My bookings» since they are on the holder's phone, but nobody books a dependent online yet).
- **Bot for development and manual tests:** the one E9's M step set up (`docs/notifications.md`: in
  development the API polls the bot itself). No extra setup.

## Out of this epic

WhatsApp and SMS codes, dependents, a client-facing «sign out everywhere», prepayment (E10), a switch
to make confirmation optional per business.

## Review focus across repos

1. A phone is accepted only from the contact the sender shares **about themself** (`contact.user_id ===
from.id`); a forwarded or typed phone confirms nothing.
2. The nonce is single-use, expires, and cannot be used by another browser than the one that asked.
3. The client cookie opens only the client routes and only the phone's own bookings; the cabinet's
   cookie opens none of them. Nothing leaks across businesses or phones (cf. E7a's review focus 2–4):
   `my-bookings` answers the same shape for a phone with no bookings.
4. The booking's phone can only be the session's: a body that carries another phone books nothing.
5. The private link works as before, with and without a session, and still stops once the booking has
   started or was cancelled.
6. Cookie lifetime, sign-out and the 401 → confirmation flow are tested; nothing is stored in the
   front's `localStorage`.
7. The public page's first load still doesn't fetch the cabinet's chunks (checked on the build).
