-- CreateTable
CREATE TABLE "clients" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "business_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "guardian_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "clients_business_id_guardian_id_idx" ON "clients"("business_id", "guardian_id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_business_id_id_key" ON "clients"("business_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "clients_business_id_phone_key" ON "clients"("business_id", "phone");

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_business_id_guardian_id_fkey" FOREIGN KEY ("business_id", "guardian_id") REFERENCES "clients"("business_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- A person has their own phone or a guardian, exactly one of the two.
ALTER TABLE "clients"
  ADD CONSTRAINT "clients_phone_or_guardian" CHECK (("phone" IS NULL) <> ("guardian_id" IS NULL));

-- The same rule as appointments_client_phone.
ALTER TABLE "clients"
  ADD CONSTRAINT "clients_phone" CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');
