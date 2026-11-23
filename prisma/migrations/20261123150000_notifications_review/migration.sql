-- Review of E9 N1–N2.

-- The same address can be both the client and a member of the staff (the owner booking themselves):
-- two messages, two texts, one address.
DROP INDEX "notification_deliveries_event_id_channel_address_key";
CREATE UNIQUE INDEX "notification_deliveries_event_id_channel_address_audience_key"
  ON "notification_deliveries"("event_id", "channel", "address", "audience");

-- The same length bounds as client_channels.address: a longer value would be a 500 from the index.
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_address_length"
  CHECK (char_length("address") BETWEEN 1 AND 2048);
