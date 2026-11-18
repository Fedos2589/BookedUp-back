-- Every existing booking gets a client: one holder per (business, phone), named after the latest
-- booking with that phone. The same phone in two businesses is two clients.
ALTER TABLE "appointments" ADD COLUMN "client_id" UUID;

INSERT INTO "clients" ("business_id", "name", "phone")
SELECT DISTINCT ON ("business_id", "client_phone") "business_id", "client_name", "client_phone"
FROM "appointments"
ORDER BY "business_id", "client_phone", "starts_at" DESC;

UPDATE "appointments" a SET "client_id" = c."id"
FROM "clients" c
WHERE c."business_id" = a."business_id" AND c."phone" = a."client_phone";

ALTER TABLE "appointments" ALTER COLUMN "client_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "appointments_business_id_client_id_starts_at_idx" ON "appointments"("business_id", "client_id", "starts_at");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_business_id_client_id_fkey" FOREIGN KEY ("business_id", "client_id") REFERENCES "clients"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
