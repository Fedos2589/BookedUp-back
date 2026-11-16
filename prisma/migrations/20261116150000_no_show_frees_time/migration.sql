-- What holds a master's time: every booking but a cancelled one and an hours booking whose client
-- didn't come (the master may take someone else then; the status stays NO_SHOW for history). A
-- seat a client missed still holds its place: the meeting happened. The same rule is
-- `holdsTime` in src/schedule/live-bookings.ts, which the free slots are counted by.
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_no_overlap";
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_no_overlap"
  EXCLUDE USING gist (
    "staff_id" WITH =,
    tstzrange("starts_at", "ends_at") WITH &&,
    (COALESCE("group_id", "one_off_session_id", "id")) WITH <>
  )
  WHERE (
    "status" <> 'CANCELLED'
    AND NOT ("status" = 'NO_SHOW' AND "group_id" IS NULL AND "one_off_session_id" IS NULL)
  );
