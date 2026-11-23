-- CreateEnum
CREATE TYPE "ChannelKind" AS ENUM ('EMAIL', 'TELEGRAM', 'WHATSAPP', 'PUSH', 'LOG');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('BOOKED', 'MOVED', 'CANCELLED', 'REMINDER', 'CHANNEL_ON');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "reminder_offsets" INTEGER[] NOT NULL DEFAULT ARRAY[1440]::INTEGER[];

-- AlterTable
ALTER TABLE "memberships" ADD COLUMN     "notify_all_online" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "notify_email" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "user_channels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "user_id" UUID NOT NULL,
    "kind" "ChannelKind" NOT NULL,
    "address" TEXT NOT NULL,
    "keys" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_channels" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "appointment_id" UUID,
    "kind" "ChannelKind" NOT NULL,
    "address" TEXT NOT NULL,
    "keys" JSONB,
    "locale" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "actor_user_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "offset_minutes" INTEGER,
    "channel_id" UUID,
    "payload" JSONB,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "channel" "ChannelKind" NOT NULL,
    "address" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_channels_user_id_kind_address_key" ON "user_channels"("user_id", "kind", "address");

-- CreateIndex
CREATE INDEX "client_channels_business_id_client_id_idx" ON "client_channels"("business_id", "client_id");

-- CreateIndex
CREATE INDEX "client_channels_business_id_appointment_id_idx" ON "client_channels"("business_id", "appointment_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_channels_business_id_id_key" ON "client_channels"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_events_business_id_id_key" ON "notification_events"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_event_id_channel_address_key" ON "notification_deliveries"("event_id", "channel", "address");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_business_id_id_key" ON "appointments"("business_id", "id");

-- AddForeignKey
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_business_id_client_id_fkey" FOREIGN KEY ("business_id", "client_id") REFERENCES "clients"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_business_id_appointment_id_fkey" FOREIGN KEY ("business_id", "appointment_id") REFERENCES "appointments"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_business_id_appointment_id_fkey" FOREIGN KEY ("business_id", "appointment_id") REFERENCES "appointments"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_business_id_channel_id_fkey" FOREIGN KEY ("business_id", "channel_id") REFERENCES "client_channels"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_business_id_event_id_fkey" FOREIGN KEY ("business_id", "event_id") REFERENCES "notification_events"("business_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;


-- What Prisma can't express (E9 plan, N1).

-- Reminder times: 0 to 3 of a fixed list (decision 9).
ALTER TABLE "businesses" ADD CONSTRAINT "businesses_reminder_offsets"
  CHECK ("reminder_offsets" <@ ARRAY[60, 120, 180, 1440, 2880] AND cardinality("reminder_offsets") <= 3);

-- A member's channels: email is users.email, so only these three are stored; one Telegram and one
-- WhatsApp per account, push is one row per device.
ALTER TABLE "user_channels" ADD CONSTRAINT "user_channels_kind"
  CHECK ("kind" IN ('TELEGRAM', 'WHATSAPP', 'PUSH'));
CREATE UNIQUE INDEX "user_channels_telegram" ON "user_channels"("user_id") WHERE "kind" = 'TELEGRAM';
CREATE UNIQUE INDEX "user_channels_whatsapp" ON "user_channels"("user_id") WHERE "kind" = 'WHATSAPP';

-- A client's channels: WhatsApp sits on the card (no booking), the rest on the booking (decision 4).
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_kind"
  CHECK ("kind" IN ('TELEGRAM', 'WHATSAPP', 'PUSH', 'EMAIL'));
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_whatsapp_on_card"
  CHECK (("kind" = 'WHATSAPP') = ("appointment_id" IS NULL));
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_locale"
  CHECK ("locale" IN ('en', 'ru'));
ALTER TABLE "client_channels" ADD CONSTRAINT "client_channels_address_length"
  CHECK (char_length("address") BETWEEN 1 AND 2048);
CREATE UNIQUE INDEX "client_channels_address_key"
  ON "client_channels"("business_id", "client_id", "kind", "address", "appointment_id") NULLS NOT DISTINCT;

-- Events: an offset belongs to a reminder, a channel to CHANNEL_ON; a reminder is written once per
-- booking, offset and start (decision 2) — a moved booking has a new start, so a new key.
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_offset"
  CHECK (("offset_minutes" IS NOT NULL) = ("kind" = 'REMINDER'));
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_channel"
  CHECK (("channel_id" IS NOT NULL) = ("kind" = 'CHANNEL_ON'));
CREATE UNIQUE INDEX "notification_events_reminder_once"
  ON "notification_events"("appointment_id", "offset_minutes", "starts_at") WHERE "kind" = 'REMINDER';
CREATE INDEX "notification_events_unprocessed" ON "notification_events"("processed_at") WHERE "processed_at" IS NULL;

-- Deliveries.
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_audience"
  CHECK ("audience" IN ('client', 'staff'));
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_locale"
  CHECK ("locale" IN ('en', 'ru'));
CREATE INDEX "notification_deliveries_due" ON "notification_deliveries"("status") WHERE "status" IN ('PENDING', 'FAILED');
