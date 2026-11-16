-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('BOOKED', 'CONFIRMED', 'DONE', 'NO_SHOW', 'CANCELLED');

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'BOOKED',
    "client_name" TEXT NOT NULL,
    "client_phone" TEXT NOT NULL,
    "note" TEXT,
    "group_id" UUID,
    "one_off_session_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointments_business_id_starts_at_idx" ON "appointments"("business_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_business_id_group_id_starts_at_idx" ON "appointments"("business_id", "group_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_business_id_one_off_session_id_idx" ON "appointments"("business_id", "one_off_session_id");

-- CreateIndex
CREATE INDEX "appointments_business_id_staff_id_starts_at_idx" ON "appointments"("business_id", "staff_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "groups_business_id_staff_id_id_key" ON "groups"("business_id", "staff_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "one_off_sessions_business_id_id_key" ON "one_off_sessions"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "one_off_sessions_business_id_staff_id_id_key" ON "one_off_sessions"("business_id", "staff_id", "id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_staff_id_group_id_fkey" FOREIGN KEY ("business_id", "staff_id", "group_id") REFERENCES "groups"("business_id", "staff_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_staff_id_one_off_session_id_fkey" FOREIGN KEY ("business_id", "staff_id", "one_off_session_id") REFERENCES "one_off_sessions"("business_id", "staff_id", "id") ON DELETE NO ACTION ON UPDATE CASCADE;


ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_span" CHECK (
    "starts_at" < "ends_at" AND "ends_at" - "starts_at" <= INTERVAL '1 day'
  ),
  ADD CONSTRAINT "appointments_one_parent" CHECK ("group_id" IS NULL OR "one_off_session_id" IS NULL),
  ADD CONSTRAINT "appointments_client_name" CHECK (length(btrim("client_name")) > 0),
  ADD CONSTRAINT "appointments_client_phone" CHECK ("client_phone" ~ '^\+[1-9][0-9]{6,14}$');

-- A master is never in two places at once: active bookings of one master don't overlap, except
-- seats of one meeting, which share its time. The third column is what a booking belongs to: its
-- group, its one-off session, or itself (an hours booking), and two rows conflict when they
-- overlap and belong to different things. Cancelled bookings free their time. How many seats a
-- meeting holds is counted against capacity by src/appointments.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "staff_id" WITH =,
    tstzrange("starts_at", "ends_at") WITH &&,
    (COALESCE("group_id", "one_off_session_id", "id")) WITH <>
  )
  WHERE ("status" <> 'CANCELLED');
