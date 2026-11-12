-- This is an empty migration.-- A NULL list passed groups_weekdays (cardinality(NULL) is NULL, and a CHECK lets NULL through).
-- In the CHECK, not a column NOT NULL: Prisma doesn't model NOT NULL on a list and would see drift.
ALTER TABLE "groups"
  DROP CONSTRAINT "groups_weekdays",
  ADD CONSTRAINT "groups_weekdays" CHECK (
    "weekdays" IS NOT NULL
    AND cardinality("weekdays") BETWEEN 1 AND 7
    AND "weekdays" <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]
  );
