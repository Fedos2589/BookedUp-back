// `unreachable`: the address will never work (the chat was left, the push subscription expired), so the
// caller switches it off. `unknown`: the call got no answer in time, so the message may be out; it is not sent
// again (a message twice is worse than one lost), and the address stays on. A retryable error is thrown instead.
export type SendResult = 'sent' | 'unreachable' | 'unknown';
