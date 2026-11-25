-- CreateTable
CREATE TABLE "client_logins" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "nonce_hash" TEXT NOT NULL,
    "browser_hash" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "chat_id" TEXT,
    "phone" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_logins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token_hash" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_logins_nonce_hash_key" ON "client_logins"("nonce_hash");

-- CreateIndex
CREATE UNIQUE INDEX "client_logins_browser_hash_key" ON "client_logins"("browser_hash");

-- CreateIndex
CREATE INDEX "client_logins_expires_at_idx" ON "client_logins"("expires_at");

-- CreateIndex
CREATE INDEX "client_logins_chat_id_idx" ON "client_logins"("chat_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_sessions_token_hash_key" ON "client_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "client_sessions_expires_at_idx" ON "client_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "client_sessions_phone_idx" ON "client_sessions"("phone");

-- A login is for a phone in E.164 and a language the front has texts for; a confirmed one has both the
-- phone and the chat it came from (the session is made from them).
ALTER TABLE "client_logins" ADD CONSTRAINT "client_logins_phone" CHECK ("phone" ~ '^\+[1-9]\d{6,14}$');
ALTER TABLE "client_logins" ADD CONSTRAINT "client_logins_locale" CHECK ("locale" IN ('en', 'ru'));
ALTER TABLE "client_logins" ADD CONSTRAINT "client_logins_confirmed_complete"
  CHECK ("confirmed_at" IS NULL OR ("phone" IS NOT NULL AND "chat_id" IS NOT NULL));
ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_phone" CHECK ("phone" ~ '^\+[1-9]\d{6,14}$');

-- Where a client's channel sits (E7b, D8): WhatsApp always on the card, push and email always on a
-- booking, Telegram on either. Named so it is checked after `client_channels_kind` (alphabetical order).
ALTER TABLE "client_channels" DROP CONSTRAINT "client_channels_whatsapp_on_card";
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_placement"
  CHECK (
    ("kind" = 'WHATSAPP' AND "appointment_id" IS NULL)
    OR "kind" = 'TELEGRAM'
    OR ("kind" IN ('PUSH', 'EMAIL') AND "appointment_id" IS NOT NULL)
  );
