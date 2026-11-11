-- CreateTable
CREATE TABLE "weekly_windows" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_minute" SMALLINT NOT NULL,
    "duration_minutes" SMALLINT NOT NULL,
    "slot_minutes" SMALLINT NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "weekly_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_off_windows" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "slot_minutes" SMALLINT NOT NULL,
    "title" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_off_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_offs" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "time_offs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_windows_business_id_staff_id_idx" ON "weekly_windows"("business_id", "staff_id");

-- CreateIndex
CREATE INDEX "one_off_windows_business_id_staff_id_starts_at_idx" ON "one_off_windows"("business_id", "staff_id", "starts_at");

-- CreateIndex
CREATE INDEX "time_offs_business_id_staff_id_starts_at_idx" ON "time_offs"("business_id", "staff_id", "starts_at");

-- AddForeignKey
ALTER TABLE "weekly_windows" ADD CONSTRAINT "weekly_windows_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_windows" ADD CONSTRAINT "weekly_windows_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_off_windows" ADD CONSTRAINT "one_off_windows_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_off_windows" ADD CONSTRAINT "one_off_windows_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_offs" ADD CONSTRAINT "time_offs_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_offs" ADD CONSTRAINT "time_offs_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What Prisma doesn't express. The API refuses all of these with a 400 first; these are the floor.

ALTER TABLE "weekly_windows"
  ADD CONSTRAINT "weekly_windows_weekday" CHECK ("weekday" BETWEEN 1 AND 7),
  ADD CONSTRAINT "weekly_windows_start" CHECK ("start_minute" BETWEEN 0 AND 1439),
  ADD CONSTRAINT "weekly_windows_duration" CHECK ("duration_minutes" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "weekly_windows_slot" CHECK ("slot_minutes" BETWEEN 5 AND "duration_minutes");

ALTER TABLE "one_off_windows"
  ADD CONSTRAINT "one_off_windows_slot" CHECK (
    "slot_minutes" >= 5 AND "starts_at" + make_interval(mins => "slot_minutes") <= "ends_at"
  );

ALTER TABLE "time_offs"
  ADD CONSTRAINT "time_offs_range" CHECK ("starts_at" < "ends_at");

-- Two one-off windows of one master never overlap. btree_gist lets the GiST index hold the uuid
-- next to the range; bookings (E6) need it too.
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE "one_off_windows"
  ADD CONSTRAINT "one_off_windows_no_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&);
