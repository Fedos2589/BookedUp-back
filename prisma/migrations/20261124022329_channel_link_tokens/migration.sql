-- CreateTable
CREATE TABLE "channel_link_tokens" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token_hash" TEXT NOT NULL,
    "business_id" UUID,
    "appointment_id" UUID,
    "user_id" UUID,
    "locale" TEXT NOT NULL,
    "manage_link" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "channel_link_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "channel_link_tokens_token_hash_key" ON "channel_link_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "channel_link_tokens_expires_at_idx" ON "channel_link_tokens"("expires_at");

-- AddForeignKey
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_business_id_appointment_id_fkey" FOREIGN KEY ("business_id", "appointment_id") REFERENCES "appointments"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A token is for an account or for a booking, never both and never neither; a booking token carries its
-- business (the composite key), an account token does not. The language is one the front has texts for.
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_one_owner"
  CHECK (("user_id" IS NULL) <> ("appointment_id" IS NULL));
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_business_with_booking"
  CHECK (("business_id" IS NULL) = ("appointment_id" IS NULL));
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_manage_link_with_booking"
  CHECK (("manage_link" IS NULL) OR ("appointment_id" IS NOT NULL));
ALTER TABLE "channel_link_tokens" ADD CONSTRAINT "channel_link_tokens_locale"
  CHECK ("locale" IN ('en', 'ru'));
