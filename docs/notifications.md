# Notification channels

How to turn each channel on. Every channel is off until its keys are set (in development its messages go to the
log); `GET /public/businesses/:slug` and `GET /me/notifications` tell the front which are on. All keys are in
`.env.example`.

## Telegram

1. In Telegram open `@BotFather`, `/newbot`, copy the token and the bot's username.
2. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` (they go together).
3. Production: set `TELEGRAM_WEBHOOK_SECRET` (any random string, required there) and tell Telegram where to call:

   ```bash
   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<API>/telegram/webhook&secret_token=<SECRET>"
   ```

   Telegram sends the secret back in the `X-Telegram-Bot-Api-Secret-Token` header; without it the route answers 401.

4. Development: with the token set, no secret and `NODE_ENV=development` the API polls the bot itself — no webhook.

## Web Push

1. `npx web-push generate-vapid-keys`.
2. Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (`mailto:you@example.com` or an https URL) — all
   three or none. The front gets the public key as `pushKey`.

## Email (Resend)

1. In Resend add and verify the sending domain (the DNS records Resend shows: SPF, DKIM).
2. Set `RESEND_API_KEY` and `MAIL_FROM` (`BookedUp <no-reply@your-domain>`) — together. In production an unset
   pair is not replaced by the log: the channel is simply off.

## WhatsApp (Cloud API)

1. In Meta Business create an app with WhatsApp, add a sending number and a permanent access token.
2. Set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` — together.
3. WhatsApp sends approved templates only, to clients only. Submit each template below in Meta's WhatsApp Manager
   (category Utility), with the same name and language, and the body as written; `{{n}}` are its parameters.
   The table is printed from `src/notifications/messages.ts`, so run it again after changing a message:

   ```bash
   npm run whatsapp:templates
   ```

| Name                         | Language | Body                                                                                              | Parameters |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------- | ---------- |
| `bookedup_booked_client`     | en       | You're booked: {{1}}, with {{2}}, {{3}}                                                           | 3          |
| `bookedup_booked_client`     | ru       | Вы записаны: {{1}}, у {{2}}, {{3}}                                                                | 3          |
| `bookedup_moved_client`      | en       | Your booking is moved to: {{1}}, with {{2}}, {{3}}                                                | 3          |
| `bookedup_moved_client`      | ru       | Запись перенесена: {{1}}, у {{2}}, {{3}}                                                          | 3          |
| `bookedup_cancelled_client`  | en       | Your booking is cancelled: {{1}}, with {{2}}, {{3}}                                               | 3          |
| `bookedup_cancelled_client`  | ru       | Запись отменена: {{1}}, у {{2}}, {{3}}                                                            | 3          |
| `bookedup_reminder_client`   | en       | {{1}}: {{2}}, with {{3}}, {{4}}                                                                   | 4          |
| `bookedup_reminder_client`   | ru       | {{1}}: {{2}}, у {{3}}, {{4}}                                                                      | 4          |
| `bookedup_channel_on_client` | en       | You're booked: {{1}}, with {{2}}, {{3}} ⏎ Manage your booking: {{4}} ⏎ You'll get reminders here. | 4          |
| `bookedup_channel_on_client` | ru       | Вы записаны: {{1}}, у {{2}}, {{3}} ⏎ Управление записью: {{4}} ⏎ Сюда же придут напоминания.      | 4          |
