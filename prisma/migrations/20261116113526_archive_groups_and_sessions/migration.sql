-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "one_off_sessions" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- An archived session no longer holds its time: the one-at-a-time rule is for the live ones.
ALTER TABLE "one_off_sessions" DROP CONSTRAINT "one_off_sessions_no_overlap";
ALTER TABLE "one_off_sessions"
  ADD CONSTRAINT "one_off_sessions_no_overlap"
  EXCLUDE USING gist ("staff_id" WITH =, tstzrange("starts_at", "ends_at") WITH &&)
  WHERE ("archived_at" IS NULL);
