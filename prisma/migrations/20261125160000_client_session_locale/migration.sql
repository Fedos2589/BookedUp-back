-- The language of the sign-in travels into the session: it is the language of the client's Telegram
-- messages (the card's chat is written with it at the first booking). Sessions that exist now were
-- opened without one; `en` stands for them and is not a default for new rows.
ALTER TABLE "client_sessions" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "client_sessions" ALTER COLUMN "locale" DROP DEFAULT;
ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_locale" CHECK ("locale" IN ('en', 'ru'));
