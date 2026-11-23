-- The hash of the token in an online booking's private link (E7). NULL for a booking made in the
-- cabinet; unique, so a token finds one booking.
ALTER TABLE "appointments" ADD COLUMN "manage_token_hash" TEXT;
CREATE UNIQUE INDEX "appointments_manage_token_hash_key" ON "appointments"("manage_token_hash");
