-- AlterTable
ALTER TABLE "client_channels" ADD COLUMN "opted_out_at" TIMESTAMPTZ(3);

-- «The client said no» is a kind of switched off: it needs disabled_at, so no reader of disabled_at misses it.
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_opted_out_is_off"
  CHECK ("opted_out_at" IS NULL OR "disabled_at" IS NOT NULL);
