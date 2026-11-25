# E11 BookedUp subscription — common plan (back, front)

**Goal (epic E11):** an owner picks a plan and pays BookedUp by card after the trial. An expired
subscription stops _new_ bookings but never hides the ones already made.

**Tasks are not split yet.** The next session splits back and front into small tasks once the payment
provider is confirmed (see «Open questions for Paddle»).

## Decisions (2026-11-25, the user's, don't re-ask)

- **Money in the product is only BookedUp's own subscription.** Clients and businesses settle payments
  between themselves. So **E10 (client prepayment) is cancelled**: no Connect-style platform, no refunds to
  clients, no unpaid-booking timeout, no online cash register (54-FZ). E12 (reports) and E15 (groups) no longer
  depend on E10; reports have no revenue.
- **The seller is the user's Georgian individual entrepreneur (IE).** Stripe has no standard accounts for a
  business in Georgia (checked 2026-11-25 through third-party sources, not stripe.com — re-check
  <https://stripe.com/global> before relying on it). Stripe Atlas (a US LLC) is a separate company with its
  own taxes and bank — a fallback, not the plan.
- **Provider kind: Merchant of Record (MoR)** — it sells the subscription, charges and pays VAT and sales
  taxes of the buyer's country, and pays the rest out to us. Candidate: **Paddle**. Behind a
  `PaymentProvider` interface (like `Channel` in notifications) so the provider can be replaced.

## Providers checked (2026-11-25, blogs, not official lists)

| Provider            | Georgia                                                    | Verdict                                                                                                                       |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Paddle              | not on its unsupported-sellers list; a Georgian company can be a seller | **Candidate.** IE (not a company) unconfirmed. Pays monthly; a $100 payout threshold is a third-party figure, unverified |
| Lemon Squeezy       | no bank payouts to Georgia, only PayPal                    | **Out:** shuts down, stops processing payments on 2027-03-31                                                                  |
| Polar               | not listed (payouts through Stripe Connect Express)        | Out                                                                                                                           |
| Creem, Dodo Payments | listed as supporting Georgia in one comparison table      | Fallbacks, **not checked**                                                                                                    |

Other fallbacks: a local acquirer for Georgian cards — [Flitt](https://flitt.com/card-payments/) (needs an
active TBC account; Visa, Mastercard, Apple Pay, Google Pay) or
[TBC e-commerce](https://developers.tbcbank.ge/page/e-commerce); Bank of Georgia iPay was not covered by the
search. Whether they take an IE, and whether they do **recurring** charges, is unknown. PayPal Business (Georgia
features depend on account verification).

## Open questions for Paddle (ask support, or read the seller terms)

1. Does Paddle onboard an **individual entrepreneur** in Georgia, or only a registered company?
2. How does it pay out — SWIFT, Wise, Payoneer, a Georgian bank? What is the payout threshold and schedule?
3. Fees (percent + fixed) and payout fees.
4. What it needs before verification: a website, terms of service / offer, privacy policy, a refund policy,
   which documents of the IE?
5. Subscriptions: trial period, plan change, proration, cancellation, failed-payment retries (dunning), and
   webhooks (signature, retries, ordering) — what the back must handle.

If the IE is refused: a Georgian LLC, or Atlas, or Creem / Dodo (check them the same way).

## Payment methods a provider should cover

- **Cards:** Visa, Mastercard, Amex — every provider has them.
- **Wallets:** Apple Pay, Google Pay (best conversion on a phone), PayPal (stronger in the West).
- **Local:** Georgia — Georgian bank cards, TBC instalments; Russia and CIS — SBP, MIR, YooKassa, CloudPayments;
  Thailand — PromptPay (QR), LINE Pay; Europe — SEPA, iDEAL, Klarna.
- A MoR such as Paddle usually brings cards, Apple Pay, Google Pay and PayPal; local methods depend on the buyer's
  country. Which market is first (open question in the epics doc) decides whether a local method is needed.

## What the epic still includes

`Plan`, `Subscription`, a trial period, plan limits (for example the number of masters), the provider's webhooks
(idempotent: a webhook that arrives twice makes one change), and «an expired subscription stops new
bookings but does not hide existing ones». `businessId` on every row, as everywhere.

## Sources

- <https://payrequest.io/guides/accept-international-payments-georgia-without-stripe>
- <https://docs.stripe.com/tax/supported-countries/asia-pacific/georgia>
- <https://register-company.ge/blog/payment-processors-georgian-company/>
- <https://dev.to/panchei/lemon-squeezy-is-shutting-down-what-should-you-switch-to-by-country-and-by-what-you-sell-3egb>
- <https://x.com/polar_sh/status/1915379610809782428>
- <https://flitt.com/card-payments/>, <https://developers.tbcbank.ge/page/e-commerce>
