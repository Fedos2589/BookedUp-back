/*
  Warnings:

  - You are about to drop the `one_off_windows` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ScheduleMode" AS ENUM ('HOURS', 'GROUPS');

-- DropForeignKey
ALTER TABLE "one_off_windows" DROP CONSTRAINT "one_off_windows_business_id_fkey";

-- DropForeignKey
ALTER TABLE "one_off_windows" DROP CONSTRAINT "one_off_windows_business_id_staff_id_fkey";

-- AlterTable
ALTER TABLE "staff" ADD COLUMN     "schedule_mode" "ScheduleMode" NOT NULL DEFAULT 'HOURS';

-- DropTable
DROP TABLE "one_off_windows";

-- CreateTable
CREATE TABLE "day_overrides" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "windows" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "day_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "weekdays" SMALLINT[],
    "start_minute" SMALLINT NOT NULL,
    "duration_minutes" SMALLINT NOT NULL,
    "capacity" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_cancellations" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_cancellations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_off_sessions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "staff_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "capacity" SMALLINT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_off_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "day_overrides_business_id_staff_id_date_idx" ON "day_overrides"("business_id", "staff_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "day_overrides_staff_id_date_key" ON "day_overrides"("staff_id", "date");

-- CreateIndex
CREATE INDEX "groups_business_id_staff_id_idx" ON "groups"("business_id", "staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_business_id_id_key" ON "groups"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "group_cancellations_group_id_date_key" ON "group_cancellations"("group_id", "date");

-- CreateIndex
CREATE INDEX "one_off_sessions_business_id_staff_id_starts_at_idx" ON "one_off_sessions"("business_id", "staff_id", "starts_at");

-- AddForeignKey
ALTER TABLE "day_overrides" ADD CONSTRAINT "day_overrides_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "day_overrides" ADD CONSTRAINT "day_overrides_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_cancellations" ADD CONSTRAINT "group_cancellations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_cancellations" ADD CONSTRAINT "group_cancellations_business_id_group_id_fkey" FOREIGN KEY ("business_id", "group_id") REFERENCES "groups"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_off_sessions" ADD CONSTRAINT "one_off_sessions_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_off_sessions" ADD CONSTRAINT "one_off_sessions_business_id_staff_id_fkey" FOREIGN KEY ("business_id", "staff_id") REFERENCES "staff"("business_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What Prisma doesn't express. The API refuses all of these with a 400 first; these are the floor.

ALTER TABLE "groups"
  ADD CONSTRAINT "groups_weekdays" CHECK (
    cardinality("weekdays") BETWEEN 1 AND 7 AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
  ),
  ADD CONSTRAINT "groups_start" CHECK ("start_minute" BETWEEN 0 AND 1439),
  ADD CONSTRAINT "groups_duration" CHECK ("duration_minutes" BETWEEN 1 AND 1440),
  ADD CONSTRAINT "groups_capacity" CHECK ("capacity" BETWEEN 1 AND 1000);

ALTER TABLE "one_off_sessions"
  ADD CONSTRAINT "one_off_sessions_range" CHECK (
    "starts_at" < "ends_at" AND "ends_at" - "starts_at" <= INTERVAL '1 day'
  ),
  ADD CONSTRAINT "one_off_sessions_capacity" CHECK ("capacity" BETWEEN 1 AND 1000);

-- Two one-off sessions of one master never overlap (btree_gist is on since the schedule migration).
ALTER TABLE "one_off_sessions"
  ADD CONSTRAINT "one_off_sessions_no_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&);
