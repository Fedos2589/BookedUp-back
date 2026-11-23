# E7 online booking — common plan (back, kit, front)

**Goal (epic E7):** a client opens `/book/<slug>` on a phone, picks a master (or «any free master»)
and a free time, leaves a name and a phone, and is booked — in no more than four screens, without
calling the admin. They can cancel or move the booking themselves. The page doesn't load the cabinet's
code, and a slot can't be taken twice.

This file holds what the repos share: the goal, the order, the decisions and the review focus that
crosses repos. **Tasks live in each repo's own plan** — an executor opens only that one.

## Two steps

- **E7a — booking without a code (this plan).** Name + phone, limits instead of a code, a private
  link to cancel or move the booking.
- **E7b — sign-in by a one-time code through Telegram or WhatsApp (later, its own plan).** With a
  confirmed phone: the account's people (book a child), «my bookings» without the link. Split after
  E7a is merged; which channel first depends on the first market (open question in the epics doc).

## Steps of E7a and where their tasks are

| Step | Repo           | Branch                | Plan                                                                         | Status                                            |
| ---- | -------------- | --------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| P    | BookedUp-back  | `e7/public-booking`   | `docs/superpowers/plans/2026-11-18-e7-online-booking-back.md` (next to this) | done — PRs #38, #39                               |
| K6   | ted-ui         | `feature/slot-picker` | task text in the front plan's «Before G1»                                    | done — ted-ui PR #21, v0.8.0 (front is on v0.8.1) |
| G    | BookedUp-front | `e7/public-booking`   | `~/work/BookedUp-front/docs/plans/2026-11-18-e7-online-booking-front.md`     | not started                                       |

**Order:** back → front; K6 runs in parallel with the back and is needed from G3. Each step is one
branch and one PR, reviewed by Opus before the next. The last task of each step's plan updates its
row here.

**Keeping plans in step:** a decision that changes what another repo does goes here first, then into
the affected repo's plan (the front plan's «What the back gives» restates the back's contract).

## Decisions

Made by the user (2026-11-18, don't re-ask):

- **Two steps:** E7a without a code, with limits; the code through Telegram / WhatsApp is E7b.
- **PWA on both:** the cabinet and the public page can each be installed to the home screen.
- **Groups:** a client books a seat in a group meeting or a one-off session the same way the cabinet
  does (capacity, «free N of M», a full meeting is shown but can't be booked).
- **«Any free master»** is offered next to the list of masters.

Made while planning — the user checks them in this plan's PR:

1. **Public API** lives under `/public/businesses/:slug/…` and `/public/bookings/:token`: no
   `businessId` in the URL and no session. The service turns the slug into the business's id once and
   every query below filters by that id (AGENTS.md rule 1 holds; the guard just has nothing to check).
   Unknown slug → 404.
2. **Who the booking is for, without a code:** a known phone → the booking goes on that account's
   holder; the typed name becomes the booking's `clientName` snapshot, the card's name is never
   changed (as in E8). A new phone → a new holder with the typed name. A dependent can't be picked
   on the public page: without a code it would show anyone who's on someone else's number. That
   comes with E7b.
3. **Cancel and move by a private link:** an online booking gets a random token (only its hash is
   stored, as invitations do); the link `APP_URL/book/<slug>/manage/<token>` is shown on the success
   screen with «save this link». Cancel and move are allowed until the booking starts. Until E9 sends
   it by message, that screen is the only place the link appears — accepted for E7a.
4. **Limits instead of a code:** 10 online bookings per hour per IP; at most 3 live future bookings
   per phone per business (`409 tooManyBookings`). Both are constants in the back for now.
5. **«Any free master»** is for hours slots only. The same time offered by several masters is shown
   once; the back picks among the masters free at that time the one with the fewest live bookings that
   day (then by name), and tries the next one if that slot was just taken. A group meeting is always
   one master's — it's picked as a meeting (title, master), «any» or not.
6. **One slot request for the page:** the front asks the public slots for all masters for 14 days at
   once and uses it for both screens: masters with no free time in 14 days are shown dimmed, «any»
   merges the hours slots.
7. **PWA:** each business gets its own web manifest from the back
   (`/public/businesses/:slug/manifest.webmanifest`: the business's name, `start_url` and `scope` =
   `/book/<slug>`), so a client's installed icon opens that business, not the cabinet's sign-in. The
   service worker stays one for the whole app and keeps precaching everything; G1 measures what the
   cabinet adds, and if it's heavy, precaching only the public chunks is a follow-up.
8. **Online booking is on for every business**; a switch in settings comes if a pilot asks. The
   cabinet shows online bookings like any other; telling the master about them is E9.

9. **A phone is not confirmed until E7b (decided in the review of #39, 2026-11-23).** Whoever knows a
   regular's phone can book on their card and use up the 3 bookings of that phone; `tooManyBookings`
   then shows the phone has 3 bookings to come. Accepted until the code (OTP) arrives. The 10 an hour
   per IP counts failed attempts too; softer limits later if a pilot hits it.

## Out of E7a

The code and the account's people (E7b), notifications and reminders (E9), prepayment (E10), a cut-off
before the start for cancelling (a business setting, later), a switch to turn online booking off, a
mark «booked online» on a booking.

## Review focus across repos

1. A slot can't be taken twice: two parallel public bookings for the last seat or the same hours slot
   give one 201 and one 409 — through the same lock and constraint as the cabinet.
2. Nothing of one business is reachable through another's slug or a token: slots, masters, a booking
   by token, a move into another business's slot.
3. The public answers leak no client data: no names, phones or notes of other bookings, only counts.
4. A known phone doesn't reveal its account: the answer to a public booking is the same whether the
   phone was known or not.
5. The public page's first load doesn't fetch the cabinet's chunks (checked on the build).
6. A token link works only for its own booking and stops changing it once the booking has started or
   was cancelled.
