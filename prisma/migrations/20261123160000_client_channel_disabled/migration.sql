-- A client channel is switched off with a mark, not deleted: its CHANNEL_ON event and their deliveries
-- hang on the row (ON DELETE CASCADE), and a delivery may be in flight (review of #44, question 8).
ALTER TABLE "client_channels" ADD COLUMN "disabled_at" TIMESTAMPTZ(3);
