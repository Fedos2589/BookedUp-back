-- One override per master and date, now keyed with business_id too: the upsert that writes it
-- filters by the business like every other query (review #14). The unique index replaces the
-- plain one on the same columns.

-- DropIndex
DROP INDEX "day_overrides_business_id_staff_id_date_idx";

-- DropIndex
DROP INDEX "day_overrides_staff_id_date_key";

-- CreateIndex
CREATE UNIQUE INDEX "day_overrides_business_id_staff_id_date_key" ON "day_overrides"("business_id", "staff_id", "date");
